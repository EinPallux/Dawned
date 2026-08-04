/**
 * Inventory transactions (ITEMS_LOOT.md §3, DATABASE.md §2, SECURITY.md).
 *
 * THE anti-dupe layer. Every inventory mutation — a drag, an equip, a loot, a
 * vendor sale — is expressed as a **plan**: a validated list of primitive
 * cell writes. Nothing mutates state directly; the server applies a plan
 * inside one row-locked transaction and the client applies the same plan
 * optimistically, so both sides move identically and a dropped packet can
 * only ever cost a round trip, never an item.
 *
 * The plans conserve quantity by construction (moves rewrite cells, they
 * never mint), and `planAdd`/`planRemove` are the only ways items enter or
 * leave — each declaring its delta explicitly. inventory.test.ts fuzzes the
 * whole surface and asserts conservation after every storm.
 */

import {
  EQUIP_SLOTS,
  equipSlotsFor,
  type AttributeKey,
  type EquipSlot,
  type ItemDef,
} from '../content/items.js';
import type { ClassId } from '../data/appearance.js';

/** Fixed 48-slot grid (§3). */
export const INVENTORY_SLOTS = 48;

/** One owned stack. `id` is the server's row id (0 = not yet persisted). */
export interface ItemStack {
  id: number;
  itemId: string;
  qty: number;
  /** Rolled attributes for gear; null for stackables and fixed uniques. */
  rolled: Partial<Record<AttributeKey, number>> | null;
}

export interface InventoryState {
  /** Grid index (0..47) → stack. Sparse: absent = empty cell. */
  bag: Map<number, ItemStack>;
  equipment: Map<EquipSlot, ItemStack>;
  gold: number;
}

export const createInventory = (gold = 0): InventoryState => ({
  bag: new Map(),
  equipment: new Map(),
  gold,
});

/** A primitive cell write — the only shape that ever touches state. */
export type InventoryMutation =
  | { op: 'bag'; slot: number; stack: ItemStack | null }
  | { op: 'equip'; slot: EquipSlot; stack: ItemStack | null }
  | { op: 'gold'; delta: number };

export type InventoryRefusal =
  | 'empty_slot'
  | 'bad_slot'
  | 'too_far'
  | 'unknown_item'
  | 'not_equippable'
  | 'wrong_class'
  | 'level_too_low'
  | 'inventory_full'
  | 'not_enough'
  | 'bound_item'
  | 'not_consumable'
  | 'on_cooldown'
  | 'no_gold';

export type InventoryPlan =
  { ok: true; mutations: InventoryMutation[] } | { ok: false; reason: InventoryRefusal };

const refuse = (reason: InventoryRefusal): InventoryPlan => ({ ok: false, reason });
const allow = (mutations: InventoryMutation[]): InventoryPlan => ({ ok: true, mutations });

/** Apply a validated plan. Both sides call this — never mutate state elsewhere. */
export const applyPlan = (state: InventoryState, mutations: readonly InventoryMutation[]): void => {
  for (const mutation of mutations) {
    if (mutation.op === 'bag') {
      if (mutation.stack === null) state.bag.delete(mutation.slot);
      else state.bag.set(mutation.slot, mutation.stack);
    } else if (mutation.op === 'equip') {
      if (mutation.stack === null) state.equipment.delete(mutation.slot);
      else state.equipment.set(mutation.slot, mutation.stack);
    } else {
      state.gold = Math.max(0, state.gold + mutation.delta);
    }
  }
};

const inGrid = (slot: number): boolean =>
  Number.isInteger(slot) && slot >= 0 && slot < INVENTORY_SLOTS;

/** First empty grid cell, or null when the bag is full. */
export const firstFreeSlot = (state: InventoryState): number | null => {
  for (let slot = 0; slot < INVENTORY_SLOTS; slot++) {
    if (!state.bag.has(slot)) return slot;
  }
  return null;
};

export const freeSlotCount = (state: InventoryState): number => INVENTORY_SLOTS - state.bag.size;

/** Total owned quantity of an item across bag AND equipment (tests, quests). */
export const countItem = (state: InventoryState, itemId: string): number => {
  let total = 0;
  for (const stack of state.bag.values()) if (stack.itemId === itemId) total += stack.qty;
  for (const stack of state.equipment.values()) if (stack.itemId === itemId) total += stack.qty;
  return total;
};

/** Stacks merge only when they are the same item AND carry no rolled stats. */
const mergeable = (a: ItemStack, b: ItemStack, def: ItemDef): boolean =>
  a.itemId === b.itemId && def.stack > 1 && a.rolled === null && b.rolled === null;

/** Field-wise equivalence — id alone is ambiguous before the server saves. */
const sameStack = (a: ItemStack, b: ItemStack): boolean =>
  a.id === b.id &&
  a.itemId === b.itemId &&
  a.qty === b.qty &&
  JSON.stringify(a.rolled ?? null) === JSON.stringify(b.rolled ?? null);

export interface EquipContext {
  classId: ClassId;
  level: number;
}

/** Why this character may not wear that (class lock + level gate, §2). */
const equipRefusal = (def: ItemDef, context: EquipContext): InventoryRefusal | null => {
  if (def.slot === 'none') return 'not_equippable';
  if (def.classLock.length > 0 && !def.classLock.includes(context.classId)) return 'wrong_class';
  if (context.level < def.requiresLevel) return 'level_too_low';
  return null;
};

/**
 * Drag a grid cell onto another: merge same stackables (with overflow left
 * behind), otherwise swap. Moving onto itself is a no-op, not an error.
 */
export const planMove = (
  state: InventoryState,
  from: number,
  to: number,
  defs: ReadonlyMap<string, ItemDef>,
): InventoryPlan => {
  if (!inGrid(from) || !inGrid(to)) return refuse('bad_slot');
  if (from === to) return allow([]);
  const source = state.bag.get(from);
  if (!source) return refuse('empty_slot');
  const target = state.bag.get(to);
  if (!target) {
    return allow([
      { op: 'bag', slot: from, stack: null },
      { op: 'bag', slot: to, stack: source },
    ]);
  }
  const def = defs.get(source.itemId);
  if (!def) return refuse('unknown_item');
  if (mergeable(source, target, def)) {
    const room = def.stack - target.qty;
    if (room > 0) {
      const moved = Math.min(room, source.qty);
      const leftover = source.qty - moved;
      return allow([
        { op: 'bag', slot: to, stack: { ...target, qty: target.qty + moved } },
        {
          op: 'bag',
          slot: from,
          stack: leftover > 0 ? { ...source, qty: leftover } : null,
        },
      ]);
    }
  }
  return allow([
    { op: 'bag', slot: from, stack: target },
    { op: 'bag', slot: to, stack: source },
  ]);
};

/** Shift-drag: peel `qty` off a stack into an empty cell. */
export const planSplit = (
  state: InventoryState,
  from: number,
  to: number,
  qty: number,
): InventoryPlan => {
  if (!inGrid(from) || !inGrid(to)) return refuse('bad_slot');
  const source = state.bag.get(from);
  if (!source) return refuse('empty_slot');
  if (!Number.isInteger(qty) || qty < 1 || qty >= source.qty) return refuse('not_enough');
  if (state.bag.has(to)) return refuse('bad_slot');
  // A rolled instance is one object with one set of stats — it cannot be
  // halved (gear never stacks anyway; this closes the door explicitly).
  if (source.rolled !== null) return refuse('not_enough');
  return allow([
    { op: 'bag', slot: from, stack: { ...source, qty: source.qty - qty } },
    // The peeled stack is new inventory — the server assigns its row id.
    { op: 'bag', slot: to, stack: { id: 0, itemId: source.itemId, qty, rolled: null } },
  ]);
};

/**
 * Equip from a grid cell. The displaced piece lands in the vacated cell, so
 * equipping never needs bag room — except a two-hander that must also stow an
 * offhand, which does (and refuses cleanly when the bag is full).
 */
export const planEquip = (
  state: InventoryState,
  from: number,
  defs: ReadonlyMap<string, ItemDef>,
  context: EquipContext,
  prefer?: EquipSlot,
): InventoryPlan => {
  if (!inGrid(from)) return refuse('bad_slot');
  const stack = state.bag.get(from);
  if (!stack) return refuse('empty_slot');
  const def = defs.get(stack.itemId);
  if (!def) return refuse('unknown_item');
  const blocked = equipRefusal(def, context);
  if (blocked) return refuse(blocked);

  const candidates = equipSlotsFor(def);
  const target =
    prefer && candidates.includes(prefer)
      ? prefer
      : (candidates.find((slot) => !state.equipment.has(slot)) ?? candidates[0]!);

  const mutations: InventoryMutation[] = [];
  const displaced = state.equipment.get(target) ?? null;
  mutations.push({ op: 'equip', slot: target, stack });
  mutations.push({ op: 'bag', slot: from, stack: displaced });

  // A two-hander clears the offhand; the offhand needs its own bag cell.
  if (def.weapon?.twoHanded) {
    const offhand = state.equipment.get('offhand');
    if (offhand) {
      const free = displaced === null ? from : firstFreeSlot(state);
      if (free === null) return refuse('inventory_full');
      mutations.push({ op: 'equip', slot: 'offhand', stack: null });
      mutations.push({ op: 'bag', slot: free, stack: offhand });
    }
  }
  // An offhand can't go up while a two-hander is held (§1).
  if (target === 'offhand') {
    const mainhand = state.equipment.get('mainhand');
    const mainDef = mainhand ? defs.get(mainhand.itemId) : undefined;
    if (mainDef?.weapon?.twoHanded) {
      const free = displaced === null ? from : firstFreeSlot(state);
      if (free === null) return refuse('inventory_full');
      mutations.push({ op: 'equip', slot: 'mainhand', stack: null });
      mutations.push({ op: 'bag', slot: free, stack: mainhand! });
    }
  }
  return allow(mutations);
};

/** Take a piece off the paper-doll into the bag (or a named cell). */
export const planUnequip = (state: InventoryState, slot: EquipSlot, to?: number): InventoryPlan => {
  const stack = state.equipment.get(slot);
  if (!stack) return refuse('empty_slot');
  const target = to !== undefined ? to : firstFreeSlot(state);
  if (target === null) return refuse('inventory_full');
  if (!inGrid(target) || state.bag.has(target)) return refuse('bad_slot');
  return allow([
    { op: 'equip', slot, stack: null },
    { op: 'bag', slot: target, stack },
  ]);
};

/**
 * Bring `qty` of an item in (loot, vendor buy, GM grant): top up partial
 * stacks first, then fill empty cells. Returns what did NOT fit so the caller
 * can leave it in the bag/refund it — items are never silently destroyed.
 */
export interface AddResult {
  mutations: InventoryMutation[];
  /** Quantity that found no room. */
  leftover: number;
}

export const planAdd = (
  state: InventoryState,
  itemId: string,
  qty: number,
  defs: ReadonlyMap<string, ItemDef>,
  rolled: Partial<Record<AttributeKey, number>> | null = null,
): AddResult => {
  const def = defs.get(itemId);
  if (!def || qty <= 0) return { mutations: [], leftover: Math.max(0, qty) };
  const mutations: InventoryMutation[] = [];
  // A working copy of the occupancy so multi-cell adds don't collide.
  const occupied = new Map<number, ItemStack>(state.bag);
  let remaining = qty;

  if (def.stack > 1 && rolled === null) {
    for (const [slot, stack] of occupied) {
      if (remaining <= 0) break;
      if (stack.itemId !== itemId || stack.rolled !== null) continue;
      const room = def.stack - stack.qty;
      if (room <= 0) continue;
      const moved = Math.min(room, remaining);
      const next = { ...stack, qty: stack.qty + moved };
      occupied.set(slot, next);
      mutations.push({ op: 'bag', slot, stack: next });
      remaining -= moved;
    }
  }

  while (remaining > 0) {
    let free: number | null = null;
    for (let slot = 0; slot < INVENTORY_SLOTS; slot++) {
      if (!occupied.has(slot)) {
        free = slot;
        break;
      }
    }
    if (free === null) break;
    const moved = Math.min(def.stack, remaining);
    const stack: ItemStack = { id: 0, itemId, qty: moved, rolled };
    occupied.set(free, stack);
    mutations.push({ op: 'bag', slot: free, stack });
    remaining -= moved;
  }

  return { mutations, leftover: remaining };
};

/** Take `qty` out of one grid cell (sell, drop, quest turn-in, consume). */
export const planRemove = (state: InventoryState, from: number, qty: number): InventoryPlan => {
  if (!inGrid(from)) return refuse('bad_slot');
  const stack = state.bag.get(from);
  if (!stack) return refuse('empty_slot');
  if (!Number.isInteger(qty) || qty < 1 || qty > stack.qty) return refuse('not_enough');
  return allow([
    {
      op: 'bag',
      slot: from,
      stack: qty === stack.qty ? null : { ...stack, qty: stack.qty - qty },
    },
  ]);
};

/**
 * Sort button (§3): gear first by slot then rarity/ilvl, then consumables,
 * materials and junk — stacks merged on the way. Deterministic so the client
 * preview and the server result agree.
 */
const CATEGORY_ORDER: Record<string, number> = {
  weapon: 0,
  offhand: 1,
  armor: 2,
  jewelry: 3,
  consumable: 4,
  quest: 5,
  material: 6,
  junk: 7,
};

export const planSort = (
  state: InventoryState,
  defs: ReadonlyMap<string, ItemDef>,
): InventoryPlan => {
  const stacks = [...state.bag.values()];
  // Merge stackables first so sorting compacts partial stacks.
  const merged: ItemStack[] = [];
  for (const stack of stacks) {
    const def = defs.get(stack.itemId);
    if (def && def.stack > 1 && stack.rolled === null) {
      const open = merged.find(
        (candidate) =>
          candidate.itemId === stack.itemId &&
          candidate.rolled === null &&
          candidate.qty < def.stack,
      );
      if (open) {
        const room = def.stack - open.qty;
        const moved = Math.min(room, stack.qty);
        open.qty += moved;
        if (stack.qty - moved > 0) merged.push({ ...stack, qty: stack.qty - moved });
        continue;
      }
    }
    merged.push({ ...stack });
  }

  merged.sort((a, b) => {
    const defA = defs.get(a.itemId);
    const defB = defs.get(b.itemId);
    const orderA = CATEGORY_ORDER[defA?.category ?? 'junk'] ?? 9;
    const orderB = CATEGORY_ORDER[defB?.category ?? 'junk'] ?? 9;
    if (orderA !== orderB) return orderA - orderB;
    const ilvlDelta = (defB?.ilvl ?? 0) - (defA?.ilvl ?? 0);
    if (ilvlDelta !== 0) return ilvlDelta;
    return a.itemId.localeCompare(b.itemId);
  });

  const mutations: InventoryMutation[] = [];
  for (let slot = 0; slot < INVENTORY_SLOTS; slot++) {
    const next = merged[slot] ?? null;
    const current = state.bag.get(slot) ?? null;
    if (next === null && current === null) continue;
    // Skip the write only when the cell already holds an EQUIVALENT stack.
    // Comparing row ids alone is unsound: freshly-planned stacks all carry
    // id 0 until the server assigns one, so two different items would look
    // identical and the cell would keep the wrong contents (fuzz-caught).
    if (next && current && sameStack(next, current)) continue;
    mutations.push({ op: 'bag', slot, stack: next });
  }
  return allow(mutations);
};

/** Total quantity held, by item — the conservation check the fuzz test runs. */
export const inventoryCensus = (state: InventoryState): Map<string, number> => {
  const census = new Map<string, number>();
  const add = (stack: ItemStack): void => {
    census.set(stack.itemId, (census.get(stack.itemId) ?? 0) + stack.qty);
  };
  for (const stack of state.bag.values()) add(stack);
  for (const stack of state.equipment.values()) add(stack);
  return census;
};

/** Equipment as a plain record (wire payloads, paper-doll rendering). */
export const equipmentRecord = (state: InventoryState): Partial<Record<EquipSlot, ItemStack>> => {
  const record: Partial<Record<EquipSlot, ItemStack>> = {};
  for (const slot of EQUIP_SLOTS) {
    const stack = state.equipment.get(slot);
    if (stack) record[slot] = stack;
  }
  return record;
};
