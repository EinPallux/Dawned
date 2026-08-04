/**
 * Item presentation helpers shared by the bag, the vendor and the toasts:
 * rarity tones, refusal wording, stat lines and the compare deltas. Numbers
 * come from the SHARED formulas — a tooltip that computed armour its own way
 * would eventually disagree with the character sheet.
 */

import {
  RARITY_COLORS,
  ROLLS_BY_RARITY,
  sellPriceFor,
  totalItemStats,
  type ItemDef,
  type ItemStats,
  type Rarity,
} from '@dawned/shared';

export type ToastTone =
  'gold' | 'xp' | 'red' | 'plain' | 'uncommon' | 'rare' | 'epic' | 'legendary';

/** Loot toasts wear their rarity; commons stay quiet. */
export const rarityTone = (rarity: string): ToastTone =>
  rarity === 'common' ? 'plain' : (rarity as ToastTone);

export const rarityColor = (rarity: string): string =>
  rarity in RARITY_COLORS ? RARITY_COLORS[rarity as Rarity] : RARITY_COLORS.common;

/** The words the HUD says when the server refuses an item op. */
export const refusalText = (reason: string): string =>
  ({
    empty_slot: 'Nothing there.',
    bad_slot: "That cell can't take it.",
    too_far: 'Too far away.',
    unknown_item: 'That item is gone.',
    not_equippable: "That doesn't go anywhere.",
    wrong_class: 'Your class cannot use that.',
    level_too_low: 'You are not high enough level.',
    inventory_full: 'Your pack is full.',
    not_enough: "You don't have that many.",
    bound_item: 'That is bound to you.',
    not_consumable: "That isn't something to use.",
    on_cooldown: 'Not yet — still recovering.',
    no_gold: "You can't afford that.",
  })[reason] ?? 'That did not work.';

const STAT_LABELS: Record<keyof ItemStats, string> = {
  str: 'Strength',
  agi: 'Agility',
  int: 'Intellect',
  vit: 'Vitality',
  end: 'Endurance',
  armor: 'Armor',
  critPct: 'Crit',
};

export interface StatLine {
  key: keyof ItemStats;
  label: string;
  value: number;
  /** Difference against the currently equipped piece (compare-on-hover). */
  delta: number | null;
}

/** Every stat a copy carries: fixed block + free armour + this copy's roll. */
export const statLines = (
  def: ItemDef,
  rolled: Record<string, number> | null | undefined,
  compareAgainst?: { def: ItemDef; rolled: Record<string, number> | null | undefined } | null,
): StatLine[] => {
  const mine = totalItemStats(def, rolled ?? null);
  const theirs = compareAgainst
    ? totalItemStats(compareAgainst.def, compareAgainst.rolled ?? null)
    : null;
  const keys = new Set<keyof ItemStats>([
    ...(Object.keys(mine) as (keyof ItemStats)[]),
    ...(theirs ? (Object.keys(theirs) as (keyof ItemStats)[]) : []),
  ]);
  return [...keys]
    .filter((key) => (mine[key] ?? 0) !== 0 || (theirs?.[key] ?? 0) !== 0)
    .sort((a, b) => (mine[b] ?? 0) - (mine[a] ?? 0))
    .map((key) => ({
      key,
      label: STAT_LABELS[key],
      value: mine[key] ?? 0,
      delta: theirs ? (mine[key] ?? 0) - (theirs[key] ?? 0) : null,
    }));
};

/** The one-line "what is this" under the name. */
export const typeLine = (def: ItemDef): string => {
  const slot = def.slot === 'none' ? '' : ` · ${def.slot}`;
  const twoHanded = def.weapon?.twoHanded ? ' · two-handed' : '';
  const armorClass = def.armorClass ? ` · ${def.armorClass.replace('_', ' ')}` : '';
  return `${def.category}${slot}${armorClass}${twoHanded} · ilvl ${def.ilvl}`;
};

export const damageLine = (def: ItemDef): string | null =>
  def.weapon ? `${def.weapon.dmgMin}–${def.weapon.dmgMax} damage` : null;

export const sellLine = (def: ItemDef): string =>
  def.value > 0 ? `Sells for ${sellPriceFor(def.value)} gold` : 'Worthless to vendors';

/** How many attributes a dropped copy of this rolls (tooltip footnote). */
export const rollCount = (def: ItemDef): number =>
  Math.min(ROLLS_BY_RARITY[def.rarity], def.rollPool?.length ?? 0);

export const effectText = (def: ItemDef): string | null => {
  const effect = def.effect;
  if (!effect) return null;
  switch (effect.kind) {
    case 'stat_pct':
      return `${effect.pct > 0 ? '+' : ''}${effect.pct}% ${effect.stat.replace(/([A-Z])/g, ' $1').toLowerCase()}`;
    case 'on_hit_effect':
      return `${effect.chancePct}% on hit: ${effect.effectId.replace(/_/g, ' ')} for ${(effect.durationMs / 1000).toFixed(0)} s`;
    case 'on_kill_gold':
      return `+${effect.gold} gold per kill`;
  }
};

export const consumableText = (def: ItemDef): string | null => {
  const block = def.consumable;
  if (!block) return null;
  const parts: string[] = [];
  if (block.healPctMaxHp > 0) parts.push(`Restores ${block.healPctMaxHp}% health`);
  if (block.restorePctResource > 0) parts.push(`${block.restorePctResource}% resource`);
  if (block.restoreStamina > 0) parts.push(`${block.restoreStamina} stamina`);
  if (block.buff) parts.push(`${(block.buff.durationMs / 60000).toFixed(0)} min buff`);
  if (block.cleanses?.length) parts.push(`cleanses ${block.cleanses.join(', ')}`);
  const cooldown =
    block.cooldownMs > 0 ? ` (${(block.cooldownMs / 1000).toFixed(0)} s ${block.lane})` : '';
  return `${parts.join(' · ')}${cooldown}`;
};
