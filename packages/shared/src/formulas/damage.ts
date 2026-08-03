/**
 * THE damage formula — the single canonical path (docs/design/COMBAT.md §6.2).
 *
 * Only the server ever rolls real damage; the client renders numbers off
 * `AbilityResolve`. Randomness is injected so tests are deterministic and the
 * server owns its RNG stream.
 */

import { CRIT_MULTIPLIER, DAMAGE_VARIANCE } from '../constants.js';
import { clamp } from '../math/vec.js';

/** Uniform [0,1) source — the server passes its RNG, tests pass a sequence. */
export type Rng = () => number;

export type DamageSchool = 'physical' | 'magic';

export interface DamageInput {
  /** Per-ability/step coefficient. */
  coef: number;
  /** Weapon damage roll range (min..max, uniform). */
  weaponMin: number;
  weaponMax: number;
  /** Attack or spell power, matching the school (COMBAT.md §6.1). */
  power: number;
  school: DamageSchool;
  /** Attacker crit chance in percent. */
  critPct: number;
  attackerLevel: number;
  targetLevel: number;
  /** Target physical armor (used when school = physical). */
  targetArmor: number;
  /** Target magic resist percent (used when school = magic). */
  targetMagicResistPct: number;
  /** Additive damage-taken multiplier on the target (stagger window, Dawned…). 1 = none. */
  damageTakenMult?: number;
  /** Additive damage-dealt multiplier on the attacker (Dawned −15% → 0.85). 1 = none. */
  damageDealtMult?: number;
}

export interface DamageResult {
  amount: number;
  crit: boolean;
}

/** Armor mitigation fraction (COMBAT.md §6.2, physical school). */
export const armorMitigation = (armor: number, attackerLevel: number): number =>
  armor / (armor + 30 * attackerLevel + 400);

/** Level modifier: ±2% per level difference, clamped to 0.80–1.20. */
export const levelModifier = (attackerLevel: number, targetLevel: number): number =>
  clamp(1 + 0.02 * (attackerLevel - targetLevel), 0.8, 1.2);

/**
 * Roll one hit. Order is part of the contract: weapon roll → power → coef →
 * crit → variance → mitigation → level mod → external multipliers → round.
 */
export const rollDamage = (input: DamageInput, rng: Rng): DamageResult => {
  const weaponRoll = input.weaponMin + rng() * (input.weaponMax - input.weaponMin);
  let raw = input.coef * (weaponRoll + input.power);

  const crit = rng() * 100 < input.critPct;
  if (crit) raw *= CRIT_MULTIPLIER;

  raw *= 1 + (rng() * 2 - 1) * DAMAGE_VARIANCE;

  const mitigation =
    input.school === 'physical'
      ? armorMitigation(input.targetArmor, input.attackerLevel)
      : clamp(input.targetMagicResistPct / 100, 0, 0.95);

  const final =
    raw *
    (1 - mitigation) *
    levelModifier(input.attackerLevel, input.targetLevel) *
    (input.damageTakenMult ?? 1) *
    (input.damageDealtMult ?? 1);

  // Damage never rounds to 0 — every landed hit ticks (PROGRESSION.md §7 spirit).
  return { amount: Math.max(1, Math.round(final)), crit };
};

/** Healing: `coef × SP × (1 ± 5%)`, crits ×1.5, overheal discarded by the caller. */
export const rollHeal = (
  coef: number,
  spellPower: number,
  critPct: number,
  rng: Rng,
): DamageResult => {
  let raw = coef * spellPower;
  const crit = rng() * 100 < critPct;
  if (crit) raw *= CRIT_MULTIPLIER;
  raw *= 1 + (rng() * 2 - 1) * DAMAGE_VARIANCE;
  return { amount: Math.max(1, Math.round(raw)), crit };
};
