/**
 * Gathering end to end through the real tick (P10-B).
 *
 * `nodes.test.ts` pins the rules in isolation; this drives them through
 * `World.step()` with a real bag and a real XP path, because the interesting
 * failures live in the wiring: a hold that resolves in the same tick it
 * started, a yield that never reaches the pack, a claim that survives the
 * player who took it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BASIC_COMBOS,
  GATHER_CHANNEL_MS,
  GatherRefusal,
  defaultWorldSettings,
  defaultXpCurve,
  devTerrain,
  validateItemDef,
  validateResourceNodeDef,
  type ItemDef,
  type NodePlacement,
  type ResourceNodeDef,
} from '@dawned/shared';
import { World } from './world.js';
import type { GameContent } from '../content/loader.js';
import type { CombatEvent } from './combat.js';
import type { ServerPlayer } from './player.js';

const LOGS: ItemDef = validateItemDef({
  id: 'item_material_birchwood_logs',
  name: 'Birchwood Logs',
  category: 'material',
  rarity: 'common',
  icon: 'wood-pile',
  stack: 50,
  value: 4,
});
const RESIN: ItemDef = validateItemDef({
  id: 'item_material_resin',
  name: 'Resin',
  category: 'material',
  rarity: 'uncommon',
  icon: 'dripping-honey',
  stack: 50,
  value: 12,
});

const BIRCH: ResourceNodeDef = validateResourceNodeDef({
  id: 'node_woodcutting_birch',
  name: 'Birch',
  profession: 'woodcutting',
  tier: 1,
  modelRef: 'nature_tree_birch',
  yields: [{ itemId: LOGS.id, qtyMin: 2, qtyMax: 2 }],
  procs: [{ itemId: RESIN.id, qtyMin: 1, qtyMax: 1 }],
  respawnMs: 120_000,
});
const OAK: ResourceNodeDef = validateResourceNodeDef({
  id: 'node_woodcutting_oak',
  name: 'Wealdoak',
  profession: 'woodcutting',
  tier: 2,
  modelRef: 'nature_tree_oak',
  yields: [{ itemId: LOGS.id, qtyMin: 1, qtyMax: 1 }],
});

const testContent = (): GameContent => ({
  enemies: new Map(),
  spawners: [],
  abilities: new Map(),
  abilityBySlot: new Map(),
  basicChains: BASIC_COMBOS,
  xpCurve: defaultXpCurve(),
  skillNodes: new Map(),
  items: new Map([
    [LOGS.id, LOGS],
    [RESIN.id, RESIN],
  ]),
  lootTables: new Map(),
  vendors: new Map(),
  resourceNodes: new Map([
    [BIRCH.id, BIRCH],
    [OAK.id, OAK],
  ]),
  quests: new Map(),
  npcs: new Map(),
  worldSettings: defaultWorldSettings(),
});

const PLACEMENTS: NodePlacement[] = [
  { id: 'birch_1', nodeId: BIRCH.id, x: 0, z: 0, rotation: 0, scale: 1 },
  { id: 'oak_1', nodeId: OAK.id, x: 2, z: 0, rotation: 0, scale: 1 },
];

/** Rolls come from the world's rng; 0.5 lands mid-range and misses the 3% proc. */
const makeWorld = (rng = () => 0.5): World =>
  new World(
    devTerrain,
    { x: 0, y: devTerrain.heightAt(0, 0), z: 0, yaw: 0 },
    testContent(),
    rng,
    [],
    PLACEMENTS,
  );

let nextCharacterId = 1;
const addPlayer = (world: World, at = { x: 0, z: 0 }, name = 'Chopper'): ServerPlayer => {
  const player = world.addPlayer({
    characterId: nextCharacterId++,
    accountId: nextCharacterId,
    name,
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
  });
  player.movement.x = at.x;
  player.movement.z = at.z;
  return player;
};

const gatherEvents = (events: readonly CombatEvent[]) =>
  events.filter((event) => event.type === 'gather-state');

const bagOf = (player: ServerPlayer): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const stack of player.items.inventory.bag.values()) {
    counts[stack.itemId] = (counts[stack.itemId] ?? 0) + stack.qty;
  }
  return counts;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-05T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a gather from start to finish', () => {
  it('opens a hold, waits out the channel, then pays', () => {
    const world = makeWorld();
    const player = addPlayer(world);

    world.queueGatherOp(player.id, { kind: 'start', placementId: 'birch_1' });
    const opened = gatherEvents(world.step());
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ phase: 'start', placementId: 'birch_1', tier: 1 });

    // The very next tick must NOT finish it — a 3 s hold that resolves early
    // is a duplication bug wearing a timer's clothes.
    vi.advanceTimersByTime(50);
    expect(gatherEvents(world.step())).toHaveLength(0);
    expect(bagOf(player)).toEqual({});

    vi.advanceTimersByTime(GATHER_CHANNEL_MS);
    const done = gatherEvents(world.step());
    expect(done[0]).toMatchObject({ phase: 'done', nodeId: BIRCH.id, profXp: 12 });
    expect(bagOf(player)).toEqual({ [LOGS.id]: 2 });
    expect(world.nodes.get('birch_1')?.readyAtMs).not.toBeNull();
  });

  it('levels the profession, not the character sheet', () => {
    const world = makeWorld();
    const player = addPlayer(world);
    const before = player.professions.get('woodcutting')?.xp ?? -1;
    expect(before).toBe(0);

    world.queueGatherOp(player.id, { kind: 'start', placementId: 'birch_1' });
    world.step();
    vi.advanceTimersByTime(GATHER_CHANNEL_MS + 50);
    const events = world.step();

    expect(player.professions.get('woodcutting')?.xp).toBe(12);
    expect(player.professions.get('mining')?.xp).toBe(0);
    expect(events.some((event) => event.type === 'professions-dirty')).toBe(true);
    // The character trickle rides PROGRESSION.md's own formula (4 × tier).
    expect(events.some((event) => event.type === 'xp-gained')).toBe(true);
  });

  it('records a first-gathered material in the codex, once', () => {
    const world = makeWorld();
    const player = addPlayer(world);

    world.queueGatherOp(player.id, { kind: 'start', placementId: 'birch_1' });
    world.step();
    vi.advanceTimersByTime(GATHER_CHANNEL_MS + 50);
    const first = world.step();
    expect(first.filter((event) => event.type === 'discovery')).toHaveLength(1);

    world.respawnAllNodes();
    world.queueGatherOp(player.id, { kind: 'start', placementId: 'birch_1' });
    world.step();
    vi.advanceTimersByTime(GATHER_CHANNEL_MS + 50);
    const second = world.step();
    expect(second.filter((event) => event.type === 'discovery')).toHaveLength(0);
  });

  it('drops the proc when the roll lands under the rate', () => {
    // 0.001 is under the 3 % base chance, so the rare extra comes out too.
    const world = makeWorld(() => 0.001);
    const player = addPlayer(world);
    world.queueGatherOp(player.id, { kind: 'start', placementId: 'birch_1' });
    world.step();
    vi.advanceTimersByTime(GATHER_CHANNEL_MS + 50);
    const done = gatherEvents(world.step());
    expect(done[0]).toMatchObject({ proc: { itemId: RESIN.id, qty: 1 } });
    expect(bagOf(player)[RESIN.id]).toBe(1);
  });
});

describe('refusals reach the player as reasons', () => {
  it('refuses a tier above the gate', () => {
    const world = makeWorld();
    const player = addPlayer(world, { x: 2, z: 0 });
    world.queueGatherOp(player.id, { kind: 'start', placementId: 'oak_1' });
    expect(gatherEvents(world.step())[0]).toMatchObject({
      phase: 'refused',
      reason: GatherRefusal.TierLocked,
    });
  });

  it('refuses a node that is not in the world', () => {
    const world = makeWorld();
    const player = addPlayer(world);
    world.queueGatherOp(player.id, { kind: 'start', placementId: 'nope' });
    expect(gatherEvents(world.step())[0]).toMatchObject({ reason: GatherRefusal.Unknown });
  });

  it('refuses a node someone else is already holding', () => {
    const world = makeWorld();
    const first = addPlayer(world, { x: 0, z: 0 }, 'First');
    const second = addPlayer(world, { x: 1, z: 0 }, 'Second');

    world.queueGatherOp(first.id, { kind: 'start', placementId: 'birch_1' });
    world.step();
    world.queueGatherOp(second.id, { kind: 'start', placementId: 'birch_1' });
    const events = gatherEvents(world.step());
    const refusal = events.find((event) => event.playerId === second.id);
    expect(refusal).toMatchObject({ phase: 'refused', reason: GatherRefusal.Claimed });
  });

  /** Two players, one tree, exactly one set of logs — §1.1's first tap. */
  it('pays exactly one of two players racing for the same tree', () => {
    const world = makeWorld();
    const first = addPlayer(world, { x: 0, z: 0 }, 'First');
    const second = addPlayer(world, { x: 1, z: 0 }, 'Second');

    world.queueGatherOp(first.id, { kind: 'start', placementId: 'birch_1' });
    world.queueGatherOp(second.id, { kind: 'start', placementId: 'birch_1' });
    world.step();
    vi.advanceTimersByTime(GATHER_CHANNEL_MS + 50);
    world.step();

    const totals = [bagOf(first), bagOf(second)];
    const paid = totals.filter((bag) => (bag[LOGS.id] ?? 0) > 0);
    expect(paid).toHaveLength(1);
    expect(paid[0]?.[LOGS.id]).toBe(2);
  });
});

describe('a hold that does not survive', () => {
  it('cancels when the player walks away', () => {
    const world = makeWorld();
    const player = addPlayer(world);
    world.queueGatherOp(player.id, { kind: 'start', placementId: 'birch_1' });
    world.step();

    player.movement.x = 50;
    vi.advanceTimersByTime(200);
    const events = gatherEvents(world.step());
    expect(events[0]).toMatchObject({ phase: 'cancelled', reason: GatherRefusal.TooFar });

    // …and the tree is free for the next person rather than locked by a
    // channel that no longer exists.
    expect(world.nodes.get('birch_1')?.claimedBy).toBe(0);
    expect(world.nodes.get('birch_1')?.readyAtMs).toBeNull();
  });

  it('cancels on an explicit let-go and frees the claim', () => {
    const world = makeWorld();
    const player = addPlayer(world);
    world.queueGatherOp(player.id, { kind: 'start', placementId: 'birch_1' });
    world.step();
    world.queueGatherOp(player.id, { kind: 'cancel' });
    expect(gatherEvents(world.step())[0]).toMatchObject({ phase: 'cancelled' });
    expect(world.nodes.get('birch_1')?.claimedBy).toBe(0);
  });

  it('releases the claim when the player leaves the world', () => {
    const world = makeWorld();
    const player = addPlayer(world);
    world.queueGatherOp(player.id, { kind: 'start', placementId: 'birch_1' });
    world.step();
    expect(world.nodes.get('birch_1')?.claimedBy).toBe(player.id);

    world.releaseGather(player.id);
    expect(world.nodes.get('birch_1')?.claimedBy).toBe(0);
  });

  it('does not let one player hold two nodes at once', () => {
    const world = makeWorld();
    const player = addPlayer(world, { x: 1, z: 0 });
    // Level the profession so the oak is legal, then start on one and switch.
    world.setProfessionByName('Chopper', 'woodcutting', 10);
    world.queueGatherOp(player.id, { kind: 'start', placementId: 'birch_1' });
    world.step();
    world.queueGatherOp(player.id, { kind: 'start', placementId: 'oak_1' });
    world.step();

    expect(world.nodes.get('birch_1')?.claimedBy).toBe(0);
    expect(world.nodes.get('oak_1')?.claimedBy).toBe(player.id);
  });
});

describe('regrowth', () => {
  it('brings the node back when its timer runs out', () => {
    const world = makeWorld();
    const player = addPlayer(world);
    world.queueGatherOp(player.id, { kind: 'start', placementId: 'birch_1' });
    world.step();
    vi.advanceTimersByTime(GATHER_CHANNEL_MS + 50);
    world.step();
    expect(world.nodes.get('birch_1')?.readyAtMs).not.toBeNull();

    vi.advanceTimersByTime(BIRCH.respawnMs);
    const events = world.step();
    expect(world.nodes.get('birch_1')?.readyAtMs).toBeNull();
    expect(events.some((event) => event.type === 'nodes-dirty')).toBe(true);
  });

  it('reports the world total, taken and orphaned counts for ops', () => {
    const world = makeWorld();
    expect(world.nodeStats).toEqual({ total: 2, depleted: 0, orphans: 0 });
  });
});

describe('a map swap', () => {
  it('re-seeds the nodes from the new bake and drops the old ones', () => {
    const world = makeWorld();
    world.applyMap({
      terrain: devTerrain,
      spawn: { x: 0, y: 0, z: 0, yaw: 0 },
      zones: [],
      nodes: [{ id: 'birch_new', nodeId: BIRCH.id, x: 5, z: 5, rotation: 0, scale: 1 }],
    });
    expect([...world.nodes.keys()]).toEqual(['birch_new']);
  });

  it('leaves a world with no gathering alone rather than throwing', () => {
    const world = makeWorld();
    world.applyMap({ terrain: devTerrain, spawn: { x: 0, y: 0, z: 0, yaw: 0 }, zones: [] });
    expect(world.nodes.size).toBe(0);
  });
});
