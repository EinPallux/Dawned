/**
 * Node runtime rules (P10-B). The one that earns its keep is §1.1's **first
 * tap**: two players, one tree, and exactly one set of logs. Everything else
 * here exists because gathering writes items into a bag, and anything that
 * writes items is a place duplication can happen.
 */

import { describe, expect, it } from 'vitest';
import {
  GATHER_BREAK_RANGE_M,
  GatherRefusal,
  validateResourceNodeDef,
  type NodePlacement,
  type ResourceNodeDef,
} from '@dawned/shared';
import {
  buildNodes,
  channelBreak,
  finishGather,
  nodeInReach,
  nodesNear,
  releaseClaim,
  respawnNodes,
  startGather,
  type ServerNode,
} from './nodes.js';
import type { ServerPlayer } from './player.js';

const BIRCH: ResourceNodeDef = validateResourceNodeDef({
  id: 'node_woodcutting_birch',
  name: 'Birch',
  profession: 'woodcutting',
  tier: 1,
  modelRef: 'nature_tree_birch',
  yields: [{ itemId: 'item_material_birchwood_logs', qtyMin: 1, qtyMax: 1 }],
  respawnMs: 120_000,
});

const OAK: ResourceNodeDef = validateResourceNodeDef({
  id: 'node_woodcutting_oak',
  name: 'Wealdoak',
  profession: 'woodcutting',
  tier: 2,
  modelRef: 'nature_tree_oak',
  yields: [{ itemId: 'item_material_wealdoak_logs', qtyMin: 1, qtyMax: 1 }],
});

const placement = (id: string, nodeId: string, x = 0, z = 0): NodePlacement => ({
  id,
  nodeId,
  x,
  z,
  rotation: 0,
  scale: 1,
});

/** Just enough of a player for the node rules to read. */
const fakePlayer = (id: number, x = 0, z = 0): ServerPlayer =>
  ({
    id,
    dead: false,
    lastCombatAtMs: 0,
    movement: { x, y: 0, z },
  }) as unknown as ServerPlayer;

const node = (over: Partial<ServerNode> = {}): ServerNode => ({
  id: 'n1',
  nodeId: BIRCH.id,
  x: 0,
  y: 0,
  z: 0,
  readyAtMs: null,
  claimedBy: 0,
  ...over,
});

const defs = new Map([
  [BIRCH.id, BIRCH],
  [OAK.id, OAK],
]);

describe('buildNodes', () => {
  it('seats every placement on the ground', () => {
    const built = buildNodes(
      [placement('a', BIRCH.id, 10, 20), placement('b', BIRCH.id, -4, 8)],
      { defs },
      () => 7,
    );
    expect(built.nodes.size).toBe(2);
    expect(built.nodes.get('a')?.y).toBe(7);
    expect(built.orphans).toEqual([]);
  });

  /**
   * A placement whose definition is gone means the map and the content drifted
   * between two publishes. Refusing to boot over one stale rock would turn a
   * content typo into an outage, so it is counted and dropped.
   */
  it('drops a placement whose definition is gone, and counts it', () => {
    const built = buildNodes(
      [placement('a', BIRCH.id), placement('b', 'node_mining_ghost')],
      { defs },
      () => 0,
    );
    expect(built.nodes.size).toBe(1);
    expect(built.orphans).toEqual(['node_mining_ghost']);
  });
});

describe('finding a node', () => {
  const nodes = new Map([
    ['near', node({ id: 'near', x: 1, z: 0 })],
    ['far', node({ id: 'far', x: 60, z: 0 })],
  ]);

  it('answers the closest one within interact range', () => {
    expect(nodeInReach(nodes, fakePlayer(1, 0, 0))?.id).toBe('near');
  });

  it('answers nothing when you are standing nowhere near one', () => {
    expect(nodeInReach(nodes, fakePlayer(1, 30, 30))).toBeNull();
  });

  it('filters by radius for the AOI sync', () => {
    expect(nodesNear(nodes, 0, 0, 10).map((entry) => entry.id)).toEqual(['near']);
    expect(nodesNear(nodes, 0, 0, 100)).toHaveLength(2);
  });
});

describe('starting a gather', () => {
  it('claims a standing node in range at the right level', () => {
    const target = node();
    const result = startGather(fakePlayer(1), target, BIRCH, 1, 1000, false);
    expect(result.ok).toBe(true);
    expect(target.claimedBy).toBe(1);
    expect(result.channel?.endsAtMs).toBe(1000 + BIRCH.channelMs);
  });

  it('refuses a node that is not there', () => {
    expect(startGather(fakePlayer(1), undefined, undefined, 1, 0, false).refusal).toBe(
      GatherRefusal.Unknown,
    );
  });

  it('refuses a depleted node', () => {
    const target = node({ readyAtMs: 50_000 });
    expect(startGather(fakePlayer(1), target, BIRCH, 1, 1000, false).refusal).toBe(
      GatherRefusal.Depleted,
    );
  });

  it('refuses a tier above the gate', () => {
    expect(startGather(fakePlayer(1), node(), OAK, 1, 0, false).refusal).toBe(
      GatherRefusal.TierLocked,
    );
    expect(startGather(fakePlayer(1), node(), OAK, 7, 0, false).ok).toBe(true);
  });

  it('refuses from out of range', () => {
    expect(startGather(fakePlayer(1, 40, 0), node(), BIRCH, 1, 0, false).refusal).toBe(
      GatherRefusal.TooFar,
    );
  });

  it('refuses while the character is busy', () => {
    expect(startGather(fakePlayer(1), node(), BIRCH, 1, 0, true).refusal).toBe(GatherRefusal.Busy);
  });

  it('speeds the channel up four levels past the gate', () => {
    const fast = startGather(fakePlayer(1), node(), BIRCH, 5, 0, false);
    expect(fast.channel?.endsAtMs).toBe(Math.round(BIRCH.channelMs * 0.75));
  });
});

/** §1.1 first tap — the rule that stops one tree paying twice. */
describe('two players, one tree', () => {
  it('gives the node to whoever started, and tells the other one immediately', () => {
    const tree = node();
    const first = startGather(fakePlayer(1), tree, BIRCH, 1, 0, false);
    expect(first.ok).toBe(true);

    const second = startGather(fakePlayer(2), tree, BIRCH, 1, 10, false);
    expect(second.ok).toBe(false);
    expect(second.refusal).toBe(GatherRefusal.Claimed);
    // Refused UP FRONT, not after three seconds of holding: being told you
    // lost before you start is information, being told at the end is a waste.
    expect(tree.claimedBy).toBe(1);
  });

  it('frees the node for the loser once the winner lets go', () => {
    const tree = node();
    startGather(fakePlayer(1), tree, BIRCH, 1, 0, false);
    releaseClaim(tree, 1);
    expect(startGather(fakePlayer(2), tree, BIRCH, 1, 10, false).ok).toBe(true);
    expect(tree.claimedBy).toBe(2);
  });

  it('ignores a release from someone who never held it', () => {
    const tree = node({ claimedBy: 1 });
    releaseClaim(tree, 2);
    expect(tree.claimedBy).toBe(1);
  });

  it('lets the same player re-start on the node they already hold', () => {
    const tree = node();
    startGather(fakePlayer(1), tree, BIRCH, 1, 0, false);
    expect(startGather(fakePlayer(1), tree, BIRCH, 1, 10, false).ok).toBe(true);
  });
});

describe('breaking a channel', () => {
  const channel = {
    placementId: 'n1',
    nodeId: BIRCH.id,
    profession: 'woodcutting' as const,
    tier: 1,
    startedAtMs: 1000,
    endsAtMs: 4000,
    originX: 0,
    originZ: 0,
  };

  it('holds while nothing happens', () => {
    expect(channelBreak(channel, fakePlayer(1), node())).toBeNull();
  });

  it('breaks when the player walks off', () => {
    const wanderer = fakePlayer(1, GATHER_BREAK_RANGE_M + 1, 0);
    expect(channelBreak(channel, wanderer, node())).toBe(GatherRefusal.TooFar);
  });

  it('tolerates standing-still jitter inside the break radius', () => {
    expect(channelBreak(channel, fakePlayer(1, 0.4, 0.4), node())).toBeNull();
  });

  it('breaks on damage taken during the hold', () => {
    const hurt = fakePlayer(1);
    hurt.lastCombatAtMs = channel.startedAtMs + 200;
    expect(channelBreak(channel, hurt, node())).toBe(GatherRefusal.Busy);
  });

  it('ignores damage taken BEFORE the hold started', () => {
    const hurt = fakePlayer(1);
    hurt.lastCombatAtMs = channel.startedAtMs - 5000;
    expect(channelBreak(channel, hurt, node())).toBeNull();
  });

  it('breaks when the player dies', () => {
    const corpse = fakePlayer(1);
    corpse.dead = true;
    expect(channelBreak(channel, corpse, node())).toBe(GatherRefusal.Busy);
  });

  it('breaks when the node vanished under it (a map swap)', () => {
    expect(channelBreak(channel, fakePlayer(1), undefined)).toBe(GatherRefusal.Unknown);
  });
});

describe('finishing a gather', () => {
  const rolls = { yieldPick: 0, yieldQty: 0, proc: 1, procPick: 0, procQty: 0 };

  it('always yields, and schedules the regrowth', () => {
    const award = finishGather(BIRCH, 1, rolls, 10_000);
    expect(award.yields).toEqual([{ itemId: 'item_material_birchwood_logs', qty: 1 }]);
    expect(award.readyAtMs).toBe(10_000 + BIRCH.respawnMs);
    expect(award.profXp).toBe(12);
  });

  it('halves the XP once the tier is back country', () => {
    expect(finishGather(BIRCH, 13, rolls, 0).profXp).toBe(6);
  });

  it('rolls the proc against the level-scaled rate', () => {
    const withProc = validateResourceNodeDef({
      ...BIRCH,
      procs: [{ itemId: 'item_material_resin', qtyMin: 1, qtyMax: 1 }],
    });
    // 3% at level 0 — a 0.02 roll lands, a 0.9 roll does not.
    expect(finishGather(withProc, 1, { ...rolls, proc: 0.02 }, 0).proc).not.toBeNull();
    expect(finishGather(withProc, 1, { ...rolls, proc: 0.9 }, 0).proc).toBeNull();
  });
});

describe('respawning', () => {
  it('brings back only what is due, and reports which', () => {
    const nodes = new Map([
      ['due', node({ id: 'due', readyAtMs: 900 })],
      ['later', node({ id: 'later', readyAtMs: 5000 })],
      ['standing', node({ id: 'standing' })],
    ]);
    expect(respawnNodes(nodes, 1000)).toEqual(['due']);
    expect(nodes.get('due')?.readyAtMs).toBeNull();
    expect(nodes.get('later')?.readyAtMs).toBe(5000);
  });

  it('clears any stale claim with the regrowth', () => {
    const nodes = new Map([['due', node({ id: 'due', readyAtMs: 0, claimedBy: 7 })]]);
    respawnNodes(nodes, 1000);
    expect(nodes.get('due')?.claimedBy).toBe(0);
  });
});
