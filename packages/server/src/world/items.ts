/**
 * Item runtime (P8, ITEMS_LOOT.md) — the authoritative half of the reward
 * engine: what a kill drops, who may pick it up, what wearing it does, and
 * what a vendor pays.
 *
 * Every mutation goes through the SHARED inventory planner (formulas/
 * inventory.ts): this module validates intent and context (proximity, gold,
 * cooldowns, class locks), then applies a plan. Nothing here writes bag cells
 * by hand — that is the property the dupe defence rests on.
 */

import {
  BUYBACK_DEPTH,
  LOOT_BAG_LIFETIME_MS,
  LOOT_REACH_M,
  EQUIP_SLOTS,
  applyPlan,
  baseWeaponDamage,
  equipmentBonus,
  killGold,
  planAdd,
  planEquip,
  planMove,
  planRemove,
  planSort,
  planSplit,
  planUnequip,
  rollItemStats,
  rollLootTable,
  sellPriceFor,
  type EquipSlot,
  type EquipmentBonus,
  type InventoryMutation,
  type InventoryState,
  type ItemDef,
  type ItemOp,
  type ItemStack,
  type LootTableDef,
  type Rarity,
  type Rng,
  type VendorDef,
} from '@dawned/shared';
import type { ServerPlayer } from './player.js';
import type { ServerEnemy } from './enemy.js';
import type { CombatEvent } from './combat.js';
import { applyEffect } from './effects.js';

/** Rarity order for "best rarity in the bag" (beam color). */
const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/** One player's private share of a bag — loot is per-player instanced (§3). */
export interface LootShare {
  items: { itemId: string; qty: number; rolled: Record<string, number> | null }[];
  gold: number;
}

export interface LootBag {
  id: number;
  x: number;
  y: number;
  z: number;
  expiresAtMs: number;
  /** playerId → their own roll. Friends never compete over drops. */
  shares: Map<number, LootShare>;
}

/** Per-player item state the world owns (the bag itself lives in shared). */
export interface PlayerItems {
  inventory: InventoryState;
  /**
   * What the worn set is currently worth. Cached because the derived-stat
   * rebuild runs on every level-up/allocation/respec and shouldn't have to
   * carry the item table around; refreshed whenever equipment or content
   * changes (refreshEquipmentBonus).
   */
  bonus: EquipmentBonus;
  /** Consumable lane → server time when it is usable again (§7). */
  cooldowns: Map<string, number>;
  /** Vendor the player currently has open (proximity-leased). */
  openVendorId: string | null;
  /** Session buyback shelf, newest first (§6). */
  buyback: { itemId: string; qty: number; price: number; rolled: Record<string, number> | null }[];
  /** Serializes write-through flushes per character (same pattern as P7). */
  persistChain: Promise<void>;
}

export interface ItemContent {
  items: ReadonlyMap<string, ItemDef>;
  lootTables: ReadonlyMap<string, LootTableDef>;
  vendors: ReadonlyMap<string, VendorDef>;
}

/** Build a player's item state at login (persisted rows or an empty pack). */
export const createPlayerItems = (
  gold: number,
  persisted?: { bag: Map<number, ItemStack>; equipment: Map<EquipSlot, ItemStack> },
): PlayerItems => ({
  inventory: {
    bag: new Map<number, ItemStack>(persisted?.bag),
    equipment: new Map<EquipSlot, ItemStack>(persisted?.equipment),
    gold,
  },
  bonus: { stats: {}, weapon: null, pct: {}, killGold: 0 },
  cooldowns: new Map(),
  openVendorId: null,
  buyback: [],
  persistChain: Promise.resolve(),
});

/**
 * Drop expired bags (§3: 60 s). Returns the ids of players who could see one
 * of them, so the gateway re-sends their (now shorter) bag list.
 */
export const expireLootBags = (bags: Map<number, LootBag>, nowMs: number): Set<number> => {
  const affected = new Set<number>();
  for (const [id, bag] of bags) {
    if (nowMs < bag.expiresAtMs) continue;
    for (const playerId of bag.shares.keys()) affected.add(playerId);
    bags.delete(id);
  }
  return affected;
};

/** Bags this player has a share in (their own instanced view, §3). */
export const bagsFor = (bags: ReadonlyMap<number, LootBag>, playerId: number): LootBag[] =>
  [...bags.values()].filter((bag) => bag.shares.has(playerId));

// ---------------------------------------------------------------------------
// Equipment → stats
// ---------------------------------------------------------------------------

/** Recompute and cache the worn set's contribution (equip/unequip/reload). */
export const refreshEquipmentBonus = (
  items: PlayerItems,
  defs: ReadonlyMap<string, ItemDef>,
): void => {
  items.bonus = equipmentBonus(items.inventory.equipment, defs);
};

/**
 * The damage band a player's swings roll on: their equipped main hand, or the
 * P4 "implied training gear" curve while unarmed (stats.ts baseWeaponDamage).
 * Every damage site reads THIS — equipping a sword changes every ability.
 */
export const playerWeaponDamage = (player: ServerPlayer): { min: number; max: number } =>
  player.items.bonus.weapon ?? baseWeaponDamage(player.level);

/** Percent riders from Epic+ item effects (move speed, healing done…). */
export const itemEffectPct = (
  items: PlayerItems,
  defs: ReadonlyMap<string, ItemDef>,
  stat: 'moveSpeed' | 'sprintSpeed' | 'healingDone' | 'maxHp' | 'armor' | 'damageDealt',
): number => {
  let pct = 0;
  for (const stack of items.inventory.equipment.values()) {
    const effect = defs.get(stack.itemId)?.effect;
    if (effect?.kind === 'stat_pct' && effect.stat === stat) pct += effect.pct;
  }
  return pct;
};

// ---------------------------------------------------------------------------
// Loot
// ---------------------------------------------------------------------------

/** Best rarity among a share's items — the beam color (§3). */
export const shareRarity = (share: LootShare, defs: ReadonlyMap<string, ItemDef>): Rarity => {
  let best: Rarity = 'common';
  for (const entry of share.items) {
    const rarity = defs.get(entry.itemId)?.rarity ?? 'common';
    if (RARITY_ORDER.indexOf(rarity) > RARITY_ORDER.indexOf(best)) best = rarity;
  }
  return best;
};

/**
 * Roll a dead enemy's payout for every tagged player (§3–§4). Each tagger
 * gets an INDEPENDENT roll — that is the "friends never fight over drops"
 * promise, and it means the bag carries one share per player, not one pool.
 *
 * Returns null when nothing at all dropped for anyone (no bag, no litter).
 */
export const rollEnemyLoot = (
  enemy: ServerEnemy,
  taggers: readonly ServerPlayer[],
  content: ItemContent,
  rng: Rng,
  nowMs: number,
  bagId: number,
): LootBag | null => {
  const binding = enemy.def.loot;
  if (!binding || taggers.length === 0) return null;
  const shares = new Map<number, LootShare>();
  for (const player of taggers) {
    const drops = rollLootTable(
      content.lootTables,
      binding.tableId,
      binding.rolls,
      { killerLevel: player.level },
      rng,
    );
    const share: LootShare = { items: [], gold: 0 };
    for (const drop of drops) {
      if (drop.kind === 'gold') {
        share.gold += drop.qty;
        continue;
      }
      const def = content.items.get(drop.itemId);
      if (!def) continue; // publish cross-checks are the gate; stay quiet here
      const rolled = rollItemStats(def, rng);
      share.items.push({
        itemId: drop.itemId,
        qty: drop.qty,
        rolled: Object.keys(rolled).length > 0 ? rolled : null,
      });
    }
    // Base gold band from the enemy row, on top of any table gold.
    if (binding.goldMax > 0) {
      share.gold += binding.goldMin + Math.floor(rng() * (binding.goldMax - binding.goldMin + 1));
    } else {
      share.gold += killGold(enemy.level, rng);
    }
    // `on_kill_gold` trinkets (§2 "treasure-hunter"), the other half of the
    // item-effect wiring P8 left unread.
    share.gold += player.items.bonus.killGold;
    if (share.items.length > 0 || share.gold > 0) shares.set(player.id, share);
  }
  if (shares.size === 0) return null;
  return {
    id: bagId,
    x: enemy.x,
    y: enemy.y,
    z: enemy.z,
    expiresAtMs: nowMs + LOOT_BAG_LIFETIME_MS,
    shares,
  };
};

// ---------------------------------------------------------------------------
// Item ops
// ---------------------------------------------------------------------------

export interface ItemOpDeps {
  content: ItemContent;
  bags: Map<number, LootBag>;
  nowMs: number;
  events: CombatEvent[];
}

const notice = (
  deps: ItemOpDeps,
  player: ServerPlayer,
  kind: 'picked' | 'gold' | 'sold' | 'bought' | 'full' | 'refused' | 'used' | 'equipped',
  extra: { itemId?: string; qty?: number; gold?: number; reason?: string } = {},
): void => {
  deps.events.push({ type: 'item-notice', playerId: player.id, kind, ...extra });
};

const dirty = (deps: ItemOpDeps, player: ServerPlayer): void => {
  deps.events.push({ type: 'inventory-dirty', playerId: player.id });
};

/** Gold moves through the plan model too, so one applier covers everything. */
const goldMutation = (delta: number): InventoryMutation => ({ op: 'gold', delta });

const applyMutations = (player: ServerPlayer, mutations: readonly InventoryMutation[]): void => {
  applyPlan(player.items.inventory, mutations);
  // The purse has ONE home (characters.gold, persisted with progression);
  // the inventory copy mirrors it so shared plans can price things.
  player.progress.gold = player.items.inventory.gold;
};

/**
 * Run one validated client intent. Returns true when the paper-doll changed
 * (the caller re-folds derived stats and re-broadcasts the visible weapon).
 */
export const applyItemOp = (
  player: ServerPlayer,
  op: ItemOp,
  deps: ItemOpDeps,
): { equipmentChanged: boolean } => {
  const state = player.items.inventory;
  state.gold = player.progress.gold;
  const defs = deps.content.items;
  let equipmentChanged = false;

  switch (op.kind) {
    case 'move': {
      const plan = planMove(state, op.from, op.to, defs);
      if (!plan.ok) return refused(deps, player, plan.reason);
      applyMutations(player, plan.mutations);
      break;
    }
    case 'split': {
      const plan = planSplit(state, op.from, op.to, op.qty);
      if (!plan.ok) return refused(deps, player, plan.reason);
      applyMutations(player, plan.mutations);
      break;
    }
    case 'sort': {
      const plan = planSort(state, defs);
      if (!plan.ok) return refused(deps, player, plan.reason);
      applyMutations(player, plan.mutations);
      break;
    }
    case 'equip': {
      const plan = planEquip(
        state,
        op.from,
        defs,
        { classId: player.classId, level: player.level },
        op.prefer,
      );
      if (!plan.ok) return refused(deps, player, plan.reason);
      const itemId = state.bag.get(op.from)?.itemId;
      applyMutations(player, plan.mutations);
      equipmentChanged = true;
      notice(deps, player, 'equipped', itemId ? { itemId } : {});
      break;
    }
    case 'unequip': {
      const plan = planUnequip(state, op.slot);
      if (!plan.ok) return refused(deps, player, plan.reason);
      applyMutations(player, plan.mutations);
      equipmentChanged = true;
      break;
    }
    case 'drop': {
      const stack = state.bag.get(op.from);
      const def = stack ? defs.get(stack.itemId) : undefined;
      if (def?.bound) return refused(deps, player, 'bound_item');
      const plan = planRemove(state, op.from, op.qty);
      if (!plan.ok) return refused(deps, player, plan.reason);
      applyMutations(player, plan.mutations);
      break;
    }
    case 'use':
      return useConsumable(player, op.from, deps);
    case 'loot':
      lootFromBag(player, op.bagId, op.index, deps);
      break;
    case 'vendorOpen': {
      const vendor = deps.content.vendors.get(op.vendorId);
      if (!vendor || !withinVendorReach(player, vendor)) {
        return refused(deps, player, 'too_far');
      }
      player.items.openVendorId = vendor.id;
      deps.events.push({
        type: 'vendor-panel',
        playerId: player.id,
        vendorId: vendor.id,
        open: true,
      });
      return { equipmentChanged: false };
    }
    case 'vendorClose':
      player.items.openVendorId = null;
      return { equipmentChanged: false };
    case 'vendorBuy':
      return vendorBuy(player, op.vendorId, op.itemId, op.qty, deps);
    case 'vendorSell':
      return vendorSell(player, op.vendorId, op.from, op.qty, deps);
    case 'vendorBuyback':
      return vendorBuyback(player, op.vendorId, op.index, deps);
  }

  dirty(deps, player);
  return { equipmentChanged };
};

const refused = (
  deps: ItemOpDeps,
  player: ServerPlayer,
  reason: string,
): { equipmentChanged: boolean } => {
  notice(deps, player, 'refused', { reason });
  // Still resync: the client predicted something the server did not do.
  dirty(deps, player);
  return { equipmentChanged: false };
};

// ---------------------------------------------------------------------------
// Consumables (§7)
// ---------------------------------------------------------------------------

const useConsumable = (
  player: ServerPlayer,
  from: number,
  deps: ItemOpDeps,
): { equipmentChanged: boolean } => {
  const state = player.items.inventory;
  const stack = state.bag.get(from);
  if (!stack) return refused(deps, player, 'empty_slot');
  const def = deps.content.items.get(stack.itemId);
  if (!def?.consumable) return refused(deps, player, 'not_consumable');
  const lane = def.consumable.lane;
  const readyAt = player.items.cooldowns.get(lane) ?? 0;
  if (deps.nowMs < readyAt) return refused(deps, player, 'on_cooldown');

  const consumable = def.consumable;
  if (consumable.healPctMaxHp > 0) {
    const healed = Math.round((player.maxHp * consumable.healPctMaxHp) / 100);
    player.hp = Math.min(player.maxHp, player.hp + healed);
  }
  if (consumable.restorePctResource > 0 && player.resource.type === 'mana') {
    const restored = (player.resource.max * consumable.restorePctResource) / 100;
    player.resource.value = Math.min(player.resource.max, player.resource.value + restored);
  }
  if (consumable.restoreStamina > 0) {
    player.movement.stamina = Math.min(
      player.movement.maxStamina,
      player.movement.stamina + consumable.restoreStamina,
    );
  }
  if (consumable.buff) {
    applyEffect(
      player,
      {
        effectId: consumable.buff.effectId,
        casterId: player.id,
        durationMs: consumable.buff.durationMs,
        stacksMax: 1,
        mods: {},
        harmful: false,
      },
      deps.nowMs,
    );
  }
  if (consumable.cleanses && consumable.cleanses.length > 0) {
    const cleansed = new Set(consumable.cleanses);
    player.effects = player.effects.filter((effect) => !cleansed.has(effect.category));
  }

  player.items.cooldowns.set(lane, deps.nowMs + consumable.cooldownMs);
  const plan = planRemove(state, from, 1);
  if (plan.ok) applyMutations(player, plan.mutations);
  notice(deps, player, 'used', { itemId: def.id });
  dirty(deps, player);
  return { equipmentChanged: false };
};

// ---------------------------------------------------------------------------
// Looting (§3)
// ---------------------------------------------------------------------------

const lootFromBag = (
  player: ServerPlayer,
  bagId: number,
  index: number | null,
  deps: ItemOpDeps,
): void => {
  const bag = deps.bags.get(bagId);
  if (!bag) {
    refused(deps, player, 'empty_slot');
    return;
  }
  const share = bag.shares.get(player.id);
  if (!share) {
    refused(deps, player, 'empty_slot');
    return;
  }
  const distance = Math.hypot(player.movement.x - bag.x, player.movement.z - bag.z);
  if (distance > LOOT_REACH_M) {
    refused(deps, player, 'too_far');
    return;
  }

  // Gold always comes along — it needs no bag room (§3 auto-pickup).
  if (share.gold > 0 && (index === null || share.items.length === 0)) {
    applyMutations(player, [goldMutation(share.gold)]);
    notice(deps, player, 'gold', { gold: share.gold });
    share.gold = 0;
  }

  const wanted = index === null ? [...share.items.keys()] : [index];
  const taken = new Set<number>();
  for (const entry of wanted) {
    const item = share.items[entry];
    if (!item) continue;
    const result = planAdd(
      player.items.inventory,
      item.itemId,
      item.qty,
      deps.content.items,
      item.rolled,
    );
    const moved = item.qty - result.leftover;
    if (moved > 0) {
      applyMutations(player, result.mutations);
      notice(deps, player, 'picked', { itemId: item.itemId, qty: moved });
    }
    if (result.leftover > 0) {
      item.qty = result.leftover; // the rest stays in the bag (§3 overflow)
      notice(deps, player, 'full', { itemId: item.itemId });
    } else {
      taken.add(entry);
    }
  }
  share.items = share.items.filter((_, entry) => !taken.has(entry));

  if (share.items.length === 0 && share.gold === 0) bag.shares.delete(player.id);
  if (bag.shares.size === 0) deps.bags.delete(bagId);
  dirty(deps, player);
  deps.events.push({ type: 'loot-dirty', playerId: player.id });
};

// ---------------------------------------------------------------------------
// Vendors (§5–6)
// ---------------------------------------------------------------------------

export const withinVendorReach = (player: ServerPlayer, vendor: VendorDef): boolean => {
  if (!vendor.anchor) return false;
  const distance = Math.hypot(
    player.movement.x - vendor.anchor.x,
    player.movement.z - vendor.anchor.z,
  );
  return distance <= vendor.anchor.radius;
};

/**
 * The lease is proximity-based (§6): walking away from the post ends the
 * conversation on the server, so the panel closes on the client too. Without
 * this the UI would linger while every trade got refused.
 */
export const sweepVendorLeases = (
  players: Iterable<ServerPlayer>,
  vendors: ReadonlyMap<string, VendorDef>,
  events: CombatEvent[],
): void => {
  for (const player of players) {
    const openId = player.items.openVendorId;
    if (openId === null) continue;
    const vendor = vendors.get(openId);
    if (vendor && withinVendorReach(player, vendor)) continue;
    player.items.openVendorId = null;
    events.push({ type: 'vendor-panel', playerId: player.id, vendorId: openId, open: false });
  }
};

/** The price a vendor charges for one unit (override wins over item value). */
export const vendorBuyPrice = (vendor: VendorDef, def: ItemDef): number => {
  const override = vendor.stock.find((entry) => entry.itemId === def.id)?.priceOverride;
  if (override !== null && override !== undefined) return override;
  return Math.max(1, Math.round(def.value * vendor.buyMult));
};

/** What a vendor pays per unit (§5: 25% by default; the Collector pays more). */
export const vendorSellPrice = (vendor: VendorDef, def: ItemDef): number =>
  sellPriceFor(def.value, vendor.sellMult);

const openVendorFor = (
  player: ServerPlayer,
  vendorId: string,
  deps: ItemOpDeps,
): VendorDef | null => {
  const vendor = deps.content.vendors.get(vendorId);
  if (!vendor) return null;
  // The panel being open is not enough — the player must still be standing
  // there (a stale lease can't become a remote shopping channel).
  if (player.items.openVendorId !== vendorId || !withinVendorReach(player, vendor)) return null;
  return vendor;
};

const vendorBuy = (
  player: ServerPlayer,
  vendorId: string,
  itemId: string,
  qty: number,
  deps: ItemOpDeps,
): { equipmentChanged: boolean } => {
  const vendor = openVendorFor(player, vendorId, deps);
  if (!vendor) return refused(deps, player, 'too_far');
  if (!vendor.stock.some((entry) => entry.itemId === itemId)) {
    return refused(deps, player, 'unknown_item');
  }
  const def = deps.content.items.get(itemId);
  if (!def) return refused(deps, player, 'unknown_item');
  const price = vendorBuyPrice(vendor, def) * qty;
  if (player.progress.gold < price) return refused(deps, player, 'no_gold');

  const result = planAdd(player.items.inventory, itemId, qty, deps.content.items);
  if (result.leftover > 0) return refused(deps, player, 'inventory_full');
  applyMutations(player, [...result.mutations, goldMutation(-price)]);
  notice(deps, player, 'bought', { itemId, qty, gold: price });
  dirty(deps, player);
  deps.events.push({ type: 'vendor-panel', playerId: player.id, vendorId, open: true });
  return { equipmentChanged: false };
};

const vendorSell = (
  player: ServerPlayer,
  vendorId: string,
  from: number,
  qty: number,
  deps: ItemOpDeps,
): { equipmentChanged: boolean } => {
  const vendor = openVendorFor(player, vendorId, deps);
  if (!vendor) return refused(deps, player, 'too_far');
  const stack = player.items.inventory.bag.get(from);
  if (!stack) return refused(deps, player, 'empty_slot');
  const def = deps.content.items.get(stack.itemId);
  if (!def) return refused(deps, player, 'unknown_item');
  if (def.bound || def.category === 'quest') return refused(deps, player, 'bound_item');

  const plan = planRemove(player.items.inventory, from, qty);
  if (!plan.ok) return refused(deps, player, plan.reason);
  const price = vendorSellPrice(vendor, def) * qty;
  applyMutations(player, [...plan.mutations, goldMutation(price)]);
  // Buyback shelf: newest first, capped (§6).
  player.items.buyback.unshift({
    itemId: def.id,
    qty,
    price,
    rolled: stack.rolled ?? null,
  });
  player.items.buyback.length = Math.min(player.items.buyback.length, BUYBACK_DEPTH);
  notice(deps, player, 'sold', { itemId: def.id, qty, gold: price });
  dirty(deps, player);
  deps.events.push({ type: 'vendor-panel', playerId: player.id, vendorId, open: true });
  return { equipmentChanged: false };
};

const vendorBuyback = (
  player: ServerPlayer,
  vendorId: string,
  index: number,
  deps: ItemOpDeps,
): { equipmentChanged: boolean } => {
  const vendor = openVendorFor(player, vendorId, deps);
  if (!vendor) return refused(deps, player, 'too_far');
  const entry = player.items.buyback[index];
  if (!entry) return refused(deps, player, 'unknown_item');
  if (player.progress.gold < entry.price) return refused(deps, player, 'no_gold');
  const result = planAdd(
    player.items.inventory,
    entry.itemId,
    entry.qty,
    deps.content.items,
    entry.rolled,
  );
  if (result.leftover > 0) return refused(deps, player, 'inventory_full');
  applyMutations(player, [...result.mutations, goldMutation(-entry.price)]);
  player.items.buyback.splice(index, 1);
  notice(deps, player, 'bought', { itemId: entry.itemId, qty: entry.qty, gold: entry.price });
  dirty(deps, player);
  deps.events.push({ type: 'vendor-panel', playerId: player.id, vendorId, open: true });
  return { equipmentChanged: false };
};

// ---------------------------------------------------------------------------
// Grants (loot overflow, GM tools, future quest rewards)
// ---------------------------------------------------------------------------

/** Put items straight in the bag; reports what did not fit (§3 overflow). */
export const grantItem = (
  player: ServerPlayer,
  itemId: string,
  qty: number,
  deps: ItemOpDeps,
  rolled: Record<string, number> | null = null,
): number => {
  const result = planAdd(player.items.inventory, itemId, qty, deps.content.items, rolled);
  if (result.mutations.length > 0) applyMutations(player, result.mutations);
  if (qty - result.leftover > 0) {
    notice(deps, player, 'picked', { itemId, qty: qty - result.leftover });
  }
  if (result.leftover > 0) notice(deps, player, 'full', { itemId });
  dirty(deps, player);
  return result.leftover;
};

/**
 * Take `qty` of an item out of the bag, oldest cell first (quest delivery).
 *
 * The mirror of `grantItem`, and the reason it exists as its own function: a
 * DELIVER step hands over an ITEM, not a slot, and the caller has no business
 * knowing which cells the stack is spread across. Returns how many were
 * actually removed — the caller has already checked `countItem`, so a short
 * return means the pack changed underneath and the step must not complete.
 */
export const takeItem = (
  player: ServerPlayer,
  itemId: string,
  qty: number,
  deps: ItemOpDeps,
): number => {
  let remaining = Math.max(0, Math.floor(qty));
  let removed = 0;
  for (const [slot, stack] of [...player.items.inventory.bag]) {
    if (remaining <= 0) break;
    if (stack.itemId !== itemId) continue;
    const take = Math.min(remaining, stack.qty);
    const plan = planRemove(player.items.inventory, slot, take);
    if (!plan.ok) continue;
    applyMutations(player, plan.mutations);
    remaining -= take;
    removed += take;
  }
  if (removed > 0) dirty(deps, player);
  return removed;
};

/** Purse grant (GM primitive, quest rewards later). Never goes negative. */
export const grantGold = (player: ServerPlayer, amount: number, deps: ItemOpDeps): void => {
  const delta = Math.max(amount, -player.progress.gold);
  if (delta === 0) return;
  applyMutations(player, [goldMutation(delta)]);
  notice(deps, player, 'gold', { gold: delta });
  dirty(deps, player);
};

/** Bag rows for persistence (one row per occupied cell). */
export const inventoryRows = (
  items: PlayerItems,
): { container: 'inventory' | 'equipment'; slot: number; stack: ItemStack }[] => {
  const rows: { container: 'inventory' | 'equipment'; slot: number; stack: ItemStack }[] = [];
  for (const [slot, stack] of items.inventory.bag)
    rows.push({ container: 'inventory', slot, stack });
  for (const [slot, stack] of items.inventory.equipment) {
    rows.push({ container: 'equipment', slot: EQUIP_SLOTS.indexOf(slot), stack });
  }
  return rows;
};

/** Equip-slot index ↔ name (the DB stores the index, DATABASE.md §2). */
export const equipSlotByIndex = (index: number): EquipSlot | null => EQUIP_SLOTS[index] ?? null;
