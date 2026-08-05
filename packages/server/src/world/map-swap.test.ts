/**
 * Live map swap (A2 publish → `/ops/reload-map`).
 *
 * A publish replaces the ground under a running world. The three things that
 * must survive that are pinned here, because each of them, if it broke, would
 * only be noticed by a player falling through the world:
 *
 *  1. Players keep their x/z and get re-seated on the NEW ground.
 *  2. Enemies are re-seeded from the spawners against the new terrain — a camp
 *     authored on a hill that is now a bay has to move with it.
 *  3. Progress the player already earned (discovered zones) is not re-awarded.
 */

import { describe, expect, it } from 'vitest';
import {
  BASIC_COMBOS,
  defaultWorldSettings,
  defaultXpCurve,
  devTerrain,
  enemyDefSchema,
  flatTerrain,
  spawnerDefSchema,
} from '@dawned/shared';
import { World } from './world.js';
import type { GameContent } from '../content/loader.js';

const enemy = enemyDefSchema.parse({
  id: 'enemy_test_dummy',
  name: 'Dummy',
  archetype: 'grunt',
  rank: 'normal',
  levelMin: 1,
  levelMax: 1,
  modelRef: 'enemies_mushnub',
  abilities: [],
});

const spawner = spawnerDefSchema.parse({
  id: 'spawner_test',
  kind: 'area',
  x: 12,
  z: 12,
  radius: 4,
  entries: [{ enemyId: enemy.id, count: 3 }],
});

const content = (): GameContent => ({
  enemies: new Map([[enemy.id, enemy]]),
  spawners: [spawner],
  abilities: new Map(),
  abilityBySlot: new Map(),
  basicChains: BASIC_COMBOS,
  xpCurve: defaultXpCurve(),
  skillNodes: new Map(),
  items: new Map(),
  lootTables: new Map(),
  vendors: new Map(),
  worldSettings: defaultWorldSettings(),
});

let nextId = 1;
const addPlayer = (world: World, x: number, z: number) => {
  const player = world.addPlayer({
    characterId: nextId++,
    accountId: nextId,
    name: `Walker${nextId}`,
    classId: 'warrior',
    level: 5,
    appearance: {
      body: 'm',
      skin: 0,
      outfit: 'ranger',
      outfitTint: 0,
      hair: 'none',
      hairColor: 0,
      beard: false,
    },
    position: null,
    role: 'player',
    progression: {
      xp: 0,
      gold: 0,
      allocated: { str: 0, agi: 0, int: 0, vit: 0, end: 0 },
      unspentStatPoints: 0,
      unspentSkillPoints: 0,
      nodeRanks: new Map(),
      zonesSeen: new Set(),
    },
  });
  player.movement.x = x;
  player.movement.z = z;
  return player;
};

describe('applyMap', () => {
  it('re-seats players on the new ground without moving them horizontally', () => {
    const world = new World(flatTerrain(0), { x: 0, y: 0, z: 0, yaw: 0 }, content());
    const player = addPlayer(world, 40, -25);

    world.applyMap({ terrain: flatTerrain(31), spawn: { x: 0, y: 31, z: 0, yaw: 0 }, zones: [] });

    expect(player.movement.x).toBe(40);
    expect(player.movement.z).toBe(-25);
    expect(player.movement.y).toBe(31);
  });

  it('re-seeds enemies from the spawners against the new terrain', () => {
    const world = new World(flatTerrain(0), { x: 0, y: 0, z: 0, yaw: 0 }, content());
    const before = [...world.enemies.values()];
    expect(before).toHaveLength(3);
    expect(before.every((e) => e.y === 0)).toBe(true);

    const summary = world.applyMap({
      terrain: flatTerrain(17),
      spawn: { x: 0, y: 17, z: 0, yaw: 0 },
      zones: [],
    });

    expect(summary.enemies).toBe(3);
    const after = [...world.enemies.values()];
    // Fresh entities, not the old ones nudged: a republish is a re-population.
    expect(after.some((e) => before.includes(e))).toBe(false);
    expect(after.every((e) => e.y === 17)).toBe(true);
  });

  it('keeps zones the player already discovered (a republish is not currency)', () => {
    const world = new World(devTerrain, { x: 0, y: 0, z: 0, yaw: 0 }, content());
    const player = addPlayer(world, 0, 0);
    player.progress.zonesSeen.add('zone_dawnshore');

    world.applyMap({ terrain: devTerrain, spawn: { x: 0, y: 0, z: 0, yaw: 0 }, zones: [] });

    expect(player.progress.zonesSeen.has('zone_dawnshore')).toBe(true);
  });
});
