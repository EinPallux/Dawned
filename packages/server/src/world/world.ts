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
  poiDiscoveryXp,
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
  GatherRefusal,
  gatherXp,
  type GatherOp,
  type Profession,
  type NodePlacement,
  type ResourceNodeDef,
  type Interactable,
  type NpcPlacement,
  type Poi,
  type QuestDef,
  type QuestEvent,
  type QuestHook,
  type InteractOp,
  type QuestOp,
  rollLootTable,
  questTurnInNpc,
  countItem,
} from '@dawned/shared';
import { ServerPlayer } from './player.js';
import {
  INTERACT_RANGE_M,
  buildInteractables,
  buildNpcs,
  type PlacedInteractable,
  type ServerNpc,
} from './interactables.js';
import { applyQuestEvent } from './quests.js';
import {
  applyInteract,
  applyQuestOp,
  emptyEffects,
  type InteractEffects,
  type InteractWorld,
} from './interact-step.js';
import { poisEntered } from './interactables.js';

/**
 * The parts of a bake that are neither terrain nor resource nodes (P11).
 * Optional throughout so a test world — and a bake published before P11 — is
 * simply a world where nobody lives yet.
 */
export interface WorldPlacements {
  npcs?: readonly NpcPlacement[];
  interactables?: readonly Interactable[];
  pois?: readonly Poi[];
}
import {
  buildNodes,
  channelBreak,
  finishGather,
  releaseClaim,
  respawnNodes,
  startGather,
  type GatherChannel,
  type ServerNode,
} from './nodes.js';
import { awardProfessionXp, createProfessions, professionLevel } from './professions.js';
import {
  fishingExpired,
  fishingXp,
  hookFishing,
  startFishing,
  stepFishing,
  type FishingSession,
} from './fishing.js';

/** Ticks between authoritative reel-progress corrections (20 Hz → ~4/s). */
const FISHING_SYNC_TICKS = 5;
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
  takeItem,
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
    // Not `readonly`: a map publish swaps the ground under a running world
    // (`applyMap`). Every system takes the sampler as an argument at call time,
    // so nothing caches a stale one — keep it that way.
    private terrain: TerrainSampler = devTerrain,
    private spawn: SpawnPoint = { x: 0, y: 0, z: 0, yaw: 0 },
    private content: GameContent | null = null,
    private readonly rng: Rng = Math.random,
    /** Zone polygons (P7 zone-entry XP; baked zones.json, empty in tests). */
    private zonePolys: readonly Zone[] = [],
    /** Resource-node placements from the bake (P10; empty in tests). */
    nodePlacements: readonly NodePlacement[] = [],
    /** NPC placements, interactables and POIs from the bake (P11). */
    worldPlacements: WorldPlacements = {},
  ) {
    if (content) this.populateFromSpawners();
    this.seedNodes(nodePlacements);
    this.seedWorldObjects(worldPlacements);
  }

  /**
   * (Re)build the NPCs, interactables and POIs a bake carries.
   *
   * Same orphan policy as nodes: a placement whose NPC definition is gone is
   * dropped with a count rather than taking the world down, because publish
   * already cross-checks the refs and reaching here means two publishes drifted.
   */
  private seedWorldObjects(placements: WorldPlacements): void {
    const built = buildNpcs(placements.npcs ?? [], this.content?.npcs ?? new Map(), (x, z) =>
      this.terrain.heightAt(x, z),
    );
    this.npcs.clear();
    for (const [id, npc] of built.npcs) this.npcs.set(id, npc);
    this.orphanNpcRefs = built.orphans;
    this.interactables = buildInteractables(placements.interactables ?? [], (x, z) =>
      this.terrain.heightAt(x, z),
    );
    this.pois = placements.pois ?? [];
  }

  private readonly npcs = new Map<string, ServerNpc>();
  private interactables: Map<string, PlacedInteractable> = new Map();
  private pois: readonly Poi[] = [];
  private orphanNpcRefs: string[] = [];

  /** Live world objects, for the gateway and `/ops/worldobjects`. */
  get worldObjects(): {
    npcs: number;
    interactables: number;
    pois: number;
    orphanNpcs: number;
    /** WHICH placements lost their definition — a count alone is unfixable. */
    orphanNpcRefs: readonly string[];
  } {
    return {
      npcs: this.npcs.size,
      interactables: this.interactables.size,
      pois: this.pois.length,
      orphanNpcs: this.orphanNpcRefs.length,
      orphanNpcRefs: this.orphanNpcRefs,
    };
  }

  /**
   * What the bestiary actually became in this world (P12-C).
   *
   * The counterpart to `/ops/respawnnodes` reporting "65 nodes, 0 orphans" and
   * `/ops/worldobjects` reporting the villagers: a publish saying "ok" is the
   * PANEL's account of its own work, and 124 camps that all seeded into the sea
   * would look identical from outside. `drySpawners` is the line that matters —
   * a camp whose ground could not be found is a camp nobody will ever fight.
   */
  get campReport(): {
    spawners: number;
    enemies: number;
    alive: number;
    orphanEnemyRefs: readonly string[];
    /** Camps that produced no live enemy at all. */
    drySpawners: readonly string[];
    perZone: Record<string, { camps: number; enemies: number }>;
  } {
    const spawners = this.content?.spawners ?? [];
    const orphans = new Set<string>();
    const produced = new Map<string, number>();
    for (const enemy of this.enemies.values()) {
      produced.set(enemy.spawnerId, (produced.get(enemy.spawnerId) ?? 0) + 1);
    }
    const perZone: Record<string, { camps: number; enemies: number }> = {};
    let wanted = 0;
    for (const spawner of spawners) {
      for (const entry of spawner.entries) {
        wanted += entry.count;
        if (!this.content?.enemies.has(entry.enemyId)) orphans.add(entry.enemyId);
      }
      // The zones arrive sorted smallest-ring-first from the bake, so the first
      // match is the specific zone rather than the world-covering Dawnsea.
      const zone =
        this.zonePolys.find((poly) => pointInPolygon(spawner.x, spawner.z, poly.polygon))?.id ??
        'none';
      const bucket = (perZone[zone] ??= { camps: 0, enemies: 0 });
      bucket.camps++;
      bucket.enemies += produced.get(spawner.id) ?? 0;
    }
    return {
      spawners: spawners.length,
      enemies: wanted,
      alive: this.enemies.size,
      orphanEnemyRefs: [...orphans],
      drySpawners: spawners.filter((s) => !produced.has(s.id)).map((s) => s.id),
      perZone,
    };
  }

  npcAt(id: string): ServerNpc | undefined {
    return this.npcs.get(id);
  }
  interactableAt(id: string): PlacedInteractable | undefined {
    return this.interactables.get(id);
  }
  get allNpcs(): ReadonlyMap<string, ServerNpc> {
    return this.npcs;
  }
  get allInteractables(): ReadonlyMap<string, PlacedInteractable> {
    return this.interactables;
  }
  get allPois(): readonly Poi[] {
    return this.pois;
  }
  questDefs(): ReadonlyMap<string, QuestDef> {
    return this.content?.quests ?? new Map();
  }

  /**
   * (Re)build the resource-node set from a bake's placements.
   *
   * Orphans — a placement whose definition is gone — are logged and dropped
   * rather than throwing: publish already cross-checks node refs, so reaching
   * here means map and content drifted between two publishes, and taking the
   * world down over one stale rock would turn a content typo into an outage.
   */
  private seedNodes(placements: readonly NodePlacement[]): void {
    const built = buildNodes(
      placements,
      { defs: this.content?.resourceNodes ?? new Map() },
      (x, z) => this.terrain.heightAt(x, z),
    );
    this.nodes.clear();
    for (const [id, node] of built.nodes) this.nodes.set(id, node);
    this.orphanNodeRefs = built.orphans;
  }

  /** Node ids in the bake with no published definition — surfaced on health. */
  private orphanNodeRefs: string[] = [];
  get nodeStats(): { total: number; depleted: number; orphans: number } {
    let depleted = 0;
    for (const node of this.nodes.values()) if (node.readyAtMs !== null) depleted++;
    return { total: this.nodes.size, depleted, orphans: this.orphanNodeRefs.length };
  }

  /**
   * Swap in a freshly published map (A2 publish → `/ops/reload-map`).
   *
   * Terrain, zone polygons and the spawn point are all replaced, then every
   * enemy is despawned and re-seeded from the spawners: a camp authored on a
   * hill that just became a bay has to move, and re-running the same seeding
   * the boot path uses is the only way to guarantee the result matches what a
   * restart would produce.
   *
   * Players are NOT moved. They keep their x/z and re-resolve their ground on
   * the next tick — the same clamp that already handles walking off a ledge.
   * Anyone the new terrain leaves under the ground gets pushed up by it; anyone
   * left over open sea swims, which is honest and visible.
   */
  applyMap(next: {
    terrain: TerrainSampler;
    spawn: SpawnPoint;
    zones: readonly Zone[];
    nodes?: readonly NodePlacement[];
    world?: WorldPlacements;
  }): {
    enemies: number;
  } {
    this.terrain = next.terrain;
    this.spawn = next.spawn;
    this.zonePolys = next.zones;
    for (const enemy of [...this.enemies.values()]) this.removeEnemy(enemy);
    this.tickets.length = 0;
    this.campIndex.clear();
    this.populateFromSpawners();
    // Nodes re-seed against the new ground for the same reason camps do: a
    // birch authored on a hill that just became a bay has to sit on the bay.
    // Depletion timers are NOT carried across — a republish is a new world, and
    // preserving "this tree is stumped" across a bake that may not contain that
    // tree is more surprising than a forest that comes back standing.
    this.seedNodes(next.nodes ?? []);
    // NPCs, chests and discovery points re-seat on the new ground for the same
    // reason camps and trees do. Per-character interaction records are NOT
    // touched: an attuned shrine is something the player did, and a republish
    // must not un-attune it any more than it re-awards zone-discovery XP.
    this.seedWorldObjects(next.world ?? {});
    for (const player of this.players.values()) {
      const m = player.movement;
      m.y = this.terrain.heightAt(m.x, m.z);
    }
    // `zonesSeen` is deliberately NOT cleared: discovery XP is progression the
    // player already earned, and re-awarding it on every publish would make a
    // map republish a currency.
    return { enemies: this.enemies.size };
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

  /** Published resource-node definitions (P10) — empty until content lands. */
  resourceNodeDefs(): ReadonlyMap<string, ResourceNodeDef> {
    return this.content?.resourceNodes ?? new Map();
  }

  /** Published item/loot/vendor rows (empty maps until P8 content lands). */
  itemContent(): ItemContent {
    return {
      items: this.content?.items ?? new Map(),
      lootTables: this.content?.lootTables ?? new Map(),
      vendors: this.content?.vendors ?? new Map(),
    };
  }

  /** Resource nodes by placement id (P10) — position from the bake, state here. */
  readonly nodes = new Map<string, ServerNode>();
  /** In-flight gather holds, one per player (you cannot chop two trees). */
  private readonly gathering = new Map<number, GatherChannel>();
  /** In-flight fishing attempts (P10-C) — a gather hold with a minigame. */
  private readonly fishing = new Map<number, FishingSession>();

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
  // Gathering (P10)
  // -------------------------------------------------------------------------

  /**
   * One tick of gathering: drain intents, then advance the holds.
   *
   * Order matters. Intents are drained FIRST so a start becomes a channel this
   * tick and can only complete on a later one — resolving both in the same pass
   * would make a 3 s hold finish instantly for anyone who could send two
   * messages between ticks, which is a duplication bug wearing a timer's
   * clothes.
   */
  private stepGathering(nowMs: number, events: CombatEvent[]): void {
    const defs = this.content?.resourceNodes ?? new Map<string, ResourceNodeDef>();

    for (const request of this.pendingGatherOps.splice(0)) {
      const player = this.players.get(request.playerId);
      if (!player) continue;
      if (request.op.kind === 'cancel') {
        this.endGather(player.id, 'cancelled', undefined, events);
        this.endFishing(player.id, events);
        continue;
      }
      if (request.op.kind === 'hook') {
        // Answering a bite. The SERVER decides whether the press was in the
        // window it opened — a late one must not get to argue it was early.
        const session = this.fishing.get(player.id);
        if (session && hookFishing(session, nowMs)) {
          events.push({
            type: 'fishing-state',
            playerId: player.id,
            phase: 'reeling',
            placementId: session.placementId,
            seed: session.seed,
            startedAtMs: session.reelStartedAtMs,
            driftSpeed: session.driftSpeed,
            markerHalf: session.markerHalf,
            progress: 0,
          });
        }
        continue;
      }
      // Already holding something? Treat a new start as "switch": drop the old
      // claim first, or a player who re-clicks mid-hold locks two nodes.
      this.endGather(player.id, 'cancelled', undefined, events);
      const node = this.nodes.get(request.op.placementId);
      const def = node ? defs.get(node.nodeId) : undefined;
      const level = professionLevel(player.professions, def?.profession ?? 'woodcutting');
      // Anything that already owns the character: dead, mid-cast, mid-channel,
      // or a committed swing waiting for its contact frame.
      const busy =
        player.dead ||
        player.abilityMachine.cast !== null ||
        player.abilityMachine.channel !== null ||
        player.pendingAbility !== null;
      const result = startGather(player, node, def, level, nowMs, busy);
      if (!result.ok || !result.channel) {
        events.push({
          type: 'gather-state',
          playerId: player.id,
          phase: 'refused',
          placementId: request.op.placementId,
          reason: result.refusal ?? GatherRefusal.Unknown,
        });
        continue;
      }
      // A fishing spot passes the SAME gates (range, tier, claim) and then
      // runs a minigame instead of a timer — one interaction framework, two
      // kinds of channel, rather than two ways to touch the world.
      if (def && def.profession === 'fishing') {
        const forced = this.forcedFish.get(player.id);
        if (forced) {
          if (forced.casts <= 1) this.forcedFish.delete(player.id);
          else this.forcedFish.set(player.id, { ...forced, casts: forced.casts - 1 });
        }
        const session = startFishing(
          def,
          result.channel.placementId,
          Math.floor(this.rng() * 0xffff_ffff),
          nowMs,
          player.movement.x,
          player.movement.z,
          { fishPick: this.rng(), fishQty: this.rng() },
          this.itemContent().items,
          forced?.itemId,
        );
        this.fishing.set(player.id, session);
        this.gathering.set(player.id, result.channel);
        events.push({
          type: 'fishing-state',
          playerId: player.id,
          phase: 'waiting',
          placementId: session.placementId,
          seed: session.seed,
        });
        continue;
      }
      this.gathering.set(player.id, result.channel);
      events.push({
        type: 'gather-state',
        playerId: player.id,
        phase: 'start',
        placementId: result.channel.placementId,
        nodeId: result.channel.nodeId,
        profession: result.channel.profession,
        tier: result.channel.tier,
        startedAtMs: result.channel.startedAtMs,
        endsAtMs: result.channel.endsAtMs,
      });
    }

    // Advance the in-flight holds.
    for (const [playerId, channel] of [...this.gathering]) {
      const player = this.players.get(playerId);
      if (!player) {
        releaseClaim(this.nodes.get(channel.placementId), playerId);
        this.gathering.delete(playerId);
        continue;
      }
      const node = this.nodes.get(channel.placementId);
      const broke = channelBreak(channel, player, node);
      if (broke) {
        this.endGather(playerId, 'cancelled', broke, events);
        this.endFishing(playerId, events);
        continue;
      }
      // Fishing holds are advanced by `stepFishingSessions`, not by a clock.
      if (this.fishing.has(playerId)) continue;
      if (nowMs < channel.endsAtMs) continue;

      const def = defs.get(channel.nodeId);
      if (!def || !node) {
        this.endGather(playerId, 'cancelled', GatherRefusal.Unknown, events);
        continue;
      }
      const level = professionLevel(player.professions, def.profession);
      const award = finishGather(
        def,
        level,
        {
          yieldPick: this.rng(),
          yieldQty: this.rng(),
          proc: this.rng(),
          procPick: this.rng(),
          procQty: this.rng(),
        },
        nowMs,
      );

      // Deplete BEFORE handing out anything: if the bag write throws, the tree
      // is still gone, which is the safe direction. The reverse would print
      // materials from a node that stayed up.
      node.readyAtMs = award.readyAtMs;
      node.claimedBy = 0;
      this.gathering.delete(playerId);
      events.push({ type: 'nodes-dirty', placementIds: [node.id] });

      const itemDeps = { content: this.itemContent(), bags: this.lootBags, nowMs, events };
      const gained: { itemId: string; qty: number }[] = [];
      for (const stack of award.yields) {
        const leftover = grantItem(player, stack.itemId, stack.qty, itemDeps);
        if (stack.qty - leftover > 0)
          gained.push({ itemId: stack.itemId, qty: stack.qty - leftover });
      }
      let proc: { itemId: string; qty: number } | null = null;
      if (award.proc) {
        const leftover = grantItem(player, award.proc.itemId, award.proc.qty, itemDeps);
        if (award.proc.qty - leftover > 0) {
          proc = { itemId: award.proc.itemId, qty: award.proc.qty - leftover };
        }
      }

      const result = awardProfessionXp(player.professions, def.profession, award.profXp);
      events.push({ type: 'professions-dirty', playerId });
      if (result.levelsGained > 0) {
        events.push({
          type: 'profession-level',
          playerId,
          profession: def.profession,
          level: result.level,
        });
      }
      // The CHARACTER trickle comes from PROGRESSION.md's own formula, applied
      // through the same award path kills use so the xpRate lever covers it.
      awardXp(player, gatherXp(def.tier), XpSource.Gather, this.progressionContent(), events);

      // Quest credit for what the node gave. `source: 'gather'` is what lets a
      // COLLECT step insist the herb came out of the ground rather than off a
      // vendor's shelf.
      for (const stack of [...gained, ...(proc ? [proc] : [])]) {
        this.questEvent(
          player,
          { kind: 'item', refId: stack.itemId, qty: stack.qty, source: 'gather' },
          events,
        );
      }

      // Codex: first time this material has ever been gathered by this
      // character. The dedupe lives in the DB's primary key; this only decides
      // whether to bother the gateway with a write.
      for (const stack of [...gained, ...(proc ? [proc] : [])]) {
        if (player.progress.codexSeen.has(stack.itemId)) continue;
        player.progress.codexSeen.add(stack.itemId);
        events.push({
          type: 'discovery',
          playerId,
          kind: 'codex',
          refId: stack.itemId,
          label: this.itemContent().items.get(stack.itemId)?.name ?? stack.itemId,
        });
      }

      events.push({
        type: 'gather-state',
        playerId,
        phase: 'done',
        placementId: node.id,
        nodeId: def.id,
        profession: def.profession,
        tier: def.tier,
        gained,
        proc,
        profXp: award.profXp,
      });
    }

    for (const playerId of this.pendingProfessionSync.splice(0)) {
      if (this.players.has(playerId)) events.push({ type: 'professions-dirty', playerId });
    }

    // Regrowth. Only the ids that changed travel; the gateway decides who is
    // close enough to care.
    const back = respawnNodes(this.nodes, nowMs);
    const forced = this.pendingNodeSync.splice(0);
    const dirty = forced.length > 0 ? [...new Set([...back, ...forced])] : back;
    if (dirty.length > 0) events.push({ type: 'nodes-dirty', placementIds: dirty });
  }

  /**
   * Advance every fishing attempt by one tick.
   *
   * The Reel button rides the input stream, so the server steps the SAME bar
   * the client is drawing, from the same seed. Its progress is the authority;
   * the client's is a prediction that the periodic state message corrects.
   */
  private stepFishingSessions(
    nowMs: number,
    events: CombatEvent[],
    reelBits: ReadonlyMap<number, boolean[]>,
  ): void {
    const defs = this.content?.resourceNodes ?? new Map<string, ResourceNodeDef>();
    for (const [playerId, session] of [...this.fishing]) {
      const player = this.players.get(playerId);
      if (!player || fishingExpired(session, nowMs)) {
        this.endFishing(playerId, events);
        this.endGather(playerId, 'cancelled', GatherRefusal.Busy, events);
        continue;
      }
      // One step per intent CONSUMED this tick, in order — the same sequence
      // of presses the client stepped its own bar with. An empty list is a
      // starved tick: hold what we last had, which is what the movement code
      // does with the same gap.
      const bits = reelBits.get(playerId);
      const presses =
        bits && bits.length > 0 ? bits : [(player.heldButtons & InputButton.Reel) !== 0];
      let tick = { changed: false, resolved: null as 'caught' | 'escaped' | null };
      for (const holding of presses) {
        const step = stepFishing(session, holding, nowMs, TICK_MS);
        tick = { changed: tick.changed || step.changed, resolved: step.resolved ?? tick.resolved };
        if (step.resolved) break;
      }
      // `/ops/hook`: answer the bite on the tick it opens. It runs the SAME
      // `hookFishing` the key does, inside the same window — the lever supplies
      // the reflex, not the outcome.
      const armed = this.autoHook.get(playerId) ?? 0;
      if (session.phase === 'bite' && armed > 0 && hookFishing(session, nowMs)) {
        if (armed <= 1) this.autoHook.delete(playerId);
        else this.autoHook.set(playerId, armed - 1);
        events.push({
          type: 'fishing-state',
          playerId,
          phase: 'reeling',
          placementId: session.placementId,
          seed: session.seed,
          startedAtMs: session.reelStartedAtMs,
          driftSpeed: session.driftSpeed,
          markerHalf: session.markerHalf,
          progress: 0,
        });
        continue;
      }
      if (tick.resolved === 'caught') {
        const def = defs.get(session.nodeId);
        const node = this.nodes.get(session.placementId);
        const level = professionLevel(player.professions, 'fishing');
        const itemDeps = { content: this.itemContent(), bags: this.lootBags, nowMs, events };
        const leftover = session.fishItemId
          ? grantItem(player, session.fishItemId, session.fishQty, itemDeps)
          : session.fishQty;
        const landed = session.fishQty - leftover;
        const xp = fishingXp(session, level);
        if (xp > 0) {
          const award = awardProfessionXp(player.professions, 'fishing', xp);
          events.push({ type: 'professions-dirty', playerId });
          if (award.levelsGained > 0) {
            events.push({
              type: 'profession-level',
              playerId,
              profession: 'fishing',
              level: award.level,
            });
          }
        }
        awardXp(player, gatherXp(session.tier), XpSource.Gather, this.progressionContent(), events);
        // A caught fish depletes the spot the same way a chopped tree does —
        // the ripples go out, and it comes back on its own timer.
        if (node && def) {
          node.readyAtMs = nowMs + def.respawnMs;
          node.claimedBy = 0;
          events.push({ type: 'nodes-dirty', placementIds: [node.id] });
        }
        if (landed > 0 && !player.progress.codexSeen.has(session.fishItemId)) {
          player.progress.codexSeen.add(session.fishItemId);
          events.push({
            type: 'discovery',
            playerId,
            kind: 'codex',
            refId: session.fishItemId,
            label: this.itemContent().items.get(session.fishItemId)?.name ?? session.fishItemId,
          });
        }
        events.push({
          type: 'fishing-state',
          playerId,
          phase: 'caught',
          placementId: session.placementId,
          progress: 1,
          fish: { itemId: session.fishItemId, qty: landed },
          profXp: xp,
        });
        this.fishing.delete(playerId);
        this.gathering.delete(playerId);
        continue;
      }
      if (tick.resolved === 'escaped') {
        // The spot is NOT depleted: a fish that got away leaves the water
        // where it was, so the answer to a miss is to cast again.
        events.push({
          type: 'fishing-state',
          playerId,
          phase: 'escaped',
          placementId: session.placementId,
          progress: session.reel.progress,
        });
        this.endFishing(playerId, events);
        this.endGather(playerId, 'cancelled', undefined, events);
        continue;
      }
      if (tick.changed) {
        events.push({
          type: 'fishing-state',
          playerId,
          phase: session.phase === 'bite' ? 'bite' : 'waiting',
          placementId: session.placementId,
          seed: session.seed,
          hookUntilMs: session.hookUntilMs,
        });
      } else if (session.phase === 'reeling' && this.tickCounter % FISHING_SYNC_TICKS === 0) {
        // A periodic correction rather than one per tick: the client is
        // running the same bar, so this only has to catch drift.
        events.push({
          type: 'fishing-state',
          playerId,
          phase: 'reeling',
          placementId: session.placementId,
          seed: session.seed,
          startedAtMs: session.reelStartedAtMs,
          driftSpeed: session.driftSpeed,
          markerHalf: session.markerHalf,
          progress: session.reel.progress,
        });
      }
    }
  }

  /** Drop a fishing attempt (cancel, break, disconnect). */
  private endFishing(playerId: number, events: CombatEvent[]): void {
    const session = this.fishing.get(playerId);
    if (!session) return;
    this.fishing.delete(playerId);
    events.push({
      type: 'fishing-state',
      playerId,
      phase: 'escaped',
      placementId: session.placementId,
    });
  }

  /** Drop a hold without completing it. Safe to call when there is none. */
  private endGather(
    playerId: number,
    phase: 'cancelled',
    reason: GatherRefusal | undefined,
    events: CombatEvent[],
  ): void {
    const channel = this.gathering.get(playerId);
    if (!channel) return;
    releaseClaim(this.nodes.get(channel.placementId), playerId);
    this.gathering.delete(playerId);
    events.push(
      reason
        ? { type: 'gather-state', playerId, phase, placementId: channel.placementId, reason }
        : { type: 'gather-state', playerId, phase, placementId: channel.placementId },
    );
  }

  /** A disconnect must not leave a node claimed for ever. */
  releaseGather(playerId: number): void {
    const channel = this.gathering.get(playerId);
    if (!channel) return;
    releaseClaim(this.nodes.get(channel.placementId), playerId);
    this.gathering.delete(playerId);
  }

  /** Ops lever: set an online player's profession level by character name. */
  setProfessionByName(name: string, profession: Profession, level: number): boolean {
    for (const player of this.players.values()) {
      if (player.name.toLowerCase() !== name.toLowerCase()) continue;
      player.professions.set(profession, { level, xp: 0 });
      this.pendingProfessionSync.push(player.id);
      return true;
    }
    return false;
  }

  /**
   * Ops lever: answer the bite for an online player (`/ops/hook`).
   *
   * The hook window is 0.8 s of human reaction time, which is the one thing a
   * headless bot cannot supply — a browser stalling on chunk geometry loses a
   * whole window to a single frame. This queues the SAME `hook` op the key
   * sends, so everything downstream (the window check, the reel physics, the
   * catch, the xp) is the real path; only the reflex is stood in for. Same
   * argument as `/ops/hurt` keeping the P9 boss bot alive because it cannot
   * dodge (ARCHITECTURE.md §3).
   */
  hookFishingByName(name: string, bites: number): boolean {
    for (const player of this.players.values()) {
      if (player.name.toLowerCase() !== name.toLowerCase()) continue;
      this.autoHook.set(player.id, Math.max(1, bites));
      return true;
    }
    return false;
  }

  /**
   * How many more bites are answered for a player (`/ops/hook`). A count
   * rather than a flag because a fish that gets away is answered by casting
   * again, so a run that wants to land one needs several arms, and a lever
   * that never expired would be a mode the world could get stuck in.
   */
  private readonly autoHook = new Map<number, number>();

  /**
   * Ops lever: put a named fish on the line for a player's next casts
   * (`/ops/fish`). The bar's difficulty is a function of the fish's rarity, so
   * this is how a rare or legendary bar can be PLAYED — waiting for one to be
   * rolled is a test of the yield weights, not of the reel. It is also the
   * tuning handle Q27 needs: judging how hard a legendary should feel means
   * hooking one on demand rather than fishing for an hour.
   */
  forceFishByName(name: string, itemId: string, casts: number): boolean {
    for (const player of this.players.values()) {
      if (player.name.toLowerCase() !== name.toLowerCase()) continue;
      this.forcedFish.set(player.id, { itemId, casts: Math.max(1, casts) });
      return true;
    }
    return false;
  }

  /**
   * Ops lever: set a character's state on one quest (`/ops/quest`).
   *
   * The quest editor's test button and the verification run's shortcut past
   * three chain links. It writes STATE only — the counters, the turn-in and
   * the payout stay the real path, the same argument `/ops/fish` makes.
   */
  setQuestByName(name: string, questId: string, step: number, drop: boolean): boolean {
    for (const player of this.players.values()) {
      if (player.name.toLowerCase() !== name.toLowerCase()) continue;
      const def = this.questDefs().get(questId);
      if (!def) return false;
      if (drop) {
        player.quests.delete(questId);
        player.pinnedQuests = player.pinnedQuests.filter((id) => id !== questId);
      } else {
        player.quests.set(questId, {
          questId,
          step: Math.min(step, def.steps.length),
          counter: 0,
          status: 'active',
        });
      }
      this.pendingQuestSync.push(player.id);
      return true;
    }
    return false;
  }

  /**
   * Un-find things, so the DISCOVERY LOOP can be measured more than once
   * (P11-E; ARCHITECTURE.md §3 lists every ops lever).
   *
   * Discovery is first-entry-only by design — that is what makes finding a
   * place worth anything — which means a fixture character that has already
   * walked the island can never prove the banner, the XP or the map reveal
   * again. Every earlier phase hit the same wall and answered it the same way:
   * `/ops/hurt` keeps the P9 boss bot alive because it cannot dodge, `/ops/fish`
   * puts a rare on the line because waiting for one measures the yield roll
   * instead of the reel. This forgets; the finding itself is the untouched real
   * path.
   *
   * Zones are separate from POIs on purpose — zone XP is a much bigger award
   * and a run that only wants a vista back should not be handed four levels.
   * `objects` un-opens chests and un-inspects props, which is the other half of
   * the same problem: a quest step that says "open the crate" cannot be measured
   * twice against a crate this character has already emptied.
   */
  forgetDiscoveries(
    name: string,
    what: { pois: boolean; zones: boolean; shrines: boolean; objects: boolean },
  ): { pois: number; zones: number; shrines: number; objects: number } | null {
    for (const player of this.players.values()) {
      if (player.name.toLowerCase() !== name.toLowerCase()) continue;
      const cleared = { pois: 0, zones: 0, shrines: 0, objects: 0 };
      if (what.pois) {
        cleared.pois = player.poisSeen.size;
        player.poisSeen.clear();
      }
      if (what.zones) {
        cleared.zones = player.progress.zonesSeen.size;
        player.progress.zonesSeen.clear();
      }
      if (what.shrines) {
        for (const record of player.interactions.values()) {
          if (!record.attuned) continue;
          record.attuned = false;
          cleared.shrines++;
        }
      }
      if (what.objects) {
        for (const record of player.interactions.values()) {
          if (record.openedUntilMs === 0 && record.uses === 0) continue;
          record.openedUntilMs = 0;
          record.uses = 0;
          cleared.objects++;
        }
      }
      this.pendingDiscoverySync.push(player.id);
      return cleared;
    }
    return null;
  }

  /** Quest syncs raised outside the tick (ops levers) — flushed in step. */
  private readonly pendingQuestSync: number[] = [];

  /** Discovery syncs raised outside the tick (`/ops/forget`) — flushed in step. */
  private readonly pendingDiscoverySync: number[] = [];

  /** Which fish is forced for a player, and for how many more casts. */
  private readonly forcedFish = new Map<number, { itemId: string; casts: number }>();

  /** Profession syncs raised outside the tick (ops levers) — flushed in step. */
  private readonly pendingProfessionSync: number[] = [];

  /** Node respawns raised outside the tick (ops lever) — flushed in step. */
  private readonly pendingNodeSync: string[] = [];

  /**
   * Ops lever: bring every depleted node back at once (`/ops/respawnnodes`).
   *
   * The ids have to be QUEUED for the next tick, not just cleared here: a
   * client's copy of the depleted set is an exception list it only updates
   * when told, so a silent server-side respawn leaves connected players
   * looking at a stump they cannot gather until something else happens to
   * dirty the same node.
   */
  respawnAllNodes(): number {
    let count = 0;
    for (const node of this.nodes.values()) {
      if (node.readyAtMs !== null) {
        node.readyAtMs = null;
        node.claimedBy = 0;
        this.pendingNodeSync.push(node.id);
        count++;
      }
    }
    return count;
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
      /** Material ids already in the codex (P10) — first-gather dedupe. */
      codexSeen?: Set<string>;
    };
    /** Persisted gathering professions (P10); absent = all four at level 1. */
    professions?: readonly { profession: string; level: number; xp: number }[];
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
    player.professions = createProfessions(spec.professions ?? []);
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

  /** Gather intents (P10) ride the tick like item drags do. */
  private readonly pendingGatherOps: { playerId: number; op: GatherOp }[] = [];

  queueGatherOp(playerId: number, op: GatherOp): void {
    if (this.pendingGatherOps.length > 256) return;
    this.pendingGatherOps.push({ playerId, op });
  }

  /** Interact/quest intents (P11). Applied at the top of the next tick, so
   * their effects and events ride the normal flush rather than landing
   * mid-tick — the same shape item and progression ops use. */
  queueInteractOp(playerId: number, op: InteractOp): void {
    if (this.pendingInteractOps.length > 256) return;
    this.pendingInteractOps.push({ playerId, op });
  }

  queueQuestOp(playerId: number, op: QuestOp): void {
    if (this.pendingQuestOps.length > 256) return;
    this.pendingQuestOps.push({ playerId, op });
  }

  private readonly pendingInteractOps: { playerId: number; op: InteractOp }[] = [];
  private readonly pendingQuestOps: { playerId: number; op: QuestOp }[] = [];

  /**
   * Step 0e: resolve the interaction and quest intents.
   *
   * Runs AFTER gathering so a player who pressed F on a node and F on a chest
   * in the same frame gets the node (the hold is the more specific verb), and
   * before the sim so a shrine hop moves them this tick rather than next.
   */
  private stepInteractions(nowMs: number, events: CombatEvent[]): void {
    // Walking away ends the conversation.
    //
    // `applyDialogueChoice` already refuses a choice pressed from out of range,
    // but nothing was closing a dialogue that was simply LEFT — so a panel
    // opened in Dawnhaven followed you to the far side of the island and stayed
    // pressable, which is exactly the "a dialogue is a remote control for an
    // NPC" failure the range check exists to prevent. Checked every tick for
    // the handful of players who have one open, not per op.
    for (const player of this.players.values()) {
      const open = player.dialogue;
      if (!open) continue;
      const npc = this.npcs.get(open.npcPlacementId);
      const object = this.interactables.get(open.npcPlacementId);
      const anchor = npc ?? object?.row;
      if (!anchor) continue;
      const m = player.movement;
      if (Math.hypot(anchor.x - m.x, anchor.z - m.z) <= INTERACT_RANGE_M + 1.5) continue;
      player.dialogue = null;
      events.push({ type: 'dialogue-dirty', playerId: player.id });
    }

    if (this.pendingInteractOps.length === 0 && this.pendingQuestOps.length === 0) return;
    const world: InteractWorld = {
      objects: this.interactables,
      npcs: this.npcs,
      content: { defs: this.questDefs() },
      nowMs,
    };
    const interacts = this.pendingInteractOps.splice(0);
    const questOps = this.pendingQuestOps.splice(0);
    for (const { playerId, op } of interacts) {
      const player = this.players.get(playerId);
      if (!player || player.dead) continue;
      const effects = emptyEffects();
      applyInteract(player, op, world, player.progress.gold, effects);
      this.applyInteractEffects(player, effects, events);
    }
    for (const { playerId, op } of questOps) {
      const player = this.players.get(playerId);
      if (!player) continue;
      const effects = emptyEffects();
      applyQuestOp(player, op, world, effects);
      this.applyInteractEffects(player, effects, events);
    }
  }

  /** Turn one step's decisions into world changes and outgoing events. */
  private applyInteractEffects(
    player: ServerPlayer,
    effects: InteractEffects,
    events: CombatEvent[],
  ): void {
    const itemDeps = {
      content: this.itemContent(),
      bags: this.lootBags,
      nowMs: Date.now(),
      events,
    };
    for (const entry of effects.loot) {
      // A chest rolls its table straight into the bag rather than dropping a
      // world bag: you opened it, it is yours, and a chest that spat a bag onto
      // the floor would be racing the friend standing next to you.
      const drops = rollLootTable(
        this.itemContent().lootTables,
        entry.lootTableId,
        1,
        { killerLevel: player.level },
        this.rng,
      );
      for (const drop of drops) {
        // `rollLootTable` only ever yields items and gold; the exhaustive
        // switch is the compiler's job, not a runtime branch nobody reaches.
        if (drop.kind === 'item') grantItem(player, drop.itemId, drop.qty, itemDeps);
        else grantGold(player, drop.qty, itemDeps);
      }
      // A chest is an INTERACT for quest purposes as well as a loot source.
      this.questEvent(player, { kind: 'interact', refId: entry.objectId }, events);
    }
    for (const notice of effects.notices) {
      if (notice.kind === 'interacted') {
        const object = this.interactables.get(notice.objectId);
        this.questEvent(
          player,
          object
            ? { kind: 'interact', refId: notice.objectId, tag: object.row.name }
            : { kind: 'interact', refId: notice.objectId },
          events,
        );
        continue;
      }
      events.push({
        type: 'interact-notice',
        playerId: player.id,
        objectId: notice.objectId,
        text: notice.text,
        kind: notice.kind,
      });
      if (notice.kind === 'attuned') {
        events.push({
          type: 'discovery',
          playerId: player.id,
          kind: 'shrine',
          refId: notice.objectId,
          label: notice.text,
        });
      }
    }
    if (effects.spendGold > 0) grantGold(player, -effects.spendGold, itemDeps);
    if (effects.teleport) {
      player.movement.x = effects.teleport.x;
      player.movement.z = effects.teleport.z;
      player.movement.y = this.terrain.heightAt(effects.teleport.x, effects.teleport.z);
    }
    for (const payout of effects.payouts) {
      if (payout.xp > 0) {
        awardXp(player, payout.xp, XpSource.Quest, this.progressionContent(), events);
      }
      if (payout.gold > 0) grantGold(player, payout.gold, itemDeps);
      for (const item of payout.items) grantItem(player, item.itemId, item.qty, itemDeps);
      events.push({
        type: 'quest-rewarded',
        playerId: player.id,
        questId: payout.questId,
        xp: payout.xp,
        gold: payout.gold,
        items: payout.items,
        title: payout.title,
      });
      // A turn-in is itself a TALK at that NPC, which is what lets a later
      // quest's "talk to Marla" step be satisfied by handing her the last one.
      const def = this.questDefs().get(payout.questId);
      const npc = def ? questTurnInNpc(def) : null;
      if (npc) this.questEvent(player, { kind: 'talk', refId: npc }, events);
    }
    // A TALK — and the DELIVER that rides on it. Delivery is an ACT: the
    // player hands the stack over, so the pack is checked and emptied here
    // rather than being credited by merely owning the items. A player who
    // turns up without them is told, not silently advanced.
    if (effects.talkedTo) {
      // Quests whose delivery came up short. They must be EXCLUDED from the
      // talk below, or the same event that refused them would advance them.
      const shortOfGoods = new Set<string>();
      for (const [questId, state] of player.quests) {
        if (state.status !== 'active') continue;
        const def = this.questDefs().get(questId);
        const step = def ? def.steps[state.step] : undefined;
        if (!def || !step || step.type !== 'deliver' || step.npcId !== effects.talkedTo) continue;
        if (countItem(player.items.inventory, step.itemId) < step.count) {
          shortOfGoods.add(questId);
          events.push({
            type: 'quest-notice',
            playerId: player.id,
            kind: 'refused',
            questId,
            text: 'missing_items',
          });
          continue;
        }
        takeItem(player, step.itemId, step.count, itemDeps);
      }
      this.questEvent(player, { kind: 'talk', refId: effects.talkedTo }, events, shortOfGoods);
    }
    for (const notice of effects.notices2) {
      events.push({
        type: 'quest-notice',
        playerId: player.id,
        kind: notice.kind,
        questId: notice.questId,
        text: notice.text,
      });
    }
    if (effects.questsDirty.length > 0) events.push({ type: 'quest-dirty', playerId: player.id });
    for (const objectId of effects.objectsDirty) {
      events.push({ type: 'interact-dirty', playerId: player.id, objectId });
    }
    if (effects.dialogueDirty) events.push({ type: 'dialogue-dirty', playerId: player.id });
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
   * Set a LIVING enemy's HP to a fraction of max (/ops/enemyhurt, P9). The GM
   * primitive that makes boss phases and self-shield thresholds reachable in a
   * verification run without a 90-second fight per beat. It drives HP only —
   * the phase walk, the announce and the shield all come out of the normal AI,
   * so what a run observes is the real mechanic and not a staged one.
   */
  queueEnemyHurt(typeId: string, fraction: number): number | null {
    let best: ServerEnemy | null = null;
    for (const enemy of this.enemies.values()) {
      if (enemy.def.id !== typeId || !enemy.alive) continue;
      // Ties go to the healthiest so repeated calls keep hitting the same one.
      if (!best || enemy.hp > best.hp) best = enemy;
    }
    if (!best) return null;
    this.pendingEnemyHurt.push({ enemyId: best.id, fraction });
    return best.id;
  }

  private readonly pendingEnemyHurt: { enemyId: number; fraction: number }[] = [];

  /**
   * Spawn a one-off wave of enemies (/ops/spawnwave, P9). The GM primitive
   * behind a world event, and how the load harness reaches the TECH_STACK
   * budget number — the published bestiary only stands up 51 enemies and the
   * budget is written for 150 active AI.
   *
   * The wave carries a synthetic spawner id that content does not contain, so
   * `onEnemyDeath` finds no spawner and files no respawn ticket: killing a
   * wave removes it for good, and a load run cannot leave the world permanently
   * heavier than the owner authored it.
   */
  queueSpawnWave(enemyId: string, count: number, x: number, z: number, radius: number): number {
    const def = this.content?.enemies.get(enemyId);
    if (!def) return 0;
    const spawner: SpawnerDef = {
      id: `ops_wave_${this.nextEntityId}`,
      x,
      z,
      radius,
      kind: radius > 0 ? 'area' : 'point',
      campTag: null,
      entries: [{ enemyId, count, level: null }],
      respawnMs: 0,
      nightOnly: false,
    };
    for (let i = 0; i < count; i++) this.spawnEnemy(spawner, def, this.rollLevel(def, null));
    return count;
  }

  /**
   * Teleport an online player to a world position (/ops/tp, P9). Reaching a
   * named camp or a boss arena is otherwise a two-minute walk in every smoke;
   * the drop is grounded on the terrain the server itself samples, so the
   * player lands legally rather than inside a hillside.
   */
  queueTeleport(name: string, x: number, z: number): boolean {
    for (const player of this.players.values()) {
      if (player.name.toLowerCase() !== name.toLowerCase()) continue;
      const m = player.movement;
      m.x = x;
      m.z = z;
      m.y = this.terrain.heightAt(x, z);
      m.vx = 0;
      m.vy = 0;
      m.vz = 0;
      m.grounded = true;
      m.swimming = false;
      m.fallPeakY = m.y;
      return true;
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

    // 0d. Gathering (P10). Intents first, then the in-flight holds, so a start
    // and its completion can never land in the same tick — a 3 s channel that
    // resolved instantly would be a duplication bug wearing a timer's clothes.
    // Fishing is NOT stepped here; it needs this tick's buttons (see step 1c).
    this.stepGathering(nowMs, events);
    // 0e. Interact + quest intents (P11) — after gathering so a frame that
    // pressed F at a node and a chest resolves the node, which is the more
    // specific verb; before the sim so a shrine hop lands this tick.
    this.stepInteractions(nowMs, events);
    for (const playerId of this.pendingQuestSync.splice(0)) {
      events.push({ type: 'quest-dirty', playerId });
    }
    for (const playerId of this.pendingDiscoverySync.splice(0)) {
      events.push({ type: 'discovery-dirty', playerId });
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
    // Enemy HP pokes land BEFORE the AI runs this tick, so the phase check
    // inside the AI sees the new fraction on the very next decision.
    for (const hurt of this.pendingEnemyHurt.splice(0)) {
      const target = this.enemies.get(hurt.enemyId);
      if (target && target.alive) {
        target.hp = Math.max(1, Math.round(target.maxHp * hurt.fraction));
        target.lastDamagedAtMs = nowMs;
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
    // The Reel bit for every intent consumed this tick, per player. The reel
    // is the one system driven by a HELD button, and sampling it once per tick
    // is a lossy resample of the client's command stream: a catch-up tick that
    // consumes two intents would throw one press away, and a starved tick
    // repeats the last one. Either way the server's marker drifts out of phase
    // with the bar the player is watching, and a bang-bang input around a
    // moving target turns a one-tick phase error into an oscillation that
    // never settles inside the catch zone. Measured before this: the same
    // strategy that lands 20/20 fish offline landed 0/12 through the server.
    const reelBits = new Map<number, boolean[]>();
    for (const player of this.players.values()) {
      const intents = player.takeInputsForTick();
      if (this.fishing.has(player.id)) {
        reelBits.set(
          player.id,
          intents.map((intent) => (intent.buttons & InputButton.Reel) !== 0),
        );
      }
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

    // 1c. Fishing (P10). It has to run AFTER the input phase, because the reel
    // is the only system driven by a HELD button: `player.heldButtons` is set
    // by `consumeInputs` in step 1, so stepping the bar before that scored the
    // player's press one tick late, every tick. The client draws its bar from
    // the press immediately and the server scored it from the press before —
    // two bars that slowly disagree, and a measured run showed the client at
    // 0.31 progress while the server sat at 0.04. "The marker is on the fish
    // and the game says you missed" is the worst thing this minigame can do.
    this.stepFishingSessions(nowMs, events, reelBits);

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
      // Once a second per player, staggered by id — walking into a place is not
      // a twitch event, and checking every zone AND every POI for every player
      // every tick is the kind of quadratic that only shows up on the VPS.
      //
      // Zone and POI checks are deliberately separate guards: gating discovery
      // on `zonePolys.length > 0` would mean a world with POIs but no zone
      // polygons never discovers anything, which is exactly what a fresh map
      // bake looks like before its zones are drawn.
      if (!player.dead && (this.tickCounter + player.id) % 20 === 0 && player.level > 0) {
        if (this.zonePolys.length > 0) this.checkZoneDiscovery(player, events);
        this.checkPoiDiscovery(player, events);
        this.questEvent(
          player,
          { kind: 'enter', x: player.movement.x, z: player.movement.z },
          events,
        );
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

  /**
   * Offer one world event to a player's quest log, and turn what it did into
   * combat events the gateway fans out.
   *
   * Every kill, item and interact comes through here. The fan-out is cheap on
   * purpose (a handful of quests × one active step each) rather than indexed —
   * an index of "which quests care about enemy_bog_blob" has to be rebuilt on
   * every accept and abandon, and being wrong there is a quest that silently
   * stops counting.
   */
  private questEvent(
    player: ServerPlayer,
    event: QuestEvent,
    events: CombatEvent[],
    skip?: ReadonlySet<string>,
  ): void {
    const defs = this.questDefs();
    if (defs.size === 0 || player.quests.size === 0) return;
    const outcome = applyQuestEvent(player.quests, { defs }, event, skip);
    if (outcome.touched.length === 0) return;
    events.push({ type: 'quest-progress', playerId: player.id, questIds: outcome.touched });
    for (const done of outcome.stepsCompleted) {
      events.push({
        type: 'quest-step',
        playerId: player.id,
        questId: done.questId,
        text: done.step.trackerText,
      });
    }
    for (const questId of outcome.completed) {
      events.push({ type: 'quest-complete', playerId: player.id, questId });
    }
    for (const hook of outcome.hooks) this.runQuestHook(player, hook, events);
  }

  /**
   * The whitelisted scripting hooks (QUESTS_POI §8). Deliberately a closed set:
   * every one of these is a dropdown in the quest editor, and the schema is
   * what stops "no arbitrary scripting in 0.1.0" being a promise nobody checks.
   */
  private runQuestHook(player: ServerPlayer, hook: QuestHook, events: CombatEvent[]): void {
    switch (hook.hook) {
      case 'spawnGroup': {
        const spawner = this.content?.spawners.find((entry) => entry.id === hook.spawnerId);
        if (!spawner) break;
        // The ambush behind step 2. Spawned through the ordinary path so the
        // enemies behave normally — a scripted spawn that produced special
        // enemies would be a second AI to keep correct.
        for (const entry of spawner.entries) {
          const def = this.content?.enemies.get(entry.enemyId);
          if (!def) continue;
          for (let i = 0; i < entry.count; i++) {
            this.spawnEnemy(spawner, def, this.rollLevel(def, entry.level));
          }
        }
        break;
      }
      case 'despawn': {
        for (const enemy of [...this.enemies.values()]) {
          if (enemy.campTag === hook.tag) this.removeEnemy(enemy);
        }
        break;
      }
      case 'toast':
        events.push({ type: 'quest-toast', playerId: player.id, text: hook.text });
        break;
      case 'playEmote':
        events.push({
          type: 'npc-emote',
          playerId: player.id,
          npcId: hook.npcId,
          clip: hook.clip,
        });
        break;
      case 'grantBuff':
        // Buffs come from the ability content the effect id names; an unknown
        // id is a content mistake the publish rail catches, so it is a no-op
        // here rather than a throw that would strand a quest mid-step.
        events.push({
          type: 'quest-buff',
          playerId: player.id,
          effectId: hook.effectId,
          durationMs: hook.durationMs,
        });
        break;
      default:
        break;
    }
  }

  /**
   * POI rings → first-entry discovery XP, banner and map reveal (P11,
   * WORLD.md §4.1).
   *
   * Uses the same `discoveryXp` curve zones do, scaled by the POI's own
   * `xpBasis`, so a vista at level 3 and a vista at level 20 are both worth
   * finding. Discovery is also a quest GATE (§5), so finding one can make a
   * hidden quest exist — which is why the event carries the id rather than
   * just a toast.
   */
  private checkPoiDiscovery(player: ServerPlayer, events: CombatEvent[]): void {
    if (this.pois.length === 0) return;
    for (const poi of poisEntered(this.pois, player, player.poisSeen)) {
      player.poisSeen.add(poi.id);
      const award = poiDiscoveryXp(
        poi.xpBasis,
        xpToNext(this.progressionContent().xpCurve, player.level),
      );
      awardXp(player, award, XpSource.Discovery, this.progressionContent(), events);
      events.push({
        type: 'discovery',
        playerId: player.id,
        kind: 'poi',
        refId: poi.id,
        label: poi.name,
        poiKind: poi.kind,
      });
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
    // Quest kill credit (P11): every TAGGED player, the same rule XP and loot
    // use — being paid experience for a kill but skipped for the quest counter
    // is the kind of inconsistency players notice within a minute.
    if (enemy.def.archetype !== 'dummy') {
      for (const playerId of killTaggers({
        damage: enemy.damageBy,
        healAssists: enemy.healAssists,
      })) {
        const tagger = this.players.get(playerId);
        if (!tagger) continue;
        const killEvent: QuestEvent = { kind: 'kill', refId: enemy.def.id };
        if (enemy.campTag) killEvent.tag = enemy.campTag;
        this.questEvent(tagger, killEvent, events);
      }
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
