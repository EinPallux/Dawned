/**
 * The authoritative world.
 *
 * P0 scope: players moving on the dev terrain. AOI/interest management arrives in
 * P3, combat entities in P4 — the tick order below already reserves their slots so
 * the shape doesn't churn later (docs/tech/ARCHITECTURE.md §3).
 */

import {
  EntityKind,
  TICK_DT,
  WORLD_BOUNDS,
  devTerrain,
  stepMovement,
  type Appearance,
  type ClassId,
  type MovementStepResult,
  type RosterEntry,
  type SnapshotEntity,
  type TerrainSampler,
} from '@dawned/shared';
import { ServerPlayer } from './player.js';

/** AOI radii (docs/tech/NETWORKING.md §5): 3×3 of 64 m cells ≈ 96 m, +8 m leave margin. */
const AOI_ENTER_SQ = 96 * 96;
const AOI_LEAVE_SQ = 104 * 104;
const AOI_ENTITY_CAP = 80;

export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface WorldEvent {
  type: 'fall-damage';
  playerId: number;
  fraction: number;
  distance: number;
}

export class World {
  private readonly players = new Map<number, ServerPlayer>();
  private nextEntityId = 1;

  constructor(
    private readonly terrain: TerrainSampler = devTerrain,
    private readonly spawn: SpawnPoint = { x: 0, y: 0, z: 0, yaw: 0 },
  ) {}

  get playerCount(): number {
    return this.players.size;
  }

  get entityCount(): number {
    // Players only in P0; enemies/props join this count from P4/P9.
    return this.players.size;
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

  /** Spawn ring around the map's spawn point so players don't stack on login. */
  private spawnPosition(): SpawnPoint {
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
  }): ServerPlayer {
    const id = this.nextEntityId++;
    // A stale persisted position (map changed underneath it — e.g. the P1 flat
    // world became the P2 island) relocates to spawn instead of stranding the
    // character in deep water or inside a cliff.
    const persisted = spec.position && this.isValidPersisted(spec.position) ? spec.position : null;
    const spawn = persisted ?? this.spawnPosition();
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
    );
    this.players.set(id, player);
    return player;
  }

  removePlayer(id: number): void {
    this.players.delete(id);
    // Nobody keeps interest in a despawned entity (ids are never reused, but
    // the visibility sets should not grow without bound).
    for (const player of this.players.values()) player.visible.delete(id);
  }

  /** Advance the world one tick. Returns events the gateway should broadcast. */
  step(): WorldEvent[] {
    const events: WorldEvent[] = [];

    // 1. Movement — re-simulated from client intents with the shared step function.
    for (const player of this.players.values()) {
      const intents = player.takeInputsForTick();
      for (const intent of intents) {
        const result: MovementStepResult = stepMovement(
          player.movement,
          intent,
          TICK_DT,
          this.terrain,
        );
        if (result.fallDamageFraction > 0) {
          events.push({
            type: 'fall-damage',
            playerId: player.id,
            fraction: result.fallDamageFraction,
            distance: result.fallDistance,
          });
        }
      }
    }

    // 2. [P4] ability pipeline, projectiles, effect ticks.
    // 3. [P9] AI decisions and enemy movement.
    // 4. [P8/P10] loot bags, resource node timers.
    // 5. [P3] AOI update — until then every player sees every other player.

    return events;
  }

  /**
   * Interest management (docs/tech/NETWORKING.md §5): entities within ~96 m
   * enter the viewer's set, and only leave past 104 m (+8 m hysteresis, no
   * border flicker). Per-viewer cap of 80, nearest first.
   *
   * The scan is a direct O(players²) distance pass — at ≤50 players that is
   * ~2.5k squared-distance checks per tick. The spatial hash grid slots in
   * here when P9's enemies raise entity counts an order of magnitude.
   */
  entitiesFor(viewer: ServerPlayer, out: SnapshotEntity[]): SnapshotEntity[] {
    out.length = 0;
    const vm = viewer.movement;
    const candidates: { player: ServerPlayer; distSq: number }[] = [];
    for (const player of this.players.values()) {
      if (player.id === viewer.id) continue;
      const m = player.movement;
      const distSq = (m.x - vm.x) ** 2 + (m.z - vm.z) ** 2;
      const wasVisible = viewer.visible.has(player.id);
      const limit = wasVisible ? AOI_LEAVE_SQ : AOI_ENTER_SQ;
      if (distSq <= limit) {
        candidates.push({ player, distSq });
      } else if (wasVisible) {
        viewer.visible.delete(player.id);
      }
    }
    if (candidates.length > AOI_ENTITY_CAP) {
      candidates.sort((a, b) => a.distSq - b.distSq);
      for (const dropped of candidates.splice(AOI_ENTITY_CAP)) {
        viewer.visible.delete(dropped.player.id);
      }
    }
    for (const { player } of candidates) {
      viewer.visible.add(player.id);
      const m = player.movement;
      out.push({
        id: player.id,
        kind: EntityKind.Player,
        x: m.x,
        y: m.y,
        z: m.z,
        yaw: m.yaw,
        flags: player.flags,
      });
    }
    return out;
  }

  /** `/stuck` and future GM recalls: back to the spawn ring, cleanly grounded. */
  teleportToSpawn(player: ServerPlayer): void {
    const spawn = this.spawnPosition();
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
