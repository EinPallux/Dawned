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

export interface ResourceState {
  type: ResourceType;
  /** Current amount, fractional internally; expose via Math.floor. */
  value: number;
  max: number;
  /** Rogue combo points (always 0 for other classes). */
  comboPoints: number;
}

export const maxResourceFor = (classId: ClassId, int: number): number => {
  const type = RESOURCE_BY_CLASS[classId];
  if (type === 'rage') return RAGE_MAX;
  if (type === 'energy') return ENERGY_MAX;
  return MANA_BASE + MANA_PER_INT * int;
};

export const createResourceState = (classId: ClassId, int: number): ResourceState => {
  const type = RESOURCE_BY_CLASS[classId];
  const max = maxResourceFor(classId, int);
  return {
    type,
    // Rage starts empty and is earned; pools start full.
    value: type === 'rage' ? 0 : max,
    max,
    comboPoints: 0,
  };
};

/**
 * Advance regen/decay by dtMs. Rage DECAYS out of combat and never
 * passively builds; energy regens always; mana regen halves-ish in combat.
 */
export const tickResource = (state: ResourceState, dtMs: number, inCombat: boolean): void => {
  const dt = dtMs / 1000;
  if (state.type === 'rage') {
    if (!inCombat) state.value = Math.max(0, state.value - RAGE_DECAY_PER_S * dt);
    return;
  }
  const perSecond =
    state.type === 'energy'
      ? ENERGY_REGEN_PER_S
      : (state.max * (inCombat ? MANA_REGEN_PCT_COMBAT : MANA_REGEN_PCT_OOC)) / 100;
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
