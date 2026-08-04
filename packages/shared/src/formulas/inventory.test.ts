/**
 * Inventory transaction tests — including the fuzz storm the P8 DoD names
 * ("no dupes under parallel op storms"). The invariant under test: no plan
 * may change the total quantity of any item, except `planAdd`/`planRemove`,
 * which declare their delta.
 */

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { itemDefSchema, type ItemDef } from '../content/items.js';
import {
  INVENTORY_SLOTS,
  applyPlan,
  countItem,
  createInventory,
  firstFreeSlot,
  inventoryCensus,
  planAdd,
  planEquip,
  planMove,
  planRemove,
  planSort,
  planSplit,
  planUnequip,
  type InventoryMutation,
  type InventoryPlan,
  type InventoryState,
  type ItemStack,
} from './inventory.js';

/** Fixtures are written in the schema's INPUT shape (defaults fill the rest). */
const def = (raw: Partial<z.input<typeof itemDefSchema>> & { id: string }): ItemDef =>
  itemDefSchema.parse({
    name: raw.id,
    icon: `icon_${raw.id}`,
    ...raw,
  });

const SWORD = def({
  id: 'item_weapon_sword_test',
  category: 'weapon',
  slot: 'mainhand',
  ilvl: 5,
  classLock: ['warrior'],
  weapon: { dmgMin: 8, dmgMax: 12, twoHanded: false },
});
const STAFF = def({
  id: 'item_weapon_staff_test',
  category: 'weapon',
  slot: 'mainhand',
  ilvl: 5,
  classLock: ['mage'],
  weapon: { dmgMin: 6, dmgMax: 14, twoHanded: true },
});
const SHIELD = def({
  id: 'item_offhand_shield_test',
  category: 'offhand',
  slot: 'offhand',
  ilvl: 5,
  classLock: ['warrior'],
});
const RING = def({ id: 'item_jewelry_ring_test', category: 'jewelry', slot: 'ring', ilvl: 4 });
const POTION = def({
  id: 'item_consumable_potion_test',
  category: 'consumable',
  stack: 20,
  consumable: { lane: 'potion', cooldownMs: 15000, healPctMaxHp: 30 },
});
const ORE = def({ id: 'item_material_ore_test', category: 'material', stack: 50 });
const PLATE = def({
  id: 'item_armor_chest_test',
  category: 'armor',
  slot: 'chest',
  ilvl: 6,
  armorClass: 'heavy',
  requiresLevel: 6,
});

const DEFS = new Map<string, ItemDef>(
  [SWORD, STAFF, SHIELD, RING, POTION, ORE, PLATE].map((item) => [item.id, item]),
);

const stack = (itemId: string, qty = 1, id = 1): ItemStack => ({ id, itemId, qty, rolled: null });

const withBag = (entries: [number, ItemStack][]): InventoryState => {
  const state = createInventory(100);
  for (const [slot, item] of entries) state.bag.set(slot, item);
  return state;
};

/** Assert the plan succeeded and hand back its mutations (fails loudly). */
const mutationsOf = (plan: InventoryPlan): InventoryMutation[] => {
  if (!plan.ok) throw new Error(`expected plan to succeed, refused with "${plan.reason}"`);
  return plan.mutations;
};

describe('inventory moves', () => {
  it('moves a stack into an empty cell', () => {
    const state = withBag([[0, stack(SWORD.id)]]);
    applyPlan(state, mutationsOf(planMove(state, 0, 5, DEFS)));
    expect(state.bag.get(0)).toBeUndefined();
    expect(state.bag.get(5)?.itemId).toBe(SWORD.id);
  });

  it('swaps two different items', () => {
    const state = withBag([
      [0, stack(SWORD.id, 1, 1)],
      [1, stack(SHIELD.id, 1, 2)],
    ]);
    const plan = planMove(state, 0, 1, DEFS);
    applyPlan(state, mutationsOf(plan));
    expect(state.bag.get(0)?.itemId).toBe(SHIELD.id);
    expect(state.bag.get(1)?.itemId).toBe(SWORD.id);
  });

  it('merges stackables up to the cap and leaves the overflow behind', () => {
    const state = withBag([
      [0, stack(POTION.id, 15, 1)],
      [1, stack(POTION.id, 12, 2)],
    ]);
    const plan = planMove(state, 0, 1, DEFS);
    applyPlan(state, mutationsOf(plan));
    expect(state.bag.get(1)?.qty).toBe(20);
    expect(state.bag.get(0)?.qty).toBe(7);
    expect(countItem(state, POTION.id)).toBe(27);
  });

  it('never merges rolled gear (each roll is its own item)', () => {
    const state = withBag([
      [0, { id: 1, itemId: SWORD.id, qty: 1, rolled: { str: 3 } }],
      [1, { id: 2, itemId: SWORD.id, qty: 1, rolled: { agi: 3 } }],
    ]);
    const plan = planMove(state, 0, 1, DEFS);
    applyPlan(state, mutationsOf(plan));
    expect(state.bag.get(0)?.rolled).toEqual({ agi: 3 });
    expect(state.bag.get(1)?.rolled).toEqual({ str: 3 });
  });

  it('refuses out-of-range and empty sources', () => {
    const state = withBag([[0, stack(SWORD.id)]]);
    expect(planMove(state, 0, 99, DEFS)).toMatchObject({ ok: false, reason: 'bad_slot' });
    expect(planMove(state, 7, 8, DEFS)).toMatchObject({ ok: false, reason: 'empty_slot' });
  });

  it('splits a stack into an empty cell only', () => {
    const state = withBag([[0, stack(ORE.id, 10)]]);
    expect(planSplit(state, 0, 0, 5)).toMatchObject({ ok: false });
    expect(planSplit(state, 0, 1, 10)).toMatchObject({ ok: false, reason: 'not_enough' });
    const plan = planSplit(state, 0, 1, 4);
    applyPlan(state, mutationsOf(plan));
    expect(state.bag.get(0)?.qty).toBe(6);
    expect(state.bag.get(1)?.qty).toBe(4);
    expect(countItem(state, ORE.id)).toBe(10);
  });
});

describe('equipment', () => {
  const warrior = { classId: 'warrior' as const, level: 10 };

  it('equips into the matching slot and vacates the cell', () => {
    const state = withBag([[3, stack(SWORD.id)]]);
    const plan = planEquip(state, 3, DEFS, warrior);
    applyPlan(state, mutationsOf(plan));
    expect(state.equipment.get('mainhand')?.itemId).toBe(SWORD.id);
    expect(state.bag.get(3)).toBeUndefined();
  });

  it('swaps the worn piece back into the vacated cell (no bag room needed)', () => {
    const state = withBag([[3, stack(SWORD.id, 1, 2)]]);
    state.equipment.set('mainhand', stack(STAFF.id, 1, 1));
    const plan = planEquip(state, 3, DEFS, warrior);
    applyPlan(state, mutationsOf(plan));
    expect(state.equipment.get('mainhand')?.id).toBe(2);
    expect(state.bag.get(3)?.id).toBe(1);
  });

  it('honors class locks and level gates', () => {
    const state = withBag([
      [0, stack(STAFF.id)],
      [1, stack(PLATE.id)],
    ]);
    expect(planEquip(state, 0, DEFS, warrior)).toMatchObject({ reason: 'wrong_class' });
    expect(planEquip(state, 1, DEFS, { classId: 'warrior', level: 3 })).toMatchObject({
      reason: 'level_too_low',
    });
  });

  it('fills the first free ring finger, then replaces ring1', () => {
    const state = withBag([
      [0, stack(RING.id, 1, 1)],
      [1, stack(RING.id, 1, 2)],
      [2, stack(RING.id, 1, 3)],
    ]);
    applyPlan(state, mutationsOf(planEquip(state, 0, DEFS, warrior)));
    applyPlan(state, mutationsOf(planEquip(state, 1, DEFS, warrior)));
    expect(state.equipment.get('ring1')?.id).toBe(1);
    expect(state.equipment.get('ring2')?.id).toBe(2);
    applyPlan(state, mutationsOf(planEquip(state, 2, DEFS, warrior)));
    expect(state.equipment.get('ring1')?.id).toBe(3);
    expect(countItem(state, RING.id)).toBe(3);
  });

  it('a two-hander stows the offhand; an offhand refuses to share with one', () => {
    const mage = { classId: 'mage' as const, level: 10 };
    const state = withBag([[0, stack(STAFF.id, 1, 1)]]);
    state.equipment.set('offhand', stack(SHIELD.id, 1, 2));
    const plan = planEquip(state, 0, DEFS, mage);
    applyPlan(state, mutationsOf(plan));
    expect(state.equipment.get('mainhand')?.itemId).toBe(STAFF.id);
    expect(state.equipment.get('offhand')).toBeUndefined();
    expect(countItem(state, SHIELD.id)).toBe(1); // stowed, not destroyed
  });

  it('refuses the two-hand swap when the bag has no room for the offhand', () => {
    const mage = { classId: 'mage' as const, level: 10 };
    const state = createInventory();
    for (let slot = 0; slot < INVENTORY_SLOTS; slot++) {
      state.bag.set(slot, stack(ORE.id, 1, slot + 100));
    }
    state.bag.set(0, stack(STAFF.id, 1, 1));
    state.equipment.set('offhand', stack(SHIELD.id, 1, 2));
    state.equipment.set('mainhand', stack(SWORD.id, 1, 3));
    expect(planEquip(state, 0, DEFS, mage)).toMatchObject({ reason: 'inventory_full' });
  });

  it('unequips into the first free cell, refusing when full', () => {
    const state = createInventory();
    state.equipment.set('mainhand', stack(SWORD.id));
    const plan = planUnequip(state, 'mainhand');
    applyPlan(state, mutationsOf(plan));
    expect(state.bag.get(0)?.itemId).toBe(SWORD.id);
    expect(state.equipment.get('mainhand')).toBeUndefined();

    const full = createInventory();
    for (let slot = 0; slot < INVENTORY_SLOTS; slot++) full.bag.set(slot, stack(ORE.id, 1, slot));
    full.equipment.set('mainhand', stack(SWORD.id));
    expect(planUnequip(full, 'mainhand')).toMatchObject({ reason: 'inventory_full' });
  });
});

describe('add / remove', () => {
  it('tops up partial stacks before opening a new cell', () => {
    const state = withBag([
      [0, stack(POTION.id, 18, 1)],
      [4, stack(POTION.id, 5, 2)],
    ]);
    const result = planAdd(state, POTION.id, 10, DEFS);
    applyPlan(state, result.mutations);
    expect(result.leftover).toBe(0);
    expect(countItem(state, POTION.id)).toBe(33);
    expect(state.bag.get(0)?.qty).toBe(20);
  });

  it('spills into fresh cells and reports what does not fit', () => {
    const state = createInventory();
    for (let slot = 0; slot < INVENTORY_SLOTS - 1; slot++) {
      state.bag.set(slot, stack(SWORD.id, 1, slot));
    }
    const result = planAdd(state, ORE.id, 120, DEFS);
    applyPlan(state, result.mutations);
    // One free cell, 50 per stack → 50 land, 70 bounce.
    expect(countItem(state, ORE.id)).toBe(50);
    expect(result.leftover).toBe(70);
  });

  it('rolled gear never merges into an existing stack', () => {
    const state = withBag([[0, stack(SWORD.id, 1, 1)]]);
    const result = planAdd(state, SWORD.id, 1, DEFS, { str: 4 });
    applyPlan(state, result.mutations);
    expect(state.bag.get(1)?.rolled).toEqual({ str: 4 });
  });

  it('removes exactly the requested quantity', () => {
    const state = withBag([[2, stack(ORE.id, 9)]]);
    expect(planRemove(state, 2, 10)).toMatchObject({ reason: 'not_enough' });
    applyPlan(state, mutationsOf(planRemove(state, 2, 4)));
    expect(state.bag.get(2)?.qty).toBe(5);
    applyPlan(state, mutationsOf(planRemove(state, 2, 5)));
    expect(state.bag.get(2)).toBeUndefined();
  });
});

describe('sort', () => {
  it('compacts stacks, orders by category then ilvl, and conserves everything', () => {
    const state = withBag([
      [10, stack(ORE.id, 30, 1)],
      [3, stack(POTION.id, 5, 2)],
      [20, stack(SWORD.id, 1, 3)],
      [25, stack(ORE.id, 25, 4)],
      [30, stack(POTION.id, 7, 5)],
    ]);
    const before = inventoryCensus(state);
    applyPlan(state, mutationsOf(planSort(state, DEFS)));
    expect(inventoryCensus(state)).toEqual(before);
    expect(state.bag.get(0)?.itemId).toBe(SWORD.id); // weapons first
    // Ore merged into one 50 + one 5 stack (cap 50).
    const oreStacks = [...state.bag.values()].filter((entry) => entry.itemId === ORE.id);
    expect(oreStacks.map((entry) => entry.qty).sort((a, b) => b - a)).toEqual([50, 5]);
    // No holes before the last occupied cell.
    const occupied = [...state.bag.keys()].sort((a, b) => a - b);
    expect(occupied).toEqual(occupied.map((_, index) => index));
  });
});

describe('fuzz: parallel op storms never dupe or lose items (P8 DoD)', () => {
  /** Deterministic RNG so a failure is reproducible from the seed. */
  const rng = (seed: number) => {
    let state = seed >>> 0;
    return (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  };

  for (const seed of [1, 7, 42, 1337, 90210]) {
    it(`conserves every item across 4000 random ops (seed ${seed})`, () => {
      const random = rng(seed);
      const state = createInventory(1000);
      // Seed a messy bag: gear, partial stacks, worn pieces.
      applyPlan(state, planAdd(state, POTION.id, 47, DEFS).mutations);
      applyPlan(state, planAdd(state, ORE.id, 133, DEFS).mutations);
      for (let i = 0; i < 6; i++) {
        applyPlan(state, planAdd(state, SWORD.id, 1, DEFS, { str: i + 1 }).mutations);
        applyPlan(state, planAdd(state, RING.id, 1, DEFS, { agi: i + 1 }).mutations);
      }
      const census = inventoryCensus(state);
      const context = { classId: 'warrior' as const, level: 30 };

      for (let step = 0; step < 4000; step++) {
        const pick = Math.floor(random() * 6);
        const a = Math.floor(random() * INVENTORY_SLOTS);
        const b = Math.floor(random() * INVENTORY_SLOTS);
        let plan;
        if (pick === 0) plan = planMove(state, a, b, DEFS);
        else if (pick === 1) plan = planSplit(state, a, b, 1 + Math.floor(random() * 5));
        else if (pick === 2) plan = planEquip(state, a, DEFS, context);
        else if (pick === 3) {
          const slots = [...state.equipment.keys()];
          const slot = slots[Math.floor(random() * slots.length)];
          plan = slot ? planUnequip(state, slot) : null;
        } else if (pick === 4) plan = planSort(state, DEFS);
        else plan = planMove(state, a, a, DEFS); // no-op path

        if (plan?.ok) applyPlan(state, plan.mutations);

        // Structural invariants hold after EVERY step, not just at the end.
        for (const slot of state.bag.keys()) {
          expect(slot).toBeGreaterThanOrEqual(0);
          expect(slot).toBeLessThan(INVENTORY_SLOTS);
        }
        for (const entry of state.bag.values()) expect(entry.qty).toBeGreaterThan(0);
      }

      expect(inventoryCensus(state)).toEqual(census);
    });
  }

  it('a refused plan mutates nothing', () => {
    const state = createInventory();
    for (let slot = 0; slot < INVENTORY_SLOTS; slot++) state.bag.set(slot, stack(ORE.id, 1, slot));
    state.equipment.set('mainhand', stack(SWORD.id, 1, 999));
    const before = inventoryCensus(state);
    const plan = planUnequip(state, 'mainhand');
    expect(plan.ok).toBe(false);
    expect(inventoryCensus(state)).toEqual(before);
    expect(firstFreeSlot(state)).toBeNull();
  });
});
