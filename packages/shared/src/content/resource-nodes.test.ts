/**
 * Resource-node content rules. `rollGather` is the one function the server, the
 * tests and the panel's gathering preview all call, so a preview that shows a
 * different distribution from the live drop would be a bug in exactly one
 * place — here.
 */

import { describe, expect, it } from 'vitest';
import {
  nodePlacementSchema,
  nodeItemRefs,
  pickWeighted,
  resourceNodeDefSchema,
  rollGather,
  validateResourceNodeDef,
  type ResourceNodeDef,
} from './resource-nodes.js';
import { GATHER_CHANNEL_MS } from '../formulas/professions.js';

const birch = (over: Record<string, unknown> = {}): ResourceNodeDef =>
  validateResourceNodeDef({
    id: 'node_woodcutting_birch',
    name: 'Birch',
    profession: 'woodcutting',
    tier: 1,
    modelRef: 'nature_tree_birch',
    yields: [{ itemId: 'item_material_birchwood_logs', qtyMin: 1, qtyMax: 3 }],
    ...over,
  });

describe('the definition schema', () => {
  it('fills the design defaults so a minimal row is complete', () => {
    const def = birch();
    expect(def.channelMs).toBe(GATHER_CHANNEL_MS);
    expect(def.respawnMs).toBe(120_000);
    expect(def.procs).toEqual([]);
    expect(def.depletedModelRef).toBeNull();
    expect(def.bonusRolls).toBe(0);
  });

  it('refuses an id that is not a node slug', () => {
    expect(() => birch({ id: 'birch' })).toThrow();
    expect(() => birch({ id: 'enemy_birch' })).toThrow();
  });

  it('refuses a node that yields nothing — an empty node is a bug, not content', () => {
    expect(() => birch({ yields: [] })).toThrow();
  });

  it('refuses a backwards quantity range', () => {
    expect(() =>
      birch({ yields: [{ itemId: 'item_material_birchwood_logs', qtyMin: 5, qtyMax: 2 }] }),
    ).toThrow();
  });

  it('refuses a yield that does not name an item id', () => {
    expect(() => birch({ yields: [{ itemId: 'birchwood', qtyMin: 1, qtyMax: 1 }] })).toThrow();
  });

  it('refuses a tier outside T1–T5', () => {
    expect(() => birch({ tier: 0 })).toThrow();
    expect(() => birch({ tier: 6 })).toThrow();
  });

  it('is strict — a typo in a field name is caught, not stored', () => {
    expect(() => birch({ respawnMS: 1000 })).toThrow();
  });

  it('lists every item a node can ever produce', () => {
    const def = birch({
      procs: [{ itemId: 'item_material_resin', qtyMin: 1, qtyMax: 1 }],
    });
    expect(nodeItemRefs(def)).toEqual(['item_material_birchwood_logs', 'item_material_resin']);
  });
});

describe('the placement schema', () => {
  it('is thin — an id, a definition and a spot', () => {
    const placement = nodePlacementSchema.parse({
      id: 'node_2015_2152',
      nodeId: 'node_woodcutting_birch',
      x: 12,
      z: -30,
    });
    expect(placement.rotation).toBe(0);
    expect(placement.scale).toBe(1);
  });

  it('refuses a placement pointing at something that is not a node', () => {
    expect(() =>
      nodePlacementSchema.parse({ id: 'p1', nodeId: 'item_wood', x: 0, z: 0 }),
    ).toThrow();
  });
});

describe('pickWeighted', () => {
  const entries = [
    { id: 'a', weight: 1 },
    { id: 'b', weight: 3 },
  ];

  it('splits the range in proportion to the weights', () => {
    expect(pickWeighted(entries, 0)?.id).toBe('a');
    expect(pickWeighted(entries, 0.24)?.id).toBe('a');
    expect(pickWeighted(entries, 0.26)?.id).toBe('b');
    expect(pickWeighted(entries, 0.99)?.id).toBe('b');
  });

  it('answers null for an empty pool rather than throwing at a caller', () => {
    expect(pickWeighted([], 0.5)).toBeNull();
  });

  it('survives a roll that came back out of range', () => {
    expect(pickWeighted(entries, -1)?.id).toBe('a');
    expect(pickWeighted(entries, 5)?.id).toBe('b');
  });
});

describe('rollGather', () => {
  const rolls = { yieldPick: 0, yieldQty: 0, proc: 1, procPick: 0, procQty: 0 };

  it('always gives the ordinary yield — gathering never fails a roll', () => {
    const result = rollGather(birch(), rolls, 0);
    expect(result.yields).toEqual([{ itemId: 'item_material_birchwood_logs', qty: 1 }]);
    expect(result.proc).toBeNull();
  });

  it('rolls the quantity across the whole declared range', () => {
    const def = birch();
    expect(rollGather(def, { ...rolls, yieldQty: 0 }, 0).yields[0]?.qty).toBe(1);
    expect(rollGather(def, { ...rolls, yieldQty: 0.5 }, 0).yields[0]?.qty).toBe(2);
    expect(rollGather(def, { ...rolls, yieldQty: 0.999 }, 0).yields[0]?.qty).toBe(3);
  });

  it('drops the proc when the roll lands under the rate', () => {
    const def = birch({ procs: [{ itemId: 'item_material_resin', qtyMin: 1, qtyMax: 1 }] });
    expect(rollGather(def, { ...rolls, proc: 0.01 }, 0.05).proc).toEqual({
      itemId: 'item_material_resin',
      qty: 1,
    });
    expect(rollGather(def, { ...rolls, proc: 0.5 }, 0.05).proc).toBeNull();
  });

  it('cannot proc a node with no proc table, whatever the rate', () => {
    expect(rollGather(birch(), { ...rolls, proc: 0 }, 1).proc).toBeNull();
  });

  it('picks between several yields by weight', () => {
    const vein = birch({
      id: 'node_mining_copper',
      profession: 'mining',
      yields: [
        { itemId: 'item_material_copper_ore', qtyMin: 1, qtyMax: 1, weight: 1 },
        { itemId: 'item_material_stone', qtyMin: 1, qtyMax: 1, weight: 3 },
      ],
    });
    expect(rollGather(vein, { ...rolls, yieldPick: 0.1 }, 0).yields[0]?.itemId).toBe(
      'item_material_copper_ore',
    );
    expect(rollGather(vein, { ...rolls, yieldPick: 0.9 }, 0).yields[0]?.itemId).toBe(
      'item_material_stone',
    );
  });
});

describe('the shape of a real catalogue row', () => {
  it('round-trips through the schema unchanged', () => {
    const def = validateResourceNodeDef({
      id: 'node_mining_copper_vein',
      name: 'Copper Vein',
      profession: 'mining',
      tier: 1,
      modelRef: 'nature_rock_copper',
      depletedModelRef: 'nature_rock_cracked',
      yields: [
        { itemId: 'item_material_copper_ore', qtyMin: 1, qtyMax: 2, weight: 3 },
        { itemId: 'item_material_stone', qtyMin: 1, qtyMax: 3, weight: 1 },
      ],
      procs: [{ itemId: 'item_material_rough_gem', qtyMin: 1, qtyMax: 1, weight: 1 }],
      channelMs: 3000,
      respawnMs: 150_000,
      radius: 1.4,
      bonusRolls: 1,
    });
    expect(resourceNodeDefSchema.parse(JSON.parse(JSON.stringify(def)))).toEqual(def);
  });
});
