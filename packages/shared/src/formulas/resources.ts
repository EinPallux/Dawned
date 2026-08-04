/**
 * Class resource model (CLASSES.md §0) — pure and deterministic, ticked by
 * both the server (authoritative) and the client (prediction). Integers on
 * the wire; internally fractional accumulation so slow regens never starve
 * at 20 Hz (12/s energy = 0.6 per tick — flooring each tick would leak 100%).
 */

import {
  COMBO_POINTS_MAX,
  ENERGY_MAX,
  ENERGY_REGEN_PER_S,
  MANA_BASE,
  MANA_PER_INT,
  MANA_REGEN_PCT_COMBAT,
  MANA_REGEN_PCT_OOC,
  RAGE_DECAY_PER_S,
  RAGE_MAX,
} from '../constants.js';
import type { ClassId } from '../data/appearance.js';

export type ResourceType = 'rage' | 'mana' | 'energy';

export const RESOURCE_BY_CLASS: Record<ClassId, ResourceType> = {
  warrior: 'rage',
  mage: 'mana',
  rogue: 'energy',
  cleric: 'mana',
};

/**
 * Skill-tree pool/regen adjustments (P7): flat max add (Conditioning +5
 * Energy), percent max (Clarity +5% Mana), flat regen add (Vigor +1
 * Energy/s) and percent regen (Flow/Serenity +10% Mana regen). Neutral = all
 * zero. Both sides fold the SAME values from synced node ranks.
 */
export interface ResourceMods {
  maxFlat: number;
  maxPct: number;
  regenFlat: number;
  regenPct: number;
}

export const neutralResourceMods = (): ResourceMods => ({
  maxFlat: 0,
  maxPct: 0,
  regenFlat: 0,
  regenPct: 0,
});

export interface ResourceState {
  type: ResourceType;
  /** Current amount, fractional internally; expose via Math.floor. */
  value: number;
  max: number;
  /** Rogue combo points (always 0 for other classes). */
  comboPoints: number;
  /** Node-driven pool/regen adjustments; absent = neutral (pre-P7 callers). */
  mods?: ResourceMods;
}

export const maxResourceFor = (classId: ClassId, int: number, mods?: ResourceMods): number => {
  const type = RESOURCE_BY_CLASS[classId];
  const base =
    type === 'rage' ? RAGE_MAX : type === 'energy' ? ENERGY_MAX : MANA_BASE + MANA_PER_INT * int;
  if (!mods) return base;
  return Math.max(1, Math.round(base * (1 + mods.maxPct / 100) + mods.maxFlat));
};

export const createResourceState = (
  classId: ClassId,
  int: number,
  mods?: ResourceMods,
): ResourceState => {
  const type = RESOURCE_BY_CLASS[classId];
  const max = maxResourceFor(classId, int, mods);
  return {
    type,
    // Rage starts empty and is earned; pools start full.
    value: type === 'rage' ? 0 : max,
    max,
    comboPoints: 0,
    ...(mods ? { mods } : {}),
  };
};

/**
 * Re-derive the pool after INT/level/node changes (level-up, allocation,
 * respec). Keeps the current value inside the new max; `refill` tops pools
 * up (the level-up juice contract refills everything).
 */
export const rebuildResourceMax = (
  state: ResourceState,
  classId: ClassId,
  int: number,
  mods: ResourceMods | undefined,
  refill: boolean,
): void => {
  if (mods) state.mods = mods;
  else delete state.mods;
  state.max = maxResourceFor(classId, int, mods);
  state.value = refill && state.type !== 'rage' ? state.max : Math.min(state.value, state.max);
};

/**
 * Advance regen/decay by dtMs. Rage DECAYS out of combat and never
 * passively builds; energy regens always; mana regen halves-ish in combat.
 * Node mods: flat regen adds (Energy) and percent regen (Mana) fold here.
 */
export const tickResource = (state: ResourceState, dtMs: number, inCombat: boolean): void => {
  const dt = dtMs / 1000;
  if (state.type === 'rage') {
    if (!inCombat) state.value = Math.max(0, state.value - RAGE_DECAY_PER_S * dt);
    return;
  }
  const mods = state.mods;
  const perSecond =
    state.type === 'energy'
      ? Math.max(0, ENERGY_REGEN_PER_S + (mods?.regenFlat ?? 0))
      : ((state.max * (inCombat ? MANA_REGEN_PCT_COMBAT : MANA_REGEN_PCT_OOC)) / 100) *
        (1 + (mods?.regenPct ?? 0) / 100);
  state.value = Math.min(state.max, state.value + perSecond * dt);
};

/** Whole units available to spend (wire/UI integer view). */
export const resourceFloor = (state: ResourceState): number => Math.floor(state.value);

export const canAfford = (state: ResourceState, type: string, amount: number): boolean => {
  if (type === 'none' || amount <= 0) return true;
  if (type === 'stamina') return true; // stamina lives in MovementState, checked there
  return type === state.type && resourceFloor(state) >= amount;
};

/** Pay a cost (caller validated affordability). */
export const payResource = (state: ResourceState, amount: number): void => {
  state.value = Math.max(0, state.value - amount);
};

/**
 * Gain resource (Rage from hits taken/dealt, ability riders). Rage only
 * builds IN combat (CLASSES.md §0) — pools ignore the flag.
 */
export const gainResource = (state: ResourceState, amount: number, inCombat: boolean): void => {
  if (state.type === 'rage' && !inCombat) return;
  state.value = Math.min(state.max, state.value + amount);
};

export const gainComboPoints = (state: ResourceState, points: number): void => {
  state.comboPoints = Math.min(COMBO_POINTS_MAX, state.comboPoints + points);
};

/** Spend ALL combo points (finishers); returns how many were spent. */
export const spendComboPoints = (state: ResourceState): number => {
  const spent = state.comboPoints;
  state.comboPoints = 0;
  return spent;
};
