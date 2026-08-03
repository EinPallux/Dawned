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
  EntityKind,
  OOC_AFTER_MS,
  OOC_HP_REGEN_PER_S,
  TICK_DT,
  WORLD_BOUNDS,
  devTerrain,
  stepMovement,
  type Appearance,
  type ClassId,
  EVASIVE_DODGE_DISCOUNT,
  EVASIVE_ENERGY_PER_S,
  EVASIVE_MOVE_SPEED_PCT,
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
} from '@dawned/shared';
import { ServerPlayer } from './player.js';
import { ServerEnemy } from './enemy.js';
import type { GameContent } from '../content/loader.js';
import {
  advancePlayerContact,
  applyDamageToEnemy,
  cancelComboOnDodge,
  handleAttackRequest,
  stepProjectiles,
  type CombatEvent,
  type ServerProjectile,
} from './combat.js';
import { handleSlotRequest, tickPlayerAbilities } from './abilities.js';
import { moveSpeedMultOf, tickEffects, type PeriodicTick } from './effects.js';
import { CORPSE_LINGER_MS, decide, enterCombat, move, type AiContext } from './enemy-ai.js';

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
  ) {
    if (content) this.populateFromSpawners();
  }

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

    const player = new ServerPlayer(
      id,
      spec.characterId,
      spec.accountId,
      spec.name,
      spec.classId,
      spec.level,
      spec.appearance,
      spawn.x,
      y,
      spawn.z,
      spawn.yaw,
      spec.hp ?? null,
    );
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
    return {
      abilities: next.abilities.size,
      enemies: next.enemies.size,
      spawners: next.spawners.length,
    };
  }

  step(): CombatEvent[] {
    const events: CombatEvent[] = [];
    const nowMs = Date.now();
    this.tickCounter++;

    const aiCtx: AiContext = {
      players: this.players,
      terrain: this.terrain,
      nowMs,
      dt: TICK_DT,
      rng: this.rng,
      events,
      enemiesByCamp: (tag) => this.campIndex.get(tag) ?? [],
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
        // RMB stances (P5, CLASSES.md): shield up for Warrior/Cleric with the
        // perfect-block window stamped on the raise EDGE; Evasive for Rogues
        // (speed + dodge discount, 3 Energy/s while held and affordable).
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
        const whirlMult = player.pendingAbility?.def.anim.moveSpeedMult ?? 1;
        const modifiers = {
          speedMult:
            moveSpeedMultOf(player) * (evasive ? 1 + EVASIVE_MOVE_SPEED_PCT / 100 : 1) * whirlMult,
          dodgeCostDelta: evasive ? -EVASIVE_DODGE_DISCOUNT : 0,
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
          // A roll cancels an active cast for HALF the cost back (§4.5).
          const casting = player.abilityMachine.cast;
          if (casting) {
            const castDef = this.content?.abilities.get(casting.abilityId);
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
          handleAttackRequest(player, request.seq, request.aimYaw, request.aimPitch, nowMs, events);
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
        }
      : null;
    for (const player of this.players.values()) {
      if (abilityDeps && !player.dead) tickPlayerAbilities(player, TICK_MS, abilityDeps);
      advancePlayerContact(
        player,
        this.enemies,
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
    );

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
      if (event.type === 'enemy-died') this.onEnemyDeath(event.enemy, nowMs, events);
      else if (event.type === 'player-died') this.onPlayerDeath(event.playerId, events);
    }

    // 4. Spawner tickets + corpse cleanup.
    this.sweepCorpsesAndTickets(nowMs, events);

    // 5. Player vitals: out-of-combat regen (COMBAT.md §6.6) + resources +
    // effect expiry (P5).
    for (const player of this.players.values()) {
      const inCombat = nowMs - player.lastCombatAtMs <= OOC_AFTER_MS;
      if (!player.dead && player.hp < player.maxHp && !inCombat) {
        player.hp = Math.min(player.maxHp, player.hp + player.maxHp * OOC_HP_REGEN_PER_S * TICK_DT);
      }
      tickResource(player.resource, TICK_MS, inCombat);
      this.periodicScratch.length = 0;
      tickEffects(player, nowMs, this.periodicScratch);
      // No hostile DoTs on players in P5 content — expiry/dirty only.
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
      if (event.type === 'enemy-died') this.onEnemyDeath(event.enemy, nowMs, events);
    }

    return events;
  }

  private onEnemyDeath(enemy: ServerEnemy, nowMs: number, events: CombatEvent[]): void {
    if (enemy.state === 'dead') return; // one death per enemy
    enemy.enterState('dead', nowMs);
    enemy.despawnAtMs = nowMs + CORPSE_LINGER_MS;
    enemy.swing = null;
    enemy.vx = 0;
    enemy.vz = 0;
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
          flags: player.flags,
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
    return Array.from(this.players.values(), (player) => ({
      id: player.id,
      name: player.name,
      classId: player.classId,
      level: player.level,
      appearance: player.appearance,
    }));
  }
}
