/**
 * Item value curves (ITEMS_LOOT.md §2, §5) — the formulas the Item Editor
 * ƒ-suggests, the publish validator sanity-checks against, and the drop
 * generator rolls with. Pure and unit-tested: the panel's preview and the
 * server's roll are the same arithmetic.
 */

import type { Rng } from './damage.js';
import {
  ROLLS_BY_RARITY,
  type ArmorClass,
  type AttributeKey,
  type ItemDef,
  type ItemSlot,
  type ItemStats,
  type Rarity,
} from '../content/items.js';

/** Slot weights (§2) — how much budget a slot is worth. */
export const SLOT_WEIGHTS: Record<ItemSlot, number> = {
  none: 0,
  mainhand: 1.0,
  chest: 1.0,
  legs: 0.85,
  head: 0.7,
  boots: 0.6,
  gloves: 0.6,
  offhand: 0.6,
  amulet: 0.55,
  trinket: 0.5,
  ring: 0.4,
};

/** Rarity budget multipliers (§2). */
export const RARITY_MULTS: Record<Rarity, number> = {
  common: 1.0,
  uncommon: 1.15,
  rare: 1.35,
  epic: 1.6,
  legendary: 1.9,
};

/** Free base armor per ilvl·slotWeight by weight class (§2). */
export const ARMOR_CLASS_PER_ILVL: Record<ArmorClass, number> = {
  heavy: 6,
  medium_heavy: 5,
  medium: 4,
  light: 3,
};

/** `statBudget = slotWeight × (4 + 1.1 × ilvl) × rarityMult` (§2). */
export const statBudget = (slot: ItemSlot, ilvl: number, rarity: Rarity): number =>
  SLOT_WEIGHTS[slot] * (4 + 1.1 * ilvl) * RARITY_MULTS[rarity];

/** Free armor an armor piece carries before budget is spent (§2). */
export const baseArmorFor = (armorClass: ArmorClass, slot: ItemSlot, ilvl: number): number =>
  Math.round(ARMOR_CLASS_PER_ILVL[armorClass] * SLOT_WEIGHTS[slot] * ilvl);

/** Weapon damage baseline: `avg = 3 + 1.6 × ilvl`, min/max = ±12% (§2). */
export const weaponDamageFor = (ilvl: number): { min: number; max: number } => {
  const avg = 3 + 1.6 * ilvl;
  return { min: Math.round(avg * 0.88), max: Math.round(avg * 1.12) };
};

/** Flat value floor per category so junk and materials still sell for something. */
const CATEGORY_BASE_VALUE: Record<string, number> = {
  weapon: 8,
  offhand: 6,
  armor: 6,
  jewelry: 6,
  consumable: 4,
  material: 3,
  junk: 5,
  quest: 0,
};

/** `value = statBudget × 3 + base` (§5), rounded to whole gold. */
export const itemValue = (
  category: string,
  slot: ItemSlot,
  ilvl: number,
  rarity: Rarity,
): number => {
  if (category === 'quest') return 0;
  const budget = statBudget(slot, ilvl, rarity);
  const base = CATEGORY_BASE_VALUE[category] ?? 4;
  // Non-equippables have no slot budget: scale their floor by ilvl instead.
  const scaled = budget > 0 ? budget * 3 : base * (0.6 + 0.4 * ilvl);
  return Math.max(1, Math.round(scaled + base));
};

/** What a vendor pays for an item (§5: 25% of value, never below 1). */
export const SELL_VALUE_FRACTION = 0.25;
export const sellPriceFor = (value: number, sellMult = SELL_VALUE_FRACTION): number =>
  value <= 0 ? 0 : Math.max(1, Math.floor(value * sellMult));

/** Kill gold faucet (§5): `~1.2 × mobLevel` on average, ±25%. */
export const killGold = (mobLevel: number, rng: Rng): number => {
  const avg = 1.2 * Math.max(1, mobLevel);
  return Math.max(1, Math.round(avg * (0.75 + rng() * 0.5)));
};

/** Total attribute points a rolled copy distributes (budget, minus fixed stats). */
export const rollableBudget = (def: ItemDef): number => {
  const budget = statBudget(def.slot, def.ilvl, def.rarity);
  const fixed = (Object.keys(def.stats) as (keyof ItemStats)[]).reduce((sum, key) => {
    if (key === 'armor' || key === 'critPct') return sum; // priced separately
    return sum + (def.stats[key] ?? 0);
  }, 0);
  return Math.max(0, budget - fixed);
};

/**
 * Roll a dropped copy's attributes (§2): rarity decides HOW MANY attributes,
 * the def's pool decides WHICH, and the leftover budget is split across them
 * (largest share first, so a Rare reads as a clear primary + two supports).
 *
 * Deterministic for a given `rng` — the admin simulator and the server drop
 * generator produce identical results from the same seed.
 */
export const rollItemStats = (def: ItemDef, rng: Rng): Partial<Record<AttributeKey, number>> => {
  const pool = def.rollPool ?? [];
  const rolls = Math.min(ROLLS_BY_RARITY[def.rarity], pool.length);
  if (rolls <= 0) return {};
  const budget = rollableBudget(def);
  if (budget <= 0) return {};

  // Pick `rolls` distinct attributes from the pool (Fisher–Yates prefix).
  const picks = [...pool];
  for (let i = picks.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [picks[i], picks[j]] = [picks[j]!, picks[i]!];
  }
  const chosen = picks.slice(0, rolls);

  // Split the budget with a decreasing share (1, 1/2, 1/3 …) so a Rare reads
  // as a clear primary plus supports. The LAST attribute takes whatever is
  // left, which makes the total exactly the budget — no rounding leakage —
  // while every attribute keeps at least one point.
  const weights = chosen.map((_, index) => 1 / (index + 1));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const total = Math.max(chosen.length, Math.round(budget));
  const rolled: Partial<Record<AttributeKey, number>> = {};
  let spent = 0;
  for (let index = 0; index < chosen.length - 1; index++) {
    const reserved = chosen.length - index - 1; // one point per remaining pick
    const share = Math.round((total * weights[index]!) / weightSum);
    const points = Math.min(Math.max(1, share), total - spent - reserved);
    rolled[chosen[index]!] = points;
    spent += points;
  }
  rolled[chosen[chosen.length - 1]!] = total - spent;
  return rolled;
};

/** Fixed + rolled attributes of one owned copy, folded into one spread. */
export const totalItemStats = (
  def: ItemDef,
  rolled: Partial<Record<AttributeKey, number>> | null,
): ItemStats => {
  const total: ItemStats = { ...def.stats };
  if (def.armorClass) {
    total.armor = (total.armor ?? 0) + baseArmorFor(def.armorClass, def.slot, def.ilvl);
  }
  if (!rolled) return total;
  for (const [key, value] of Object.entries(rolled) as [AttributeKey, number][]) {
    total[key] = (total[key] ?? 0) + value;
  }
  return total;
};
