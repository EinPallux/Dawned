/**
 * The authoritative world.
 *
 * P4 tick order (docs/tech/ARCHITECTURE.md §3): player movement + history →
 * ability pipeline + projectiles → enemy AI (10 Hz staggered) + enemy motion →
 * spawner tickets/corpses → player vitals (regen, death) — the gateway then
 * snapshots. Every combat mutation happens here; packets only queue requests.
 */

import {
  ActionId,
  AbilityRejectReason,
  DAWNED_DURATION_MS,
  EntityEventKind,
  EntityFlag,
  HitFlag,
  EntityKind,
  OOC_AFTER_MS,
  OOC_HP_REGEN_PER_S,
  SPRINT_STAMINA_PER_SEC,
  TICK_DT,
  WORLD_BOUNDS,
  XpSource,
  devTerrain,
  discoveryXp,
  pointInPolygon,
  stepMovement,
  xpToNext,
  type Appearance,
  type AttributeSpread,
  type ClassId,
  type Zone,
  BASIC_COMBOS,
  EVASIVE_DODGE_DISCOUNT,
  EVASIVE_ENERGY_PER_S,
  EVASIVE_MOVE_SPEED_PCT,
  FOCUS_MOVE_SPEED_MULT,
  InputButton,
  TICK_MS,
  gainResource,
  interruptCast,
  payResource,
  slotForAction,
  tickResource,
  type EnemyDef,
  type MovementStepResult,
  type Rng,
  type RosterEntry,
  type SnapshotEntity,
  type SpawnerDef,
  type TerrainSampler,
  type EquipSlot,
  type ItemOp,
  type ItemStack,
} from '@dawned/shared';
import { ServerPlayer } from './player.js';
import { ServerEnemy } from './enemy.js';
import type { GameContent } from '../content/loader.js';
import {
  advancePlayerContact,
  applyCcToPlayer,
  applyDamageToEnemy,
  cancelComboOnDodge,
  handleAttackRequest,
  stepProjectiles,
  type CombatEvent,
  type ServerProjectile,
} from './combat.js';
import { handleSlotRequest, tickPlayerAbilities, tickZones, type GroundZone } from './abilities.js';
import {
  applyEffect,
  dodgeCostDeltaOf,
  moveSpeedMultOf,
  tickEffects,
  type PeriodicTick,
} from './effects.js';
import {
  allocateSkill,
  allocateStats,
  awardKillXp,
  awardXp,
  createPlayerProgress,
  effectiveDefOf,
  rebuildNodeFolds,
  respec,
  setLevel,
  type ProgressionContent,
  rebuildPlayerDerived,
  killTaggers,
} from './progression.js';
import { CORPSE_LINGER_MS, decide, enterCombat, move, type AiContext } from './enemy-ai.js';
import {
  applyItemOp,
  createPlayerItems,
  expireLootBags,
  grantGold,
  grantItem,
  refreshEquipmentBonus,
  rollEnemyLoot,
  sweepVendorLeases,
  type ItemContent,
  type LootBag,
} from './items.js';

/** AOI radii (docs/tech/NETWORKING.md §5): 3×3 of 64 m cells ≈ 96 m, +8 m leave margin. */
const AOI_ENTER_SQ = 96 * 96;
const AOI_LEAVE_SQ = 104 * 104;
const AOI_ENTITY_CAP = 80;
/** Respawn ticket jitter (NPCS_ENEMIES.md §3): ±20%. */
const RESPAWN_JITTER = 0.2;
/** No face-spawns: a pop pauses while a player stands this close (§3). */
const SPAWN_CLEAR_RADIUS = 8;
/** A paused pop retries this often. */
const SPAWN_RETRY_MS = 5000;

export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface RespawnTicket {
  spawner: SpawnerDef;
  enemyDef: EnemyDef;
  level: number;
  atMs: number;
}

export class World {
  private readonly players = new Map<number, ServerPlayer>();
  readonly enemies = new Map<number, ServerEnemy>();
  private readonly projectiles: ServerProjectile[] = [];
  /** Live ground zones (P6 Sanctuary) — ticked in step, culled on expiry. */
  private readonly zones: GroundZone[] = [];
  private readonly tickets: RespawnTicket[] = [];
  private readonly campIndex = new Map<string, ServerEnemy[]>();
  private nextEntityId = 1;
  private nextProjectileId = 1;
  /** Reused per tick for effect periodic collection (zero-alloc steady state). */
  private readonly periodicScratch: PeriodicTick[] = [];
  private tickCounter = 0;

  constructor(
    private readonly terrain: TerrainSampler = devTerrain,
    private readonly spawn: SpawnPoint = { x: 0, y: 0, z: 0, yaw: 0 },
    private content: GameContent | null = null,
    private readonly rng: Rng = Math.random,
    /** Zone polygons (P7 zone-entry XP; baked zones.json, empty in tests). */
    private readonly zonePolys: readonly Zone[] = [],
  ) {
    if (content) this.populateFromSpawners();
  }

  /** The progression slice of content the P7 systems consume. */
  progressionContent(): ProgressionContent {
    // Content is loaded before the world exists in production; the empty
    // fallback keeps tests without content honest (no curve = no level-ups).
    return {
      xpCurve: this.content?.xpCurve ?? [],
      skillNodes: this.content?.skillNodes ?? new Map(),
      abilities: this.content?.abilities ?? new Map(),
      xpRate: this.content?.worldSettings.xpRate ?? 1,
    };
  }

  /** Published item/loot/vendor rows (empty maps until P8 content lands). */
  itemContent(): ItemContent {
    return {
      items: this.content?.items ?? new Map(),
      lootTables: this.content?.lootTables ?? new Map(),
      vendors: this.content?.vendors ?? new Map(),
    };
  }

  /** Live loot bags by id — the gateway reads them to build LootBags. */
  readonly lootBags = new Map<number, LootBag>();
  private nextLootBagId = 1;

  get playerCount(): number {
    return this.players.size;
  }

  get entityCount(): number {
    return this.players.size + this.enemies.size;
  }

  allPlayers(): IterableIterator<ServerPlayer> {
    return this.players.values();
  }

  get(id: number): ServerPlayer | undefined {
    return this.players.get(id);
  }

  /** The entity currently playing this character, if any (one world, no dupes). */
  findByCharacter(characterId: number): ServerPlayer | undefined {
    for (const player of this.players.values()) {
      if (player.characterId === characterId) return player;
    }
    return undefined;
  }

  /** Any entity belonging to this account (single-session-per-account rule). */
  findByAccount(accountId: number): ServerPlayer | undefined {
    for (const player of this.players.values()) {
      if (player.accountId === accountId) return player;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Enemies + spawners
  // -------------------------------------------------------------------------

  private populateFromSpawners(): void {
    if (!this.content) return;
    for (const spawner of this.content.spawners) {
      for (const entry of spawner.entries) {
        const def = this.content.enemies.get(entry.enemyId);
        if (!def) continue; // loader validated; belt and suspenders
        for (let i = 0; i < entry.count; i++) {
          this.spawnEnemy(spawner, def, this.rollLevel(def, entry.level));
        }
      }
    }
  }

  private rollLevel(def: EnemyDef, fixed: number | null): number {
    if (fixed !== null) return fixed;
    const span = def.levelMax - def.levelMin;
    return def.levelMin + Math.floor(this.rng() * (span + 1));
  }

  /** Pick a walkable point inside the spawner's radius (8 tries, then center). */
  private spawnPosition(spawner: SpawnerDef): { x: number; z: number } {
    for (let attempt = 0; attempt < 8; attempt++) {
      const angle = this.rng() * Math.PI * 2;
      const r = spawner.kind === 'point' ? 0 : Math.sqrt(this.rng()) * spawner.radius;
      const x = spawner.x + Math.cos(angle) * r;
      const z = spawner.z + Math.sin(angle) * r;
      if (!this.terrain.walkableAt || this.terrain.walkableAt(x, z)) return { x, z };
    }
    return { x: spawner.x, z: spawner.z };
  }

  private spawnEnemy(spawner: SpawnerDef, def: EnemyDef, level: number): ServerEnemy {
    const { x, z } = this.spawnPosition(spawner);
    const enemy = new ServerEnemy(
      this.nextEntityId++,
      def,
      level,
      spawner.id,
      spawner.campTag ?? def.socialTag,
      x,
      this.terrain.heightAt(x, z),
      z,
    );
    enemy.yaw = this.rng() * Math.PI * 2;
    this.enemies.set(enemy.id, enemy);
    if (enemy.campTag) {
      const camp = this.campIndex.get(enemy.campTag) ?? [];
      // Ring slot = position in the camp at spawn, fixed for this life. A slot
      // recomputed per decision would make a swarm's circle rotate every time
      // a member died (P9, NPCS_ENEMIES.md §1 surround behavior).
      enemy.surroundSlot = camp.length;
      camp.push(enemy);
      this.campIndex.set(enemy.campTag, camp);
    }
    return enemy;
  }

  private removeEnemy(enemy: ServerEnemy): void {
    this.enemies.delete(enemy.id);
    if (enemy.campTag) {
      const camp = this.campIndex.get(enemy.campTag);
      if (camp) {
        const index = camp.indexOf(enemy);
        if (index >= 0) camp.splice(index, 1);
      }
    }
    for (const player of this.players.values()) player.visible.delete(enemy.id);
  }

  // -------------------------------------------------------------------------
  // Players
  // -------------------------------------------------------------------------

  /** Spawn ring around the map's spawn point so players don't stack on login. */
  private playerSpawnPoint(): SpawnPoint {
    const angle = (this.nextEntityId * 2.399963) % (Math.PI * 2); // golden-angle spread
    const radius = 4 + (this.nextEntityId % 5) * 2.5;
    const x = this.spawn.x + Math.cos(angle) * radius;
    const z = this.spawn.z + Math.sin(angle) * radius;
    // The ring may brush an unwalkable cell — fall back to the exact point.
    if (this.terrain.walkableAt && !this.terrain.walkableAt(x, z)) {
      return { ...this.spawn, y: this.terrain.heightAt(this.spawn.x, this.spawn.z) };
    }
    return { x, y: this.terrain.heightAt(x, z), z, yaw: this.spawn.yaw };
  }

  /** A persisted position is only trusted if it's still inside the walkable world. */
  private isValidPersisted(position: { x: number; z: number }): boolean {
    if (Math.abs(position.x) > WORLD_BOUNDS || Math.abs(position.z) > WORLD_BOUNDS) return false;
    return this.terrain.walkableAt ? this.terrain.walkableAt(position.x, position.z) : true;
  }

  addPlayer(spec: {
    characterId: number;
    accountId: number;
    name: string;
    classId: ClassId;
    level: number;
    appearance: Appearance;
    /** Persisted position; null = first spawn (server picks the ring). */
    position: { x: number; y: number; z: number; yaw: number } | null;
    /** Persisted HP; null/undefined = spawn at full. */
    hp?: number | null;
    /** Account role (P7: gates /setlevel). Default player. */
    role?: 'player' | 'gm' | 'admin';
    /** Persisted progression (P7). Defaults = a fresh level-1 character. */
    progression?: {
      xp: number;
      gold: number;
      allocated: AttributeSpread;
      unspentStatPoints: number;
      unspentSkillPoints: number;
      nodeRanks: Map<string, number>;
      zonesSeen: Set<string>;
    };
    /** Persisted bag + paper-doll (P8); absent = an empty pack. */
    inventory?: {
      bag: Map<number, ItemStack>;
      equipment: Map<EquipSlot, ItemStack>;
    };
  }): ServerPlayer {
    const id = this.nextEntityId++;
    // A stale persisted position (map changed underneath it — e.g. the P1 flat
    // world became the P2 island) relocates to spawn instead of stranding the
    // character in deep water or inside a cliff.
    const persisted = spec.position && this.isValidPersisted(spec.position) ? spec.position : null;
    const spawn = persisted ?? this.playerSpawnPoint();
    // Re-ground a persisted position: the terrain may have changed since the
    // last save (map edits), and standing inside a hill helps nobody.
    const groundY = this.terrain.heightAt(spawn.x, spawn.z);
    const y = persisted ? Math.max(spawn.y, groundY) : groundY;

    const progress = createPlayerProgress(
      spec.progression ?? {
        xp: 0,
        gold: 25,
        allocated: { str: 0, agi: 0, int: 0, vit: 0, end: 0 },
        unspentStatPoints: 0,
        unspentSkillPoints: 0,
        nodeRanks: new Map(),
        zonesSeen: new Set(),
      },
    );
    const items = createPlayerItems(progress.gold, spec.inventory);
    const player = new ServerPlayer(
      id,
      spec.characterId,
      spec.accountId,
      spec.name,
      spec.classId,
      spec.level,
      spec.appearance,
      spec.role ?? 'player',
      progress,
      items,
      spawn.x,
      y,
      spawn.z,
      spawn.yaw,
      spec.hp ?? null,
    );
    // Worn gear contributes to the very same fold, so price it first.
    refreshEquipmentBonus(player.items, this.itemContent().items);
    // Fold the allocated tree into stats/pools/defs (never refills — the
    // persisted HP survives the login). Re-apply the persisted HP after the
    // fold: node HP% raises the cap, and the constructor clamped against the
    // BASE max before the fold could widen it.
    rebuildNodeFolds(player, this.progressionContent());
    if (spec.hp !== null && spec.hp !== undefined) {
      player.hp = Math.min(Math.max(spec.hp, 1), player.maxHp);
    }
    this.players.set(id, player);
    return player;
  }

  removePlayer(id: number): void {
    this.players.delete(id);
    // Nobody keeps interest in a despawned entity (ids are never reused, but
    // the visibility sets should not grow without bound).
    for (const player of this.players.values()) player.visible.delete(id);
    // Enemy threat tables must not chase a ghost.
    for (const enemy of this.enemies.values()) enemy.threat.delete(id);
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  /** Advance the world one tick. Returns combat events for the gateway. */
  /**
   * Hot-swap published content between ticks (admin publish → /ops/reload).
   * Ability defs and slot bindings apply to every FUTURE use immediately;
   * live enemies keep their def object until leash-reset or respawn (new
   * spawns read the new defs). Spawner layout changes need a restart —
   * the caller reports that honestly (docs/tech/ARCHITECTURE.md content cache).
   */
  applyContent(next: GameContent): { abilities: number; enemies: number; spawners: number } {
    this.content = next;
    // Re-fold every online character: node aggregates reference content defs
    // (abilities for effective defs, node rows for effects) that just changed.
    const progression = this.progressionContent();
    const items = this.itemContent().items;
    for (const player of this.players.values()) {
      rebuildNodeFolds(player, progression);
      // Worn gear caches its contribution; a re-published item row (or a
      // retuned stat block) has to land on characters already wearing it.
      refreshEquipmentBonus(player.items, items);
      rebuildPlayerDerived(player, false);
    }
    return {
      abilities: next.abilities.size,
      enemies: next.enemies.size,
      spawners: next.spawners.length,
    };
  }

  /** Gateway-queued progression requests (P7): applied at the next tick so
   * their events ride the normal flush, never a half-tick state. */
  private readonly pendingProgress: (
    | { kind: 'stats'; playerId: number; deltas: AttributeSpread }
    | { kind: 'skill'; playerId: number; nodeId: string }
    | { kind: 'respec'; playerId: number; wireKind: number }
    | { kind: 'setlevel'; playerId: number; level: number }
  )[] = [];

  /** Item intents (P8) ride the tick like progression clicks do. */
  private readonly pendingItemOps: { playerId: number; op: ItemOp }[] = [];

  queueItemOp(playerId: number, op: ItemOp): void {
    // Bounded: a spamming client fills its own queue, not the server's heap.
    if (this.pendingItemOps.length > 512) return;
    this.pendingItemOps.push({ playerId, op });
  }

  queueAllocateStats(playerId: number, deltas: AttributeSpread): void {
    this.pendingProgress.push({ kind: 'stats', playerId, deltas });
  }

  queueAllocateSkill(playerId: number, nodeId: string): void {
    this.pendingProgress.push({ kind: 'skill', playerId, nodeId });
  }

  queueRespec(playerId: number, wireKind: number): void {
    this.pendingProgress.push({ kind: 'respec', playerId, wireKind });
  }

  queueSetLevel(playerId: number, level: number): void {
    this.pendingProgress.push({ kind: 'setlevel', playerId, level });
  }

  /** /ops/setlevel resolves by character name (admin panel path). */
  queueSetLevelByName(name: string, level: number): boolean {
    for (const player of this.players.values()) {
      if (player.name.toLowerCase() === name.toLowerCase()) {
        this.queueSetLevel(player.id, level);
        return true;
      }
    }
    return false;
  }

  /** Ops-queued CC pokes (/ops/cc — GM primitive + P6 smoke). Applied at the
   * next tick so they ride the normal event flush, never a half-tick state. */
  private readonly pendingCc: {
    playerId: number;
    category: 'stun' | 'root';
    durationMs: number;
  }[] = [];

  queueCc(name: string, category: 'stun' | 'root', durationMs: number): boolean {
    for (const player of this.players.values()) {
      if (player.name.toLowerCase() === name.toLowerCase()) {
        this.pendingCc.push({ playerId: player.id, category, durationMs });
        return true;
      }
    }
    return false;
  }

  /** Ops-queued HP set (/ops/hurt — GM primitive; deterministic heal tests
   * until P9 enemies hurt players on demand). Marks combat so OOC regen
   * does not immediately erase the wound. Never kills. */
  private readonly pendingHurt: { playerId: number; fraction: number }[] = [];

  queueHurt(name: string, fraction: number): boolean {
    for (const player of this.players.values()) {
      if (player.name.toLowerCase() === name.toLowerCase()) {
        this.pendingHurt.push({ playerId: player.id, fraction });
        return true;
      }
    }
    return false;
  }

  /**
   * Ops-queued item/gold grants (/ops/grant — the GM primitive behind the
   * panel's future "grant item" button, and how the P8 smoke stages fixtures
   * that no loot table has to cooperate for). Runs the same planner a pickup
   * does, so a full bag refuses exactly like a full bag.
   */
  private readonly pendingGrants: (
    | { playerId: number; kind: 'item'; itemId: string; qty: number }
    | { playerId: number; kind: 'gold'; amount: number }
  )[] = [];

  queueGrant(name: string, itemId: string, qty: number): boolean {
    return this.queueForName(name, (id) =>
      this.pendingGrants.push({ playerId: id, kind: 'item', itemId, qty }),
    );
  }

  queueGrantGold(name: string, amount: number): boolean {
    return this.queueForName(name, (id) =>
      this.pendingGrants.push({ playerId: id, kind: 'gold', amount }),
    );
  }

  private queueForName(name: string, queue: (playerId: number) => void): boolean {
    for (const player of this.players.values()) {
      if (player.name.toLowerCase() === name.toLowerCase()) {
        queue(player.id);
        return true;
      }
    }
    return false;
  }

  /** True when the id exists in published content — /ops/grant checks first. */
  hasItem(itemId: string): boolean {
    return this.itemContent().items.has(itemId);
  }

  step(): CombatEvent[] {
    const events: CombatEvent[] = [];
    const nowMs = Date.now();
    this.tickCounter++;

    // 0. External CC (the P9 enemy-cast entry point, driven by ops until then).
    for (const cc of this.pendingCc.splice(0)) {
      const ccTarget = this.players.get(cc.playerId);
      if (ccTarget && !ccTarget.dead) {
        applyCcToPlayer(ccTarget, cc.category, cc.durationMs, nowMs, events);
      }
    }
    // 0b. Progression requests (P7): allocation clicks, respec, setlevel.
    // Validation runs the shared rules; refusals still emit progress-dirty so
    // the requester re-syncs (an honest client never predicted otherwise).
    for (const request of this.pendingProgress.splice(0)) {
      const requester = this.players.get(request.playerId);
      if (!requester) continue;
      const progression = this.progressionContent();
      if (request.kind === 'stats') {
        allocateStats(requester, request.deltas, events);
      } else if (request.kind === 'skill') {
        allocateSkill(requester, request.nodeId, progression, events);
      } else if (request.kind === 'respec') {
        respec(requester, request.wireKind, progression, events);
      } else {
        setLevel(requester, request.level, progression, events);
      }
    }
    // 0c. Item requests (P8): drags, equips, loot, vendor trades. Each runs
    // the shared planner; a refusal still resyncs the requester. Equipment
    // changes re-fold derived stats so the next damage roll uses the new gear.
    if (this.pendingItemOps.length > 0 || this.pendingGrants.length > 0) {
      const itemDeps = {
        content: this.itemContent(),
        bags: this.lootBags,
        nowMs,
        events,
      };
      for (const grant of this.pendingGrants.splice(0)) {
        const receiver = this.players.get(grant.playerId);
        if (!receiver) continue;
        if (grant.kind === 'gold') {
          grantGold(receiver, grant.amount, itemDeps);
        } else {
          grantItem(receiver, grant.itemId, grant.qty, itemDeps);
        }
      }
      for (const request of this.pendingItemOps.splice(0)) {
        const requester = this.players.get(request.playerId);
        if (!requester) continue;
        const result = applyItemOp(requester, request.op, itemDeps);
        if (result.equipmentChanged) {
          refreshEquipmentBonus(requester.items, itemDeps.content.items);
          rebuildPlayerDerived(requester, false);
          events.push({ type: 'equipment-changed', playerId: requester.id });
        }
      }
    }

    // Bags rot after 60 s (§3); whoever could see one re-syncs.
    for (const playerId of expireLootBags(this.lootBags, nowMs)) {
      events.push({ type: 'loot-dirty', playerId });
    }
    // A vendor conversation ends when you walk away from the post (§6).
    sweepVendorLeases(this.players.values(), this.itemContent().vendors, events);

    for (const hurt of this.pendingHurt.splice(0)) {
      const target = this.players.get(hurt.playerId);
      if (target && !target.dead) {
        target.hp = Math.max(1, Math.round(target.maxHp * hurt.fraction));
        target.lastCombatAtMs = nowMs;
      }
    }

    const aiCtx: AiContext = {
      players: this.players,
      terrain: this.terrain,
      nowMs,
      dt: TICK_DT,
      rng: this.rng,
      events,
      enemiesByCamp: (tag) => this.campIndex.get(tag) ?? [],
      projectiles: this.projectiles,
      nextProjectileId: () => this.nextProjectileId++,
      // Living pack-mates decide how wide a swarm's surround ring is. Counting
      // the LIVING ones matters: as a pack is cut down the survivors close in
      // rather than orbiting the gaps where their friends used to be.
      packSize: (enemy) =>
        enemy.campTag === null
          ? 1
          : (this.campIndex.get(enemy.campTag) ?? []).filter((mate) => mate.alive).length,
    };

    // 1. Player movement — re-simulated from client intents with the shared step.
    for (const player of this.players.values()) {
      const intents = player.takeInputsForTick();
      for (const intent of intents) {
        // Death locks controls: the body stays put until respawn (§10).
        if (player.dead) {
          player.movement.vx = 0;
          player.movement.vz = 0;
          continue;
        }
        // RMB stances (P5/P6, CLASSES.md): shield up for Warrior/Cleric with
        // the perfect-block window stamped on the raise EDGE; Evasive for
        // Rogues (speed + dodge discount, 3 Energy/s while held and
        // affordable); Focus for Mages (slow-strafe, faster bolts).
        const secondaryHeld = (intent.buttons & InputButton.SecondaryAction) !== 0;
        const blockClass = player.classId === 'warrior' || player.classId === 'cleric';
        if (blockClass) {
          if (secondaryHeld && !player.blocking) player.blockRaisedAtMs = nowMs;
          player.blocking = secondaryHeld;
        } else {
          player.blocking = false;
        }
        const evasive = secondaryHeld && player.classId === 'rogue' && player.resource.value >= 1;
        if (evasive) payResource(player.resource, EVASIVE_ENERGY_PER_S * TICK_DT);
        player.focusing = secondaryHeld && player.classId === 'mage';
        const whirlMult = player.pendingAbility?.def.anim.moveSpeedMult ?? 1;
        // A fractional castWhileMoving is the walk-speed multiplier while its
        // cast/channel runs (schema contract) — the client folds the same def.
        const activeCastId =
          player.abilityMachine.cast?.abilityId ?? player.abilityMachine.channel?.abilityId ?? null;
        const castMoveRaw =
          activeCastId === null || this.content === null
            ? true
            : effectiveDefOf(player, activeCastId, this.content.abilities)?.castWhileMoving;
        const castMult = typeof castMoveRaw === 'number' ? castMoveRaw : 1;
        // Node stat folds (P7): Fleet/Traveler speed, Acrobat dodges, Marathon
        // sprints, END-scaled regen — the client folds the same aggregates.
        const nodeStats = player.progress.aggregates.stats;
        const modifiers = {
          speedMult:
            moveSpeedMultOf(player) *
            (evasive ? 1 + EVASIVE_MOVE_SPEED_PCT / 100 : 1) *
            (player.focusing ? FOCUS_MOVE_SPEED_MULT : 1) *
            (1 + nodeStats.moveSpeedPct / 100) *
            whirlMult *
            castMult,
          dodgeCostDelta:
            (evasive ? -EVASIVE_DODGE_DISCOUNT : 0) +
            dodgeCostDeltaOf(player) +
            nodeStats.dodgeStaminaCostDelta,
          staminaRegenPerS: player.stats.staminaRegenPerS,
          sprintStaminaPerS: SPRINT_STAMINA_PER_SEC + nodeStats.sprintStaminaPerSDelta,
          // Hard CC (P6): stun locks everything, root pins the feet — the
          // SHARED step enforces both so prediction agrees to the centimeter.
          rooted: player.isRooted(nowMs),
          controlsLocked: player.isStunned(nowMs),
        };
        const result: MovementStepResult = stepMovement(
          player.movement,
          intent,
          TICK_DT,
          this.terrain,
          modifiers,
        );
        if (result.dodged) {
          cancelComboOnDodge(player);
          // A roll cancels an active cast OR channel for HALF the cost back
          // (§4.5) — the client mirrors this in its predicted step. The
          // refund reads the EFFECTIVE cost (node cost discounts, P7).
          const casting = player.abilityMachine.cast ?? player.abilityMachine.channel;
          if (casting && this.content) {
            const castDef = effectiveDefOf(player, casting.abilityId, this.content.abilities);
            const interrupted = interruptCast(
              player.abilityMachine,
              'dodge',
              castDef?.cost.amount ?? 0,
            );
            if (interrupted.refund > 0) gainResource(player.resource, interrupted.refund, true);
          }
        }
        if (result.fallDamageFraction > 0) {
          player.hp = Math.max(0, player.hp - player.maxHp * result.fallDamageFraction);
          player.lastCombatAtMs = nowMs;
          if (player.hp <= 0) {
            events.push({ type: 'player-died', playerId: player.id, killerEnemyId: null });
          }
        }
      }
      player.recordHistory();

      // 1b. Queued combat requests enter the pipeline after movement.
      for (const request of player.takeAttackRequests()) {
        if (request.action === (ActionId.BasicAttack as number)) {
          handleAttackRequest(
            player,
            request.seq,
            request.aimYaw,
            request.aimPitch,
            this.content?.basicChains ?? BASIC_COMBOS,
            nowMs,
            events,
          );
        } else if (request.action === (ActionId.Respawn as number)) {
          this.handleRespawn(player, request.seq, nowMs, events);
        } else if (slotForAction(request.action) !== null && this.content !== null) {
          handleSlotRequest(
            player,
            request.seq,
            request.action,
            request.aimYaw,
            request.aimPitch,
            request.targetId,
            request.groundAim,
            this.content,
            this.enemies,
            this.terrain,
            nowMs,
            events,
          );
        } else {
          events.push({
            type: 'ability-reject',
            playerId: player.id,
            seq: request.seq,
            action: request.action,
            reason: AbilityRejectReason.BadState,
          });
        }
      }
    }

    // 2. Ability pipeline: pending contacts resolve, projectiles fly.
    const abilityDeps = this.content
      ? {
          enemies: this.enemies,
          players: this.players,
          content: this.content,
          rng: this.rng,
          nowMs,
          events,
          terrain: this.terrain,
          projectiles: this.projectiles,
          nextProjectileId: () => this.nextProjectileId++,
          zones: this.zones,
        }
      : null;
    for (const player of this.players.values()) {
      if (abilityDeps && !player.dead) tickPlayerAbilities(player, TICK_MS, abilityDeps);
      advancePlayerContact(
        player,
        this.enemies,
        this.content?.basicChains ?? BASIC_COMBOS,
        nowMs,
        this.rng,
        () => this.nextProjectileId++,
        this.projectiles,
        events,
      );
    }
    stepProjectiles(
      this.projectiles,
      this.enemies,
      this.players,
      this.terrain,
      TICK_DT,
      nowMs,
      this.rng,
      events,
      this.content?.abilities ?? null,
      () => this.nextProjectileId++,
    );
    if (abilityDeps) tickZones(this.zones, abilityDeps);

    // 3. Enemy AI: decisions at 10 Hz (id parity vs tick parity), motion at 20 Hz.
    for (const enemy of this.enemies.values()) {
      if (enemy.state === 'dead') continue;
      // Damage aggros regardless of perception — a sniped enemy fights back
      // (and pulls its camp) even when the shooter is outside its senses.
      if (
        enemy.def.archetype !== 'dummy' &&
        (enemy.state === 'idle' || enemy.state === 'alert') &&
        enemy.threat.size > 0
      ) {
        const top = enemy.topThreat();
        if (top !== null) enterCombat(enemy, top, aiCtx);
      }
      if ((enemy.id & 1) === (this.tickCounter & 1)) decide(enemy, aiCtx);
      const neighbors = enemy.campTag ? (this.campIndex.get(enemy.campTag) ?? []) : [];
      move(enemy, neighbors, aiCtx);
      enemy.history.record(enemy.x, enemy.y, enemy.z, false);
    }

    // 3b. Deaths recorded during this tick (attacks + swings + falls).
    for (const event of events) {
      if (event.type === 'enemy-died') {
        this.onEnemyDeath(event.enemy, event.killerPlayerId, nowMs, events);
      } else if (event.type === 'player-died') this.onPlayerDeath(event.playerId, events);
    }

    // 4. Spawner tickets + corpse cleanup.
    this.sweepCorpsesAndTickets(nowMs, events);

    // 5. Player vitals: out-of-combat regen (COMBAT.md §6.6) + resources +
    // effect expiry (P5) + progression checks (P7: zone discovery, HP procs).
    for (const player of this.players.values()) {
      const inCombat = nowMs - player.lastCombatAtMs <= OOC_AFTER_MS;
      if (!player.dead && player.hp < player.maxHp && !inCombat) {
        player.hp = Math.min(player.maxHp, player.hp + player.maxHp * OOC_HP_REGEN_PER_S * TICK_DT);
      }
      tickResource(player.resource, TICK_MS, inCombat);
      // Zone first-entry XP (P7, §1.1 discovery): polygon check once a second
      // per player, staggered by id — entering a zone is not a twitch event.
      if (
        !player.dead &&
        this.zonePolys.length > 0 &&
        (this.tickCounter + player.id) % 20 === 0 &&
        player.level > 0
      ) {
        this.checkZoneDiscovery(player, events);
      }
      // Low-HP procs (P7: Second Wind, Guardian of Dawn) — threshold checks
      // once per tick catch any crossing within 50 ms of the wound.
      if (!player.dead && player.hp > 0) this.checkLowHpProcs(player, nowMs, events);
      this.periodicScratch.length = 0;
      tickEffects(player, nowMs, this.periodicScratch);
      // HoTs on players tick here (P6: Overflow-style riders; Sanctuary is a
      // ZONE, not an effect). Hostile DoTs on players arrive with P9 casters.
      for (const tick of this.periodicScratch) {
        if (tick.heal <= 0 || player.dead) continue;
        const amount = Math.min(tick.heal, Math.round(player.maxHp - player.hp));
        if (amount <= 0) continue;
        player.hp = Math.min(player.maxHp, player.hp + amount);
        events.push({
          type: 'ability-resolve',
          attackerId: tick.effect.casterId,
          action: 0,
          step: 0,
          hits: [{ targetId: player.id, amount, flags: HitFlag.Healed }],
        });
      }
    }

    // 5b. Enemy effects: bleeds/poisons tick through the real damage path
    // (threat, kill credit, death events all in one place).
    for (const enemy of this.enemies.values()) {
      if (enemy.tauntedById !== null && nowMs >= enemy.tauntedUntilMs) {
        enemy.tauntedById = null;
      }
      if (enemy.state === 'dead') continue;
      this.periodicScratch.length = 0;
      tickEffects(enemy, nowMs, this.periodicScratch);
      for (const tick of this.periodicScratch) {
        const caster = this.players.get(tick.effect.casterId) ?? null;
        const hit = applyDamageToEnemy(
          enemy,
          tick.effect.casterId,
          caster,
          tick.damage,
          false,
          0,
          nowMs,
          events,
        );
        // DoT ticks surface as tiny resolves so combat text shows the drain.
        events.push({
          type: 'ability-resolve',
          attackerId: tick.effect.casterId,
          action: 0,
          step: 0,
          hits: [hit],
        });
      }
    }
    for (const event of events) {
      if (event.type === 'enemy-died') {
        this.onEnemyDeath(event.enemy, event.killerPlayerId, nowMs, events);
      }
    }

    return events;
  }

  /** Plaguebearer: copy the killer-side poisons to the nearest living enemy. */
  private jumpPoisonsOnDeath(dead: ServerEnemy, nowMs: number): void {
    const poisons = dead.effects.filter((effect) => effect.category === 'poison');
    if (poisons.length === 0) return;
    for (const poison of poisons) {
      const caster = this.players.get(poison.casterId);
      if (!caster || !caster.progress.aggregates.passives.poisonJumpOnDeath) continue;
      // Nearest living enemy within earshot of the corpse (8 m — the camp).
      let nearest: ServerEnemy | null = null;
      let nearestDistSq = 8 * 8;
      for (const other of this.enemies.values()) {
        if (other.id === dead.id || !other.alive || other.invulnerable) continue;
        const distSq = (other.x - dead.x) ** 2 + (other.z - dead.z) ** 2;
        if (distSq < nearestDistSq) {
          nearest = other;
          nearestDistSq = distSq;
        }
      }
      if (!nearest) continue;
      applyEffect(
        nearest,
        {
          effectId: poison.effectId,
          casterId: poison.casterId,
          durationMs: Math.max(1000, Math.round(poison.expiresAtMs - nowMs)),
          stacksMax: poison.stacksMax,
          mods: poison.mods,
          harmful: true,
          category: 'poison',
          tickDamage: poison.tickDamage,
          tickSchool: poison.tickSchool,
          tickEveryMs: 1000,
        },
        nowMs,
      );
    }
  }

  /** Zone polygon membership → first-entry discovery XP (P7, §1.1). */
  private checkZoneDiscovery(player: ServerPlayer, events: CombatEvent[]): void {
    const m = player.movement;
    for (const zone of this.zonePolys) {
      if (player.progress.zonesSeen.has(zone.id)) continue;
      if (!pointInPolygon(m.x, m.z, zone.polygon)) continue;
      player.progress.zonesSeen.add(zone.id);
      const content = this.progressionContent();
      awardXp(
        player,
        discoveryXp('zone', xpToNext(content.xpCurve, player.level)),
        XpSource.Discovery,
        content,
        events,
      );
      events.push({
        type: 'discovery',
        playerId: player.id,
        kind: 'zone',
        refId: zone.id,
        label: zone.name,
      });
    }
  }

  /** Second Wind / Guardian of Dawn: low-HP triggers with their ICDs (P7). */
  private checkLowHpProcs(player: ServerPlayer, nowMs: number, events: CombatEvent[]): void {
    const procs = player.progress.aggregates.procs;
    if (procs.length === 0) return;
    const fraction = player.maxHp > 0 ? (player.hp / player.maxHp) * 100 : 100;
    for (const entry of procs) {
      const proc = entry.proc;
      if (proc.proc !== 'low_hp_heal' && proc.proc !== 'low_hp_free_cast') continue;
      if (fraction >= proc.thresholdPct) continue;
      const readyAt = player.progress.procReadyAtMs.get(entry.nodeId) ?? 0;
      if (nowMs < readyAt) continue;
      player.progress.procReadyAtMs.set(entry.nodeId, nowMs + proc.icdMs);
      if (proc.proc === 'low_hp_heal') {
        const amount = Math.min(
          Math.max(1, Math.round((player.maxHp * proc.healPct) / 100)),
          Math.round(player.maxHp - player.hp),
        );
        if (amount > 0) {
          player.hp = Math.min(player.maxHp, player.hp + amount);
          events.push({
            type: 'ability-resolve',
            attackerId: player.id,
            action: 0,
            step: 0,
            hits: [{ targetId: player.id, amount, flags: HitFlag.Healed }],
          });
        }
      } else {
        // Guardian of Dawn: the target ability's shield effect lands free.
        const def = this.content?.abilities.get(proc.abilityId);
        const shield = def?.effects.find(
          (effect): effect is Extract<(typeof def.effects)[number], { kind: 'shield' }> =>
            effect.kind === 'shield',
        );
        if (def && shield) {
          applyEffect(
            player,
            {
              effectId: `shield_${def.id}`,
              casterId: player.id,
              durationMs: shield.durationMs,
              stacksMax: 1,
              mods: {},
              harmful: false,
              shieldPool: Math.max(1, Math.round(shield.coef * player.stats.sp)),
            },
            nowMs,
          );
        }
      }
    }
  }

  private onEnemyDeath(
    enemy: ServerEnemy,
    killerPlayerId: number | null,
    nowMs: number,
    events: CombatEvent[],
  ): void {
    if (enemy.state === 'dead') return; // one death per enemy
    enemy.enterState('dead', nowMs);
    enemy.despawnAtMs = nowMs + CORPSE_LINGER_MS;
    enemy.swing = null;
    enemy.vx = 0;
    enemy.vz = 0;
    // Kill XP to every tagged player (P7, §1.1) — BEFORE the ledger clears.
    // Dummies pay nothing: infinite-respawn practice targets are not a farm.
    if (enemy.def.archetype !== 'dummy') {
      awardKillXp(
        { damage: enemy.damageBy, healAssists: enemy.healAssists },
        enemy.level,
        enemy.def.rank,
        enemy.def.xpMult,
        this.players,
        this.progressionContent(),
        events,
      );
    }
    // Loot (P8, ITEMS_LOOT.md §3–4): one INDEPENDENT roll per tagger, all
    // parcelled into a single bag at the corpse. Same tag rule as the XP
    // above, so nobody is paid experience but skipped for drops.
    if (enemy.def.archetype !== 'dummy' && enemy.def.loot) {
      const taggers = [...killTaggers({ damage: enemy.damageBy, healAssists: enemy.healAssists })]
        .map((playerId) => this.players.get(playerId))
        .filter((player): player is ServerPlayer => player !== undefined && !player.dead);
      const bag = rollEnemyLoot(
        enemy,
        taggers,
        this.itemContent(),
        this.rng,
        nowMs,
        this.nextLootBagId,
      );
      if (bag) {
        this.nextLootBagId++;
        this.lootBags.set(bag.id, bag);
        for (const playerId of bag.shares.keys()) {
          events.push({ type: 'loot-dirty', playerId });
        }
      }
    }

    // Killer's Rhythm-style on-kill buffs for whoever landed the blow (P7).
    if (killerPlayerId !== null) {
      const killer = this.players.get(killerPlayerId);
      if (killer && !killer.dead) {
        for (const entry of killer.progress.aggregates.procs) {
          if (entry.proc.proc !== 'on_kill_buff') continue;
          applyEffect(
            killer,
            {
              effectId: entry.proc.effectId,
              casterId: killer.id,
              durationMs: entry.proc.durationMs,
              stacksMax: 1,
              mods: entry.proc.mods,
              harmful: false,
            },
            nowMs,
          );
        }
      }
    }
    // Plaguebearer (P7 capstone): the killer's poisons jump to the nearest
    // living camp-mate in earshot when a poisoned target dies.
    this.jumpPoisonsOnDeath(enemy, nowMs);
    enemy.damageBy.clear();
    enemy.healAssists.clear();
    events.push({
      type: 'entity-event',
      entityId: enemy.id,
      event: EntityEventKind.Death,
      a: CORPSE_LINGER_MS,
      b: 0,
      c: 0,
    });
    // Respawn ticket with ±20% jitter (NPCS_ENEMIES.md §3).
    const spawner = this.content?.spawners.find((s) => s.id === enemy.spawnerId);
    if (spawner) {
      const jitter = 1 + (this.rng() * 2 - 1) * RESPAWN_JITTER;
      this.tickets.push({
        spawner,
        enemyDef: enemy.def,
        level: this.rollLevel(enemy.def, null),
        atMs: nowMs + spawner.respawnMs * jitter,
      });
    }
  }

  private onPlayerDeath(playerId: number, events: CombatEvent[]): void {
    const player = this.players.get(playerId);
    if (!player || player.dead) return;
    player.dead = true;
    player.hp = 0;
    player.pendingContact = null;
    player.comboStep = -1;
    player.movement.vx = 0;
    player.movement.vz = 0;
    events.push({
      type: 'entity-event',
      entityId: player.id,
      event: EntityEventKind.Death,
      a: 0,
      b: 0,
      c: 0,
    });
    // The dead drop off every threat table; camps stand down naturally.
    for (const enemy of this.enemies.values()) enemy.threat.delete(player.id);
  }

  /** Soul-screen respawn: back to the shrine (spawn ring), full HP, Dawned. */
  private handleRespawn(
    player: ServerPlayer,
    seq: number,
    nowMs: number,
    events: CombatEvent[],
  ): void {
    if (!player.dead) {
      events.push({
        type: 'ability-reject',
        playerId: player.id,
        seq,
        action: ActionId.Respawn,
        reason: AbilityRejectReason.BadState,
      });
      return;
    }
    const spawn = this.playerSpawnPoint();
    const m = player.movement;
    m.x = spawn.x;
    m.y = spawn.y;
    m.z = spawn.z;
    m.vx = 0;
    m.vy = 0;
    m.vz = 0;
    m.grounded = true;
    m.swimming = false;
    m.fallPeakY = spawn.y;
    m.stamina = m.maxStamina;
    player.dead = false;
    player.hp = player.maxHp;
    player.dawnedUntilMs = nowMs + DAWNED_DURATION_MS;
    player.lastCombatAtMs = 0;
    events.push({
      type: 'entity-event',
      entityId: player.id,
      event: EntityEventKind.Respawn,
      a: 0,
      b: 0,
      c: 0,
    });
    events.push({
      type: 'entity-event',
      entityId: player.id,
      event: EntityEventKind.Dawned,
      a: DAWNED_DURATION_MS,
      b: 0,
      c: 0,
    });
  }

  private sweepCorpsesAndTickets(nowMs: number, events: CombatEvent[]): void {
    for (const enemy of [...this.enemies.values()]) {
      if (enemy.state === 'dead' && nowMs >= enemy.despawnAtMs) this.removeEnemy(enemy);
    }
    for (let i = this.tickets.length - 1; i >= 0; i--) {
      const ticket = this.tickets[i]!;
      if (nowMs < ticket.atMs) continue;
      // No face-spawns: hold the pop while someone stands on the spawner.
      let blocked = false;
      for (const player of this.players.values()) {
        const dx = player.movement.x - ticket.spawner.x;
        const dz = player.movement.z - ticket.spawner.z;
        if (dx * dx + dz * dz < SPAWN_CLEAR_RADIUS * SPAWN_CLEAR_RADIUS) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        ticket.atMs = nowMs + SPAWN_RETRY_MS;
        continue;
      }
      this.tickets.splice(i, 1);
      const enemy = this.spawnEnemy(ticket.spawner, ticket.enemyDef, ticket.level);
      events.push({
        type: 'entity-event',
        entityId: enemy.id,
        event: EntityEventKind.Respawn,
        a: 0,
        b: 0,
        c: 0,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Snapshots / AOI
  // -------------------------------------------------------------------------

  /**
   * Interest management (docs/tech/NETWORKING.md §5): players AND enemies
   * within ~96 m enter the viewer's set, leaving past 104 m. Per-viewer cap
   * 80, nearest first, players prioritized over enemies at the cap.
   */
  entitiesFor(viewer: ServerPlayer, out: SnapshotEntity[]): SnapshotEntity[] {
    out.length = 0;
    const vm = viewer.movement;
    const candidates: {
      id: number;
      kind: number;
      x: number;
      y: number;
      z: number;
      yaw: number;
      flags: number;
      hpFraction: number;
      distSq: number;
      isPlayer: boolean;
    }[] = [];

    for (const player of this.players.values()) {
      if (player.id === viewer.id) continue;
      const m = player.movement;
      const distSq = (m.x - vm.x) ** 2 + (m.z - vm.z) ** 2;
      const wasVisible = viewer.visible.has(player.id);
      if (distSq <= (wasVisible ? AOI_LEAVE_SQ : AOI_ENTER_SQ)) {
        candidates.push({
          id: player.id,
          kind: EntityKind.Player,
          x: m.x,
          y: m.y,
          z: m.z,
          yaw: m.yaw,
          flags: player.flagsAt(Date.now()),
          hpFraction: player.maxHp > 0 ? player.hp / player.maxHp : 0,
          distSq,
          isPlayer: true,
        });
      } else if (wasVisible) {
        viewer.visible.delete(player.id);
      }
    }

    for (const enemy of this.enemies.values()) {
      const distSq = (enemy.x - vm.x) ** 2 + (enemy.z - vm.z) ** 2;
      const wasVisible = viewer.visible.has(enemy.id);
      if (distSq <= (wasVisible ? AOI_LEAVE_SQ : AOI_ENTER_SQ)) {
        let flags = 0;
        if (enemy.state === 'combat') flags |= EntityFlag.InCombat;
        if (Date.now() < enemy.stunnedUntilMs) flags |= EntityFlag.Staggered;
        if (Date.now() < enemy.rootedUntilMs) flags |= EntityFlag.Rooted;
        if (enemy.state === 'dead') flags |= EntityFlag.Dead;
        if (enemy.state === 'return') flags |= EntityFlag.Leashing;
        if (Math.abs(enemy.vx) > 0.05 || Math.abs(enemy.vz) > 0.05) flags |= EntityFlag.Moving;
        flags |= EntityFlag.Grounded;
        candidates.push({
          id: enemy.id,
          kind: EntityKind.Enemy,
          x: enemy.x,
          y: enemy.y,
          z: enemy.z,
          yaw: enemy.yaw,
          flags,
          hpFraction: enemy.maxHp > 0 ? enemy.hp / enemy.maxHp : 0,
          distSq,
          isPlayer: false,
        });
      } else if (wasVisible) {
        viewer.visible.delete(enemy.id);
      }
    }

    if (candidates.length > AOI_ENTITY_CAP) {
      // Players first, then nearest — the cap must never hide a friend.
      candidates.sort((a, b) =>
        a.isPlayer !== b.isPlayer ? (a.isPlayer ? -1 : 1) : a.distSq - b.distSq,
      );
      for (const dropped of candidates.splice(AOI_ENTITY_CAP)) {
        viewer.visible.delete(dropped.id);
      }
    }
    for (const candidate of candidates) {
      viewer.visible.add(candidate.id);
      out.push({
        id: candidate.id,
        kind: candidate.kind,
        x: candidate.x,
        y: candidate.y,
        z: candidate.z,
        yaw: candidate.yaw,
        flags: candidate.flags,
        hpFraction: candidate.hpFraction,
      });
    }
    return out;
  }

  /** `/stuck` and future GM recalls: back to the spawn ring, cleanly grounded. */
  teleportToSpawn(player: ServerPlayer): void {
    const spawn = this.playerSpawnPoint();
    const m = player.movement;
    m.x = spawn.x;
    m.y = spawn.y;
    m.z = spawn.z;
    m.vx = 0;
    m.vy = 0;
    m.vz = 0;
    m.grounded = true;
    m.swimming = false;
    m.fallPeakY = spawn.y;
  }

  roster(): RosterEntry[] {
    const defs = this.itemContent().items;
    return Array.from(this.players.values(), (player) => {
      // Visible weapons ride the roster (ITEMS_LOOT.md §1): armour never
      // changes the silhouette, held gear always does — for everyone.
      const mainhand = player.items.inventory.equipment.get('mainhand');
      const offhand = player.items.inventory.equipment.get('offhand');
      return {
        id: player.id,
        name: player.name,
        classId: player.classId,
        level: player.level,
        appearance: player.appearance,
        mainhandModel: mainhand ? (defs.get(mainhand.itemId)?.modelRef ?? null) : null,
        offhandModel: offhand ? (defs.get(offhand.itemId)?.modelRef ?? null) : null,
      };
    });
  }
}
