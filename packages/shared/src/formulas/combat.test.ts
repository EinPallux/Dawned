/**
 * Combat math + hit geometry tests (COMBAT.md §5/§6, NPCS_ENEMIES.md §5).
 * These formulas ARE the balance — every branch is pinned.
 */

import { describe, expect, it } from 'vitest';
import {
  armorMitigation,
  levelModifier,
  rollDamage,
  rollHeal,
  type DamageInput,
  type Rng,
} from './damage.js';
import {
  CLASS_BASE_ATTRIBUTES,
  RANK_MULTIPLIERS,
  baseWeaponDamage,
  enemyBaseStats,
  enemyStats,
  playerStats,
} from './stats.js';
import { addStagger, createStaggerState, tickStagger } from './stagger.js';
import { arcHits, circleHits, dashSweepHits, sweepFirstHit, type HitTarget } from './hits.js';
import { BASIC_COMBOS, comboWindow } from '../data/basic-combos.js';
import {
  COMBO_LINK_WINDOW_FRACTION,
  COMBO_RESET_MS,
  CRIT_MULTIPLIER,
  STAGGER_DECAY_DELAY_MS,
  STAGGER_THRESHOLD,
} from '../constants.js';

/** Deterministic RNG from a fixed sequence (wraps around). */
const seq = (...values: number[]): Rng => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

const baseHit: DamageInput = {
  coef: 1,
  weaponMin: 10,
  weaponMax: 10,
  power: 20,
  school: 'physical',
  critPct: 0,
  attackerLevel: 5,
  targetLevel: 5,
  targetArmor: 0,
  targetMagicResistPct: 0,
};

describe('damage formula (COMBAT.md §6.2)', () => {
  it('computes the canonical path with no rolls active', () => {
    // rng: weapon roll mid, no crit, zero variance offset (0.5 → ±0%).
    const { amount, crit } = rollDamage(baseHit, seq(0.5, 0.99, 0.5));
    expect(amount).toBe(30); // 1 × (10 + 20)
    expect(crit).toBe(false);
  });

  it('applies crit ×1.5', () => {
    const { amount, crit } = rollDamage({ ...baseHit, critPct: 50 }, seq(0.5, 0.1, 0.5));
    expect(crit).toBe(true);
    expect(amount).toBe(Math.round(30 * CRIT_MULTIPLIER));
  });

  it('variance spans ±5%', () => {
    const low = rollDamage(baseHit, seq(0.5, 0.99, 0)).amount;
    const high = rollDamage(baseHit, seq(0.5, 0.99, 1)).amount;
    expect(low).toBe(Math.round(30 * 0.95));
    expect(high).toBe(Math.round(30 * 1.05));
  });

  it('mitigates physical by armor and magic by resist', () => {
    const armored = rollDamage({ ...baseHit, targetArmor: 550 }, seq(0.5, 0.99, 0.5));
    // mitig = 550/(550+150+400) = 0.5
    expect(armored.amount).toBe(15);
    const resisted = rollDamage(
      { ...baseHit, school: 'magic', targetMagicResistPct: 20 },
      seq(0.5, 0.99, 0.5),
    );
    expect(resisted.amount).toBe(24);
  });

  it('level modifier clamps at ±20%', () => {
    expect(levelModifier(30, 10)).toBe(1.2);
    expect(levelModifier(1, 30)).toBe(0.8);
    expect(levelModifier(7, 5)).toBeCloseTo(1.04, 10);
  });

  it('armor mitigation follows the curve', () => {
    expect(armorMitigation(0, 10)).toBe(0);
    expect(armorMitigation(700, 10)).toBeCloseTo(0.5, 10);
  });

  it('damage-taken and damage-dealt multipliers stack multiplicatively', () => {
    const { amount } = rollDamage(
      { ...baseHit, damageTakenMult: 1.1, damageDealtMult: 0.85 },
      seq(0.5, 0.99, 0.5),
    );
    expect(amount).toBe(Math.round(30 * 1.1 * 0.85));
  });

  it('a landed hit never rounds to zero', () => {
    const { amount } = rollDamage(
      { ...baseHit, coef: 0.01, targetArmor: 5000 },
      seq(0.5, 0.99, 0.5),
    );
    expect(amount).toBe(1);
  });

  it('healing crits and varies like damage', () => {
    expect(rollHeal(2, 50, 0, seq(0.99, 0.5)).amount).toBe(100);
    expect(rollHeal(2, 50, 100, seq(0, 0.5)).amount).toBe(150);
  });
});

describe('stats (PROGRESSION.md §2, NPCS_ENEMIES.md §5)', () => {
  it('derives level-1 Warrior exactly per the doc', () => {
    const s = playerStats('warrior', 1);
    expect(s.maxHp).toBe(80 + 12 * 13);
    expect(s.ap).toBe(14);
    expect(s.critPct).toBeCloseTo(5 + 0.04 * 9, 10);
    expect(s.maxStamina).toBe(100 + 5 * 8);
  });

  it('rogue AP reads AGI, casters read INT into SP', () => {
    expect(playerStats('rogue', 1).ap).toBe(CLASS_BASE_ATTRIBUTES.rogue.agi);
    expect(playerStats('mage', 1).sp).toBe(15);
  });

  it('every class spread sums to 50', () => {
    for (const spread of Object.values(CLASS_BASE_ATTRIBUTES)) {
      expect(spread.str + spread.agi + spread.int + spread.vit + spread.end).toBe(50);
    }
  });

  it('levels raise HP and stamina without allocation', () => {
    expect(playerStats('mage', 10).maxHp).toBe(playerStats('mage', 1).maxHp + 54);
    expect(baseWeaponDamage(10).max).toBeGreaterThan(baseWeaponDamage(1).max);
  });

  it('enemy curve matches the §5 formulas', () => {
    const glubLike = enemyBaseStats(1, 'swarm');
    expect(glubLike.maxHp).toBe(Math.round(40 + 22 * 1));
    expect(glubLike.swingDamage).toBeCloseTo((3 + 2.1) * 0.45, 10);
    expect(glubLike.armor).toBe(4);
    const grunt4 = enemyBaseStats(4, 'grunt');
    expect(grunt4.armor).toBe(32);
    expect(grunt4.magicResistPct).toBe(10);
  });

  it('rank multipliers scale HP and damage', () => {
    const elite = enemyStats(6, 'grunt', 'elite');
    const normal = enemyStats(6, 'grunt', 'normal');
    expect(elite.maxHp).toBe(Math.round(normal.maxHp * RANK_MULTIPLIERS.elite.hp));
    expect(elite.swingDamage).toBeCloseTo(normal.swingDamage * 1.3, 10);
  });

  it('dummies never deal damage', () => {
    expect(enemyBaseStats(10, 'dummy').swingDamage).toBe(0);
  });
});

describe('stagger meter (COMBAT.md §6.4)', () => {
  it('fills to the threshold, triggers once and resets', () => {
    const state = createStaggerState();
    expect(addStagger(state, 60, 1)).toBe(false);
    expect(addStagger(state, 40, 1)).toBe(true);
    expect(state.meter).toBe(0);
  });

  it('elite gain factor slows the fill', () => {
    const state = createStaggerState();
    expect(addStagger(state, STAGGER_THRESHOLD, 0.75)).toBe(false);
    expect(state.meter).toBeCloseTo(75, 10);
  });

  it('decays only after the pause, at the tuned rate', () => {
    const state = createStaggerState();
    addStagger(state, 50, 1);
    tickStagger(state, STAGGER_DECAY_DELAY_MS - 100);
    expect(state.meter).toBe(50);
    tickStagger(state, 1100); // 100 ms past the delay → 1 s of decay
    expect(state.meter).toBeCloseTo(50 - 15, 5);
  });

  it('zero gain factor (world boss) never staggers', () => {
    const state = createStaggerState();
    expect(addStagger(state, 10_000, 0)).toBe(false);
    expect(state.meter).toBe(0);
  });
});

describe('hit shapes (COMBAT.md §5)', () => {
  const target = (x: number, z: number, radius = 0.4): HitTarget => ({
    x,
    y: 0,
    z,
    radius,
    height: 1.6,
  });

  it('melee arc hits inside reach+angle, sorted nearest first, capped', () => {
    const targets = [target(0, 2.4), target(0, 1), target(2.4, 0), target(0, -1)];
    // Facing +Z, 100° arc, reach 2.6: hits the two in front; behind and to the
    // full right stay out.
    const hits = arcHits(0, 0, 0, 0, 2.6, (100 * Math.PI) / 180, targets, 5);
    expect(hits).toEqual([1, 0]);
    expect(arcHits(0, 0, 0, 0, 2.6, (100 * Math.PI) / 180, targets, 1)).toEqual([1]);
  });

  it('arc grants angular slack for a fat target brushing the edge', () => {
    // Dead-on the 50° half-angle boundary, the body's radius tips it in.
    const angle = (100 * Math.PI) / 180;
    const boundary = target(Math.sin(0.95) * 2, Math.cos(0.95) * 2, 0.6);
    expect(arcHits(0, 0, 0, 0, 2.6, angle, [boundary], 5)).toEqual([0]);
    const slim = { ...boundary, radius: 0.05 };
    expect(arcHits(0, 0, 0, 0, 2.6, angle, [slim], 5)).toEqual([]);
  });

  it('vertical tolerance rejects targets far above/below', () => {
    const high = { ...target(0, 1.5), y: 4 };
    expect(arcHits(0, 0, 0, 0, 2.6, Math.PI, [high], 5)).toEqual([]);
    expect(circleHits(0, 0, 0, 3, [high])).toEqual([]);
  });

  it('ground circle includes target radius', () => {
    const targets = [target(2.9, 0), target(3.6, 0)];
    expect(circleHits(0, 0, 0, 2.6, targets)).toEqual([0]);
  });

  it('projectile sweep returns the FIRST contact along the travel', () => {
    const targets = [target(0, 8), target(0, 4)];
    const hit = sweepFirstHit(0, 1, 0, 0, 0, 10, 0.25, targets, -1);
    expect(hit?.index).toBe(1);
    expect(hit!.t).toBeGreaterThan(0.3);
    expect(hit!.t).toBeLessThan(0.4);
  });

  it('projectile sweep misses offsets larger than combined radii', () => {
    expect(sweepFirstHit(0, 1, 0, 0, 0, 10, 0.25, [target(1.2, 5)], -1)).toBeNull();
    expect(sweepFirstHit(0, 1, 0, 0, 0, 10, 0.25, [target(0.5, 5)], -1)).not.toBeNull();
  });

  it('projectile sweep skips the shooter index and starts-overlapping hits at t=0', () => {
    const targets = [target(0, 0.2)];
    expect(sweepFirstHit(0, 1, 0, 0, 0, 10, 0.25, targets, 0)).toBeNull();
    expect(sweepFirstHit(0, 1, 0, 0, 0, 10, 0.25, targets, -1)?.t).toBe(0);
  });

  it('dash sweep collects everyone the corridor crosses', () => {
    const targets = [target(0, 2), target(0.6, 5), target(2.5, 4), target(0, 9)];
    expect(dashSweepHits(0, 0, 0, 0, 8, 0.5, targets)).toEqual([0, 1]);
  });
});

describe('basic combo chains (COMBAT.md §3, CLASSES.md)', () => {
  it('carries the doc coefficients per class', () => {
    expect(BASIC_COMBOS.warrior.steps.map((s) => s.coef)).toEqual([0.55, 0.55, 0.85]);
    expect(BASIC_COMBOS.rogue.steps.map((s) => s.coef)).toEqual([0.45, 0.45, 0.7]);
    expect(BASIC_COMBOS.mage.steps.map((s) => s.coef)).toEqual([0.5, 0.5, 0.8]);
    expect(BASIC_COMBOS.cleric.steps.map((s) => s.coef)).toEqual([0.5, 0.5, 0.75]);
  });

  it('warrior finisher cleaves wider than the base arc', () => {
    expect(BASIC_COMBOS.warrior.finisherAngleDeg).toBe(120);
    expect(BASIC_COMBOS.warrior.angleDeg).toBe(100);
  });

  it('casters deliver by projectile, melees by arc', () => {
    expect(BASIC_COMBOS.mage.delivery).toBe('projectile');
    expect(BASIC_COMBOS.mage.projectile).not.toBeNull();
    expect(BASIC_COMBOS.warrior.delivery).toBe('melee_arc');
  });

  it('link window opens in the last 40% and expires after the reset grace', () => {
    const step = BASIC_COMBOS.warrior.steps[0];
    const linkOpens = step.durationMs * (1 - COMBO_LINK_WINDOW_FRACTION);
    expect(comboWindow(step, linkOpens - 1, COMBO_LINK_WINDOW_FRACTION, COMBO_RESET_MS)).toBe(
      'too_early',
    );
    expect(comboWindow(step, linkOpens + 1, COMBO_LINK_WINDOW_FRACTION, COMBO_RESET_MS)).toBe(
      'link',
    );
    expect(
      comboWindow(
        step,
        step.durationMs + COMBO_RESET_MS - 1,
        COMBO_LINK_WINDOW_FRACTION,
        COMBO_RESET_MS,
      ),
    ).toBe('link');
    expect(
      comboWindow(
        step,
        step.durationMs + COMBO_RESET_MS + 1,
        COMBO_LINK_WINDOW_FRACTION,
        COMBO_RESET_MS,
      ),
    ).toBe('expired');
  });
});
