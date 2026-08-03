/**
 * Basic-attack combo chains per class (docs/design/COMBAT.md §3,
 * docs/design/CLASSES.md per-class "Basic combo" lines).
 *
 * These are the P4 framework defaults. When the data-driven ability pipeline
 * lands (P5 + admin A1 editors), ability content rows supersede these numbers;
 * the chain STRUCTURE (link windows, reset, contact timing) stays engine.
 *
 * Timing is gameplay-authored, not clip-native: UAL clips play at
 * `clipSeconds / durationMs` timeScale so the swing fits the fight (the raw
 * Sword_Regular_C runs 2.0 s — far too slow against a 400 ms GCD world).
 * Contact = when damage resolves and FX fire, as a fraction of the step.
 */

import type { ClassId } from './appearance.js';
import type { DamageSchool } from '../formulas/damage.js';

export interface ComboStep {
  /** Damage coefficient (COMBAT.md §6.2 `coef`). */
  coef: number;
  /** Step duration in ms at game speed. */
  durationMs: number;
  /** Contact point as a fraction of the duration (damage + FX moment). */
  contactFraction: number;
  /** Stagger meter added on hit (step 3 carries the §6.4 buildup). */
  stagger: number;
  /** UAL clip and its native length in seconds (timeScale = native/duration). */
  clip: string;
  clipSeconds: number;
  /** Resource riders on a landed hit (CLASSES.md §0: Warrior +4 Rage etc.). */
  rageGain: number;
  comboPointGain: number;
}

export interface ComboChain {
  school: DamageSchool;
  /** MELEE_ARC or PROJECTILE per class (COMBAT.md §3). */
  delivery: 'melee_arc' | 'projectile';
  /** Arc reach/angle for melee; per-step angle override for cleaves. */
  reach: number;
  angleDeg: number;
  /** Step-3 cleave angle (Warrior 120° rider); null = same as angleDeg. */
  finisherAngleDeg: number | null;
  /** Projectile parameters for bolt classes. */
  projectile: { speed: number; radius: number; maxRange: number } | null;
  /** Movement speed multiplier while a step plays (COMBAT.md §1). */
  moveSpeedMult: number;
  steps: [ComboStep, ComboStep, ComboStep];
}

const sword = (
  coef: number,
  durationMs: number,
  stagger: number,
  clip: string,
  clipSeconds: number,
): ComboStep => ({
  coef,
  durationMs,
  contactFraction: 0.55,
  stagger,
  clip,
  clipSeconds,
  rageGain: 4, // Warrior basics build Rage per hit (CLASSES.md §1)
  comboPointGain: 0,
});

const bolt = (coef: number, durationMs: number, stagger: number): ComboStep => ({
  coef,
  durationMs,
  contactFraction: 0.6,
  stagger,
  clip: 'Spell_Simple_Shoot',
  clipSeconds: 0.5,
  rageGain: 0,
  comboPointGain: 0,
});

/**
 * Chains per class. Coefficients straight from CLASSES.md; durations tuned for
 * the §12 targets (basic-cycle DPS lands trash TTK in the 6–10 s band).
 */
export const BASIC_COMBOS: Record<ClassId, ComboChain> = {
  warrior: {
    school: 'physical',
    delivery: 'melee_arc',
    reach: 2.6,
    angleDeg: 100,
    finisherAngleDeg: 120, // step-3 cleave rider
    projectile: null,
    moveSpeedMult: 0.55,
    steps: [
      sword(0.55, 450, 8, 'Sword_Regular_A', 0.433),
      sword(0.55, 500, 8, 'Sword_Regular_B', 0.533),
      sword(0.85, 750, 25, 'Sword_Regular_C', 2.0),
    ],
  },
  rogue: {
    school: 'physical',
    delivery: 'melee_arc',
    reach: 2.2,
    angleDeg: 90,
    finisherAngleDeg: null,
    projectile: null,
    moveSpeedMult: 0.65,
    steps: [
      { ...sword(0.45, 380, 6, 'Sword_Regular_A', 0.433), rageGain: 0 },
      { ...sword(0.45, 420, 6, 'Sword_Regular_B', 0.533), rageGain: 0 },
      { ...sword(0.7, 620, 20, 'Sword_Regular_C', 2.0), rageGain: 0, comboPointGain: 1 },
    ],
  },
  mage: {
    school: 'magic',
    delivery: 'projectile',
    reach: 0,
    angleDeg: 0,
    finisherAngleDeg: null,
    projectile: { speed: 28, radius: 0.25, maxRange: 30 },
    moveSpeedMult: 0.75,
    steps: [bolt(0.5, 450, 6), bolt(0.5, 450, 6), bolt(0.8, 600, 20)],
  },
  cleric: {
    school: 'magic',
    delivery: 'projectile',
    reach: 0,
    angleDeg: 0,
    finisherAngleDeg: null,
    projectile: { speed: 26, radius: 0.25, maxRange: 28 },
    moveSpeedMult: 0.75,
    steps: [bolt(0.5, 470, 6), bolt(0.5, 470, 6), bolt(0.75, 620, 20)],
  },
};

/**
 * Whether a new press at `sinceStepStartMs` into the CURRENT step may chain to
 * the next: inside the link window (last COMBO_LINK_WINDOW_FRACTION of the
 * step) or the grace after it ends, before COMBO_RESET_MS expires. The shared
 * definition keeps client prediction and server validation in lockstep.
 */
export const comboWindow = (
  step: ComboStep,
  sinceStepStartMs: number,
  linkFraction: number,
  resetMs: number,
): 'too_early' | 'link' | 'expired' => {
  const linkOpensAt = step.durationMs * (1 - linkFraction);
  if (sinceStepStartMs < linkOpensAt) return 'too_early';
  if (sinceStepStartMs <= step.durationMs + resetMs) return 'link';
  return 'expired';
};

/**
 * Build the executor chain table from PUBLISHED content rows (P5 migration:
 * COMBAT.md §3 as-built — basics are content). Returns null when any class is
 * missing any of its three steps; the caller falls back to BASIC_COMBOS and
 * warns — migration 0005 seeds the rows, after which the fallback never runs.
 */
export const buildBasicChains = (
  defs: readonly {
    classId: ClassId;
    binding: { kind: string; step?: number };
    targeting: Record<string, unknown>;
    effects: readonly Record<string, unknown>[];
    anim: {
      clip: string;
      clipSeconds: number;
      durationMs: number;
      contactFraction: number;
      moveSpeedMult: number;
    };
  }[],
): Record<ClassId, ComboChain> | null => {
  const out: Partial<Record<ClassId, ComboChain>> = {};
  for (const classId of ['warrior', 'mage', 'rogue', 'cleric'] as const) {
    const rows = defs
      .filter((def) => def.classId === classId && def.binding.kind === 'basic')
      .sort((a, b) => (a.binding.step ?? 0) - (b.binding.step ?? 0));
    if (rows.length !== 3) return null;

    const steps = rows.map((row) => {
      const damage = row.effects.find((effect) => effect['kind'] === 'damage');
      const resource = row.effects.find((effect) => effect['kind'] === 'resource');
      return {
        coef: typeof damage?.['coef'] === 'number' ? damage['coef'] : 0.5,
        durationMs: row.anim.durationMs,
        contactFraction: row.anim.contactFraction,
        stagger: typeof damage?.['staggerBonus'] === 'number' ? damage['staggerBonus'] : 0,
        clip: row.anim.clip,
        clipSeconds: row.anim.clipSeconds,
        rageGain:
          resource?.['resource'] === 'rage' && typeof resource['amount'] === 'number'
            ? resource['amount']
            : 0,
        comboPointGain: typeof resource?.['comboPoints'] === 'number' ? resource['comboPoints'] : 0,
      } satisfies ComboStep;
    }) as [ComboStep, ComboStep, ComboStep];

    const first = rows[0]!.targeting;
    const last = rows[2]!.targeting;
    const isProjectile = first['kind'] === 'projectile';
    out[classId] = {
      school: classId === 'mage' || classId === 'cleric' ? 'magic' : 'physical',
      delivery: isProjectile ? 'projectile' : 'melee_arc',
      reach: typeof first['reach'] === 'number' ? first['reach'] : 0,
      angleDeg: typeof first['angleDeg'] === 'number' ? first['angleDeg'] : 0,
      finisherAngleDeg:
        typeof last['angleDeg'] === 'number' && last['angleDeg'] !== first['angleDeg']
          ? last['angleDeg']
          : null,
      projectile: isProjectile
        ? {
            speed: typeof first['speed'] === 'number' ? first['speed'] : 28,
            radius: typeof first['radius'] === 'number' ? first['radius'] : 0.25,
            maxRange: typeof first['maxRange'] === 'number' ? first['maxRange'] : 30,
          }
        : null,
      moveSpeedMult: BASIC_COMBOS[classId].moveSpeedMult,
      steps,
    };
  }
  return out as Record<ClassId, ComboChain>;
};
