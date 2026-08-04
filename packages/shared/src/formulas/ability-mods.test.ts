import { describe, expect, it } from 'vitest';
import { validateAbilityDef, type AbilityDef } from '../content/abilities.js';
import { applyAbilityMods, buildEffectiveDefs } from './ability-mods.js';
import { createResourceState, rebuildResourceMax, tickResource } from './resources.js';
import { createMovementState, stepMovement } from './movement.js';
import { devTerrain } from '../world/dev-terrain.js';

const baseDef = (overrides: Record<string, unknown> = {}): AbilityDef =>
  validateAbilityDef({
    id: 'ability_warrior_crushing_blow',
    classId: 'warrior',
    binding: { kind: 'slot', slot: 1 },
    name: 'Crushing Blow',
    cost: { type: 'rage', amount: 25 },
    cooldownMs: 8000,
    targeting: { kind: 'melee_arc', angleDeg: 90, reach: 3 },
    effects: [{ kind: 'damage', coef: 1.6, staggerBonus: 20 }],
    anim: { clip: 'Sword_Attack', clipSeconds: 1.0, durationMs: 800 },
    ...overrides,
  });

describe('applyAbilityMods (P7 node fold)', () => {
  it('returns the SAME object when no mods apply (fast path)', () => {
    const def = baseDef();
    expect(applyAbilityMods(def, undefined)).toBe(def);
    expect(applyAbilityMods(def, [])).toBe(def);
  });

  it('never mutates the authored def', () => {
    const def = baseDef();
    const out = applyAbilityMods(def, [{ damagePct: 10, cooldownDeltaMs: -5000 }]);
    expect(def.cooldownMs).toBe(8000);
    expect((def.effects[0] as { coef: number }).coef).toBe(1.6);
    expect(out.cooldownMs).toBe(3000);
    expect((out.effects[0] as { coef: number }).coef).toBeCloseTo(1.76);
  });

  it('folds damage % and flat coef (Brutality, Warbringer)', () => {
    const out = applyAbilityMods(baseDef(), [{ damagePct: 20 }, { coefDelta: 0.5 }]);
    expect((out.effects[0] as { coef: number }).coef).toBeCloseTo(1.6 * 1.2 + 0.5);
  });

  it('clamps cooldown/cost floors and keeps cast ≥ 200 ms', () => {
    const caster = baseDef({
      id: 'ability_mage_fireball',
      classId: 'mage',
      cost: { type: 'mana', amount: 20 },
      castMs: 1200,
      castWhileMoving: 0.6,
    });
    const out = applyAbilityMods(caster, [
      { cooldownDeltaMs: -20000, costDelta: -30, castDeltaMs: -1500 },
    ]);
    expect(out.cooldownMs).toBe(0);
    expect(out.cost.amount).toBe(0);
    expect(out.castMs).toBe(200);
  });

  it('scales channel tick interval so the bolt count survives (Quickened Barrage)', () => {
    const barrage = baseDef({
      id: 'ability_mage_barrage',
      classId: 'mage',
      cost: { type: 'mana', amount: 35 },
      channel: { durationMs: 2400, tickEveryMs: 400 },
      targeting: { kind: 'projectile', speed: 30, radius: 0.3, maxRange: 30, homing: true },
    });
    const out = applyAbilityMods(barrage, [{ channelDeltaMs: -600 }]);
    expect(out.channel?.durationMs).toBe(1800);
    expect(out.channel?.tickEveryMs).toBe(300);
    // 2400/400 = 6 bolts before; 1800/300 = 6 bolts after.
    expect(Math.floor(out.channel!.durationMs / out.channel!.tickEveryMs)).toBe(6);
  });

  it('rewrites geometry: radius, arc, targets, ticks, teleport range', () => {
    const nova = baseDef({
      id: 'ability_mage_frost_nova',
      classId: 'mage',
      cost: { type: 'mana', amount: 25 },
      targeting: { kind: 'pbaoe', radius: 5 },
      effects: [{ kind: 'root', durationMs: 2000 }],
    });
    const outNova = applyAbilityMods(nova, [{ radiusDelta: 0.75, ccDurationDeltaMs: 500 }]);
    expect((outNova.targeting as { radius: number }).radius).toBe(5.75);
    expect((outNova.effects[0] as { durationMs: number }).durationMs).toBe(2500);

    const arc = applyAbilityMods(baseDef(), [{ arcDeltaDeg: 15, maxTargetsDelta: 1 }]);
    expect((arc.targeting as { angleDeg: number }).angleDeg).toBe(105);
    expect((arc.targeting as { maxTargets: number }).maxTargets).toBe(6);

    const blink = baseDef({
      id: 'ability_mage_blink',
      classId: 'mage',
      cost: { type: 'mana', amount: 10 },
      targeting: { kind: 'teleport', distance: 10 },
      effects: [{ kind: 'cleanse', category: 'movement' }],
    });
    expect(
      (applyAbilityMods(blink, [{ rangeDelta: 1.5 }]).targeting as { distance: number }).distance,
    ).toBe(11.5);
  });

  it('rewrites DoT riders and buff durations distinctly (Deep Wounds vs Unbreakable)', () => {
    const rending = baseDef({
      id: 'ability_warrior_rending',
      effects: [
        { kind: 'damage', coef: 0.9 },
        {
          kind: 'apply_effect',
          target: 'hit',
          effectId: 'bleed_rending',
          durationMs: 9000,
          category: 'bleed',
          mods: {
            periodic: { kind: 'damage', coefTotal: 0.9, school: 'physical', tickEveryMs: 1500 },
          },
        },
      ],
    });
    const out = applyAbilityMods(rending, [{ dotDamagePct: 15, dotDurationDeltaMs: 2000 }]);
    const dot = out.effects[1] as { durationMs: number; mods: { periodic: { coefTotal: number } } };
    expect(dot.mods.periodic.coefTotal).toBeCloseTo(1.035);
    expect(dot.durationMs).toBe(11000);

    const wall = baseDef({
      id: 'ability_warrior_shield_wall',
      cost: { type: 'none', amount: 0 },
      targeting: { kind: 'self' },
      effects: [
        {
          kind: 'apply_effect',
          target: 'self',
          effectId: 'buff_shield_wall',
          durationMs: 6000,
          mods: { damageTakenPct: -50, knockbackImmune: true },
        },
      ],
    });
    const outWall = applyAbilityMods(wall, [{ buffDurationDeltaMs: 1000, cooldownDeltaMs: -5000 }]);
    expect((outWall.effects[0] as { durationMs: number }).durationMs).toBe(7000);
  });

  it('appends unconditional addEffects but keeps category-gated ones for runtime', () => {
    const smite = baseDef({
      id: 'ability_cleric_holy_smite',
      classId: 'cleric',
      cost: { type: 'mana', amount: 15 },
      targeting: { kind: 'projectile', speed: 28, radius: 0.3, maxRange: 30 },
      effects: [{ kind: 'damage', coef: 1.3, school: 'magic' }],
    });
    const searing = {
      kind: 'apply_effect' as const,
      target: 'hit' as const,
      effectId: 'searing_smite',
      durationMs: 4000,
      stacksMax: 1,
      category: 'burn' as const,
      mods: {
        periodic: {
          kind: 'damage' as const,
          coefTotal: 0.2,
          school: 'magic' as const,
          tickEveryMs: 1000,
        },
      },
    };
    const withDot = applyAbilityMods(smite, [
      {
        addEffects: [
          validateAbilityDef({ ...smite, effects: [smite.effects[0]!, searing] }).effects[1]!,
        ],
      },
    ]);
    expect(withDot.effects).toHaveLength(2);

    const gated = applyAbilityMods(smite, [
      {
        addEffects: [withDot.effects[1]!],
        addEffectsRequireCategories: ['chill'],
      },
    ]);
    expect(gated.effects).toHaveLength(1); // runtime applies it, not the def
  });

  it('overrides mana-shield efficiency and deepens applied slows', () => {
    const shield = baseDef({
      id: 'ability_mage_mana_shield',
      classId: 'mage',
      cost: { type: 'mana', amount: 15 },
      targeting: { kind: 'self' },
      effects: [
        {
          kind: 'apply_effect',
          target: 'self',
          effectId: 'mana_shield',
          durationMs: 30000,
          mods: { manaShieldPerPoint: 2 },
        },
      ],
    });
    const out = applyAbilityMods(shield, [{ manaShieldPerPoint: 1.75 }]);
    expect(
      (out.effects[0] as { mods: { manaShieldPerPoint: number } }).mods.manaShieldPerPoint,
    ).toBe(1.75);

    const cripple = baseDef({
      id: 'ability_rogue_crippling',
      classId: 'rogue',
      cost: { type: 'energy', amount: 20 },
      effects: [
        { kind: 'damage', coef: 0.7 },
        {
          kind: 'apply_effect',
          target: 'hit',
          effectId: 'cripple',
          durationMs: 5000,
          category: 'slow',
          mods: { moveSpeedPct: -40 },
        },
      ],
    });
    const slowed = applyAbilityMods(cripple, [{ appliedMoveSpeedDeltaPct: -8 }]);
    expect((slowed.effects[1] as { mods: { moveSpeedPct: number } }).mods.moveSpeedPct).toBe(-48);
  });

  it('buildEffectiveDefs maps only touched abilities', () => {
    const def = baseDef();
    const authored = new Map([[def.id, def]]);
    const out = buildEffectiveDefs(
      authored,
      new Map([
        [def.id, [{ damagePct: 10 }]],
        ['ability_missing_row', [{ damagePct: 99 }]],
      ]),
    );
    expect(out.size).toBe(1);
    expect((out.get(def.id)!.effects[0] as { coef: number }).coef).toBeCloseTo(1.76);
  });
});

describe('resource mods (P7 pools/regen)', () => {
  it('folds flat and percent max (Conditioning, Clarity)', () => {
    const energy = createResourceState('rogue', 6, {
      maxFlat: 15,
      maxPct: 0,
      regenFlat: 0,
      regenPct: 0,
    });
    expect(energy.max).toBe(115);
    const mana = createResourceState('mage', 15, {
      maxFlat: 0,
      maxPct: 5,
      regenFlat: 0,
      regenPct: 0,
    });
    expect(mana.max).toBe(Math.round(250 * 1.05));
  });

  it('folds regen adds and percents into ticking (Vigor, Flow)', () => {
    const energy = createResourceState('rogue', 6, {
      maxFlat: 0,
      maxPct: 0,
      regenFlat: 2,
      regenPct: 0,
    });
    energy.value = 0;
    tickResource(energy, 1000, true);
    expect(energy.value).toBeCloseTo(14);

    const mana = createResourceState('mage', 15, {
      maxFlat: 0,
      maxPct: 0,
      regenFlat: 0,
      regenPct: 10,
    });
    mana.value = 0;
    tickResource(mana, 1000, false);
    expect(mana.value).toBeCloseTo(250 * 0.04 * 1.1);
  });

  it('rebuildResourceMax refills pools on level-up but never overfills rage', () => {
    const mana = createResourceState('mage', 15);
    mana.value = 10;
    rebuildResourceMax(mana, 'mage', 21, undefined, true);
    expect(mana.max).toBe(310);
    expect(mana.value).toBe(310);
    const rage = createResourceState('warrior', 6);
    rage.value = 40;
    rebuildResourceMax(rage, 'warrior', 6, undefined, true);
    expect(rage.value).toBe(40); // rage is earned, never granted
  });
});

describe('movement modifiers (P7 stamina economy)', () => {
  it('applies staminaRegenPerS and sprintStaminaPerS', () => {
    const state = createMovementState(0, devTerrain.heightAt(0, 0), 0, 100);
    state.stamina = 50;
    state.staminaIdleMs = 5000;
    stepMovement(state, { moveX: 0, moveZ: 0, yaw: 0, buttons: 0 }, 1, devTerrain, {
      staminaRegenPerS: 20,
    });
    expect(state.stamina).toBeCloseTo(70, 0);

    const sprinter = createMovementState(0, devTerrain.heightAt(0, 0), 0, 100);
    sprinter.grounded = true;
    stepMovement(sprinter, { moveX: 0, moveZ: 1, yaw: 0, buttons: 1 }, 1, devTerrain, {
      sprintStaminaPerS: 7,
    });
    expect(sprinter.stamina).toBeCloseTo(93, 0);
  });
});
