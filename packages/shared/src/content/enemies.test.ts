import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  bossPhaseAt,
  enemyAbilitySchema,
  enemyDefSchema,
  NEUTRAL_PHASE,
  orderedPhases,
  pickEnemyAbility,
  selectableEnemyAbilities,
  validateEnemyDef,
  type EnemyAbilityDef,
  type EnemyDef,
} from './enemies.js';
import { ARCHETYPE_MOTION, surroundSlot } from '../formulas/stats.js';

/**
 * A minimal valid ability row; overrides layer the case under test on top.
 * Overrides are typed as the schema's INPUT: the output type would force every
 * defaulted field (a phase's speedMult, an ability's overshootMs) to be spelled
 * out at every call site, which is how fixtures rot.
 */
const ability = (
  over: Partial<z.input<typeof enemyAbilitySchema>> & { id: string },
): EnemyAbilityDef => enemyAbilitySchema.parse({ kind: 'melee_arc', clip: 'Attack', ...over });

const enemy = (over: Partial<z.input<typeof enemyDefSchema>> & { id: string }): EnemyDef =>
  enemyDefSchema.parse({
    name: 'Test Thing',
    archetype: 'grunt',
    levelMin: 1,
    levelMax: 3,
    modelRef: 'enemies_mushnub',
    abilities: [ability({ id: 'swipe' })],
    ...over,
  });

const alwaysReady = {
  distance: 2,
  hpFraction: 1,
  phase: 0,
  onCooldown: () => false,
  spent: () => false,
};

describe('enemy ability selection (the gate the server and the panel share)', () => {
  it('keeps abilities whose range band contains the target', () => {
    const kit = [
      ability({ id: 'bite', rangeMax: 2.5 }),
      ability({ id: 'lob', kind: 'projectile', rangeMin: 6, rangeMax: 16 }),
    ];
    expect(selectableEnemyAbilities(kit, { ...alwaysReady, distance: 2 }).map((a) => a.id)).toEqual(
      ['bite'],
    );
    expect(selectableEnemyAbilities(kit, { ...alwaysReady, distance: 9 }).map((a) => a.id)).toEqual(
      ['lob'],
    );
    // Between the bands nothing is selectable — that gap is what makes a
    // ranged enemy reposition instead of standing still.
    expect(selectableEnemyAbilities(kit, { ...alwaysReady, distance: 4 })).toHaveLength(0);
  });

  it('holds an hpThreshold ability back until the enemy is hurt enough', () => {
    const kit = [ability({ id: 'desperate', hpThresholdPct: 35 })];
    expect(selectableEnemyAbilities(kit, { ...alwaysReady, hpFraction: 0.5 })).toHaveLength(0);
    expect(selectableEnemyAbilities(kit, { ...alwaysReady, hpFraction: 0.35 })).toHaveLength(1);
    expect(selectableEnemyAbilities(kit, { ...alwaysReady, hpFraction: 0.1 })).toHaveLength(1);
  });

  it('spends a oncePerLife ability exactly once', () => {
    const kit = [ability({ id: 'ward', kind: 'self_shield', oncePerLife: true })];
    expect(selectableEnemyAbilities(kit, alwaysReady)).toHaveLength(1);
    expect(selectableEnemyAbilities(kit, { ...alwaysReady, spent: () => true })).toHaveLength(0);
  });

  it('gates phase abilities until the boss has reached that phase', () => {
    const kit = [ability({ id: 'opener' }), ability({ id: 'enraged', phase: 1 })];
    expect(selectableEnemyAbilities(kit, alwaysReady).map((a) => a.id)).toEqual(['opener']);
    expect(selectableEnemyAbilities(kit, { ...alwaysReady, phase: 1 }).map((a) => a.id)).toEqual([
      'opener',
      'enraged',
    ]);
  });

  it('respects cooldowns', () => {
    const kit = [ability({ id: 'heavy', cooldownMs: 6000 }), ability({ id: 'light' })];
    const ready = selectableEnemyAbilities(kit, {
      ...alwaysReady,
      onCooldown: (id) => id === 'heavy',
    });
    expect(ready.map((a) => a.id)).toEqual(['light']);
  });
});

describe('weighted pick', () => {
  it('splits the roll space by weight', () => {
    const kit = [ability({ id: 'common', weight: 3 }), ability({ id: 'rare', weight: 1 })];
    expect(pickEnemyAbility(kit, 0.1)?.id).toBe('common');
    expect(pickEnemyAbility(kit, 0.7)?.id).toBe('common');
    expect(pickEnemyAbility(kit, 0.9)?.id).toBe('rare');
  });

  it('returns null for an empty list and survives all-zero weights', () => {
    expect(pickEnemyAbility([], 0.5)).toBeNull();
    expect(pickEnemyAbility([ability({ id: 'only', weight: 0 })], 0.5)?.id).toBe('only');
  });
});

describe('boss phases', () => {
  const king = enemy({
    id: 'enemy_mushroom_king',
    rank: 'zone_boss',
    phases: [
      {
        atHpPct: 50,
        damageMult: 1.25,
        speedMult: 1,
        recoverMult: 0.8,
        announce: 'The spores rise',
      },
      { atHpPct: 20, damageMult: 1.5, speedMult: 1.2, recoverMult: 0.7, announce: 'ROOT AND RUIN' },
    ],
  });

  it('walks the thresholds downward as HP falls', () => {
    expect(bossPhaseAt(king, 1).index).toBe(0);
    expect(bossPhaseAt(king, 0.6).index).toBe(0);
    expect(bossPhaseAt(king, 0.5).index).toBe(1);
    expect(bossPhaseAt(king, 0.19).index).toBe(2);
  });

  it('folds that phase’s modifiers', () => {
    expect(bossPhaseAt(king, 1)).toEqual(NEUTRAL_PHASE);
    const second = bossPhaseAt(king, 0.5);
    expect(second.damageMult).toBe(1.25);
    expect(second.recoverMult).toBe(0.8);
    expect(second.announce).toBe('The spores rise');
  });

  it('never steps back when the boss is healed', () => {
    // Reaching phase 2 and then being healed to 80% keeps phase 2: a phase is
    // a fight state, not a function of current HP, or an add's heal would
    // replay the announce and undo the speed-up.
    expect(bossPhaseAt(king, 0.8, 2).index).toBe(2);
    expect(bossPhaseAt(king, 0.8, 2).damageMult).toBe(1.5);
  });

  it('sorts phases by threshold however they were authored', () => {
    const scrambled = enemy({
      id: 'enemy_scrambled',
      rank: 'zone_boss',
      phases: [{ atHpPct: 25 }, { atHpPct: 75 }],
    });
    expect(orderedPhases(scrambled).map((p) => p.atHpPct)).toEqual([75, 25]);
    expect(bossPhaseAt(scrambled, 0.5).index).toBe(1);
  });
});

describe('validateEnemyDef — P9 rules', () => {
  it('accepts a plain grunt', () => {
    expect(validateEnemyDef(enemy({ id: 'enemy_ok' }))).toEqual([]);
  });

  it('rejects a charge that cannot overshoot', () => {
    const problems = validateEnemyDef(
      enemy({
        id: 'enemy_bad_charger',
        archetype: 'charger',
        abilities: [
          ability({ id: 'pounce', kind: 'charge_rect', rangeMax: 14, chargeDistance: 12 }),
        ],
      }),
    );
    expect(problems.join(' ')).toMatch(/overshoots/);
  });

  it('rejects a cast too short to interrupt', () => {
    const problems = validateEnemyDef(
      enemy({
        id: 'enemy_fast_caster',
        archetype: 'caster',
        abilities: [ability({ id: 'zap', cast: true, windupMs: 300 })],
      }),
    );
    expect(problems.join(' ')).toMatch(/interruptible/);
  });

  it('rejects an ability gated behind a phase that does not exist', () => {
    const problems = validateEnemyDef(
      enemy({
        id: 'enemy_ghost_phase',
        rank: 'zone_boss',
        phases: [{ atHpPct: 50 }],
        abilities: [ability({ id: 'never', phase: 3 })],
      }),
    );
    expect(problems.join(' ')).toMatch(/could never fire/);
  });

  it('rejects phases on a non-boss and duplicate thresholds', () => {
    expect(
      validateEnemyDef(enemy({ id: 'enemy_pretender', phases: [{ atHpPct: 50 }] })).join(' '),
    ).toMatch(/boss feature/);
    expect(
      validateEnemyDef(
        enemy({
          id: 'enemy_dupe_phase',
          rank: 'zone_boss',
          phases: [{ atHpPct: 50 }, { atHpPct: 50 }],
        }),
      ).join(' '),
    ).toMatch(/share an atHpPct/);
  });

  it('rejects duplicate ability ids (they would share cooldown state)', () => {
    const problems = validateEnemyDef(
      enemy({ id: 'enemy_dupe', abilities: [ability({ id: 'swipe' }), ability({ id: 'swipe' })] }),
    );
    expect(problems.join(' ')).toMatch(/duplicate id/);
  });
});

describe('archetype motion (NPCS_ENEMIES.md §1 numbers, pinned once)', () => {
  it('gives ranged the doc’s 8–15 m band at 60% kite speed', () => {
    expect(ARCHETYPE_MOTION.ranged.band).toEqual({ min: 8, max: 15 });
    expect(ARCHETYPE_MOTION.ranged.kiteSpeedMult).toBe(0.6);
    expect(ARCHETYPE_MOTION.ranged.panicMeleeRange).toBe(3);
  });

  it('leaves grunts and chargers with no stand-off band', () => {
    expect(ARCHETYPE_MOTION.grunt.band).toBeNull();
    expect(ARCHETYPE_MOTION.charger.band).toBeNull();
    expect(ARCHETYPE_MOTION.charger.holdsGroundToAttack).toBe(true);
  });

  it('spreads a swarm evenly around its target instead of stacking it', () => {
    const radius = ARCHETYPE_MOTION.swarm.surroundRadius;
    expect(radius).toBeGreaterThan(0);
    const slots = [0, 1, 2, 3].map((i) => surroundSlot(10, -4, i, 4, radius));
    for (const slot of slots) {
      expect(Math.hypot(slot.x - 10, slot.z + 4)).toBeCloseTo(radius, 5);
    }
    // Four members, four distinct points around the ring.
    const keys = new Set(slots.map((s) => `${s.x.toFixed(3)},${s.z.toFixed(3)}`));
    expect(keys.size).toBe(4);
  });
});
