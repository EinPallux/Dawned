/**
 * The authoritative world.
 *
 * P0 scope: players moving on the dev terrain. AOI/interest management arrives in
 * P3, combat entities in P4 — the tick order below already reserves their slots so
 * the shape doesn't churn later (docs/tech/ARCHITECTURE.md §3).
 */

import {
  TICK_DT,
  devTerrain,
  stepMovement,
  type MovementStepResult,
  type SnapshotEntity,
  type TerrainSampler,
} from '@dawned/shared';
import { ServerPlayer } from './player.js';

export interface WorldEvent {
  type: 'fall-damage';
  playerId: number;
  fraction: number;
  distance: number;
}

export class World {
  private readonly players = new Map<number, ServerPlayer>();
  private nextEntityId = 1;

  constructor(private readonly terrain: TerrainSampler = devTerrain) {}

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

  hasName(name: string): boolean {
    const lowered = name.toLowerCase();
    for (const player of this.players.values()) {
      if (player.name.toLowerCase() === lowered) return true;
    }
    return false;
  }

  /** Spawn point: a ring around the hill so players don't stack on login. */
  private spawnPosition(): { x: number; y: number; z: number } {
    const angle = (this.nextEntityId * 2.399963) % (Math.PI * 2); // golden-angle spread
    const radius = 18;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    return { x, y: this.terrain.heightAt(x, z), z };
  }

  addPlayer(name: string): ServerPlayer {
    const id = this.nextEntityId++;
    const spawn = this.spawnPosition();
    const player = new ServerPlayer(id, name, spawn.x, spawn.y, spawn.z);
    this.players.set(id, player);
    return player;
  }

  removePlayer(id: number): void {
    this.players.delete(id);
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

  /** Build the entity list visible to `viewer` (everyone else, pre-AOI). */
  entitiesFor(viewer: ServerPlayer, out: SnapshotEntity[]): SnapshotEntity[] {
    out.length = 0;
    for (const player of this.players.values()) {
      if (player.id === viewer.id) continue;
      const m = player.movement;
      out.push({ id: player.id, x: m.x, y: m.y, z: m.z, yaw: m.yaw, flags: player.flags });
    }
    return out;
  }

  roster(): { id: number; name: string }[] {
    return Array.from(this.players.values(), (player) => ({ id: player.id, name: player.name }));
  }
}
