import { describe, expect, it } from 'vitest';
import { validateAbilityDef } from './abilities.js';

/** A minimal valid Mage ground ability; overrides per test. */
const groundDef = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'ability_mage_test_meteor',
  classId: 'mage',
  binding: { kind: 'slot', slot: 8 },
  name: 'Test Meteor',
  cost: { type: 'mana', amount: 50 },
  cooldownMs: 60000,
  castMs: 800,
  targeting: { kind: 'ground_aoe', radius: 5, maxRange: 25, telegraphMs: 1500 },
  effects: [{ kind: 'damage', coef: 3.2, school: 'magic', staggerBonus: 40 }],
  anim: { clip: 'Spell_Double', clipSeconds: 1.2, durationMs: 800, contactFraction: 0.6 },
  ...overrides,
});

describe('ability schema — P6 caster/status vocabulary', () => {
  it('accepts ground_aoe targeting with a telegraph', () => {
    const def = validateAbilityDef(groundDef());
    if (def.targeting.kind !== 'ground_aoe') throw new Error('wrong kind');
    expect(def.targeting.telegraphMs).toBe(1500);
    expect(def.targeting.maxTargets).toBe(10); // default
  });

  it('accepts the new effect kinds: root, cleanse, refresh, zone', () => {
    const def = validateAbilityDef(
      groundDef({
        effects: [
          { kind: 'damage', coef: 0.7, school: 'magic' },
          { kind: 'root', durationMs: 2000 },
          { kind: 'cleanse', category: 'movement', count: 2 },
          { kind: 'refresh', category: 'burn' },
          {
            kind: 'zone',
            radius: 4,
            durationMs: 8000,
            tickEveryMs: 1000,
            team: 'allies',
            tick: { kind: 'heal', coef: 0.35 },
          },
        ],
      }),
    );
    expect(def.effects).toHaveLength(5);
  });

  it('zone effects demand ground_aoe targeting', () => {
    expect(() =>
      validateAbilityDef(
        groundDef({
          targeting: { kind: 'self' },
          effects: [
            {
              kind: 'zone',
              radius: 4,
              durationMs: 8000,
              tickEveryMs: 1000,
              team: 'allies',
              tick: { kind: 'heal', coef: 0.35 },
            },
          ],
        }),
      ),
    ).toThrow(/ground_aoe/);
  });

  it('mana costs are Mage/Cleric-only', () => {
    expect(() => validateAbilityDef(groundDef({ classId: 'warrior' }))).toThrow(/Mage\/Cleric/);
  });

  it('accepts teleport targeting, homing projectiles and the new mods', () => {
    const blink = validateAbilityDef(
      groundDef({
        id: 'ability_mage_test_blink',
        castMs: 0,
        cooldownMs: 12000,
        targeting: { kind: 'teleport', distance: 10 },
        effects: [
          { kind: 'cleanse', category: 'movement', all: true },
          {
            kind: 'apply_effect',
            target: 'self',
            effectId: 'buff_blink_ghost',
            durationMs: 500,
            mods: { untargetable: true },
          },
        ],
      }),
    );
    expect(blink.targeting.kind).toBe('teleport');

    const barrage = validateAbilityDef(
      groundDef({
        id: 'ability_mage_test_barrage',
        castMs: 0,
        channel: { durationMs: 2400, tickEveryMs: 400 },
        castWhileMoving: 0.4,
        targeting: { kind: 'projectile', speed: 30, radius: 0.3, maxRange: 30, homing: true },
        effects: [{ kind: 'damage', coef: 0.55, school: 'magic' }],
      }),
    );
    if (barrage.targeting.kind !== 'projectile') throw new Error('wrong kind');
    expect(barrage.targeting.homing).toBe(true);

    const shieldDef = validateAbilityDef(
      groundDef({
        id: 'ability_mage_test_mana_shield',
        castMs: 0,
        targeting: { kind: 'self' },
        effects: [
          {
            kind: 'apply_effect',
            target: 'self',
            effectId: 'buff_mana_shield',
            durationMs: 30000,
            mods: { manaShieldPerPoint: 2 },
          },
        ],
      }),
    );
    expect(shieldDef.effects[0]?.kind).toBe('apply_effect');
  });

  it('damage bonusVs categories parse (Ice Lance vs chilled/rooted)', () => {
    const lance = validateAbilityDef(
      groundDef({
        id: 'ability_mage_test_lance',
        castMs: 0,
        targeting: { kind: 'projectile', speed: 35, radius: 0.25, maxRange: 30 },
        effects: [
          {
            kind: 'damage',
            coef: 1.0,
            school: 'magic',
            bonusVs: { categories: ['chill', 'root'], pct: 50 },
          },
          {
            kind: 'apply_effect',
            target: 'hit',
            effectId: 'chill_lance',
            durationMs: 4000,
            category: 'chill',
            mods: { moveSpeedPct: -20 },
          },
        ],
      }),
    );
    const damage = lance.effects[0];
    if (damage?.kind !== 'damage') throw new Error('wrong kind');
    expect(damage.bonusVs?.pct).toBe(50);
  });
});
