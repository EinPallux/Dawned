import { describe, expect, it } from 'vitest';
import { GCD_MS } from '../constants.js';
import { validateAbilityDef, type AbilityDef } from '../content/abilities.js';
import {
  AbilityRejectReason,
  CAST_MOVE_GRACE_MS,
  commitUse,
  cooldownRemainingMs,
  createAbilityMachine,
  evaluateUse,
  exportCooldowns,
  importCooldowns,
  interruptCast,
  tickAbilityMachine,
} from './ability-machine.js';
import { createResourceState } from './resources.js';

/** Minimal valid warrior arc ability; overrides per test. */
const makeDef = (overrides: Record<string, unknown> = {}): AbilityDef =>
  validateAbilityDef({
    id: 'ability_warrior_test_blow',
    classId: 'warrior',
    binding: { kind: 'slot', slot: 1 },
    name: 'Test Blow',
    unlockLevel: 1,
    cost: { type: 'rage', amount: 25 },
    cooldownMs: 10000,
    targeting: { kind: 'melee_arc', angleDeg: 90, reach: 3 },
    effects: [{ kind: 'damage', coef: 1.6, school: 'physical' }],
    anim: { clip: 'Sword_Attack', clipSeconds: 1.0, durationMs: 600, contactFraction: 0.5 },
    ...overrides,
  });

const readyContext = (rage = 100) => {
  const resource = createResourceState('warrior', 13);
  resource.value = rage;
  return { level: 30, alive: true, resource, hasTarget: false };
};

describe('ability machine', () => {
  it('happy path: evaluate ok, commit pays cost and starts cooldown + GCD', () => {
    const machine = createAbilityMachine();
    const def = makeDef();
    const ctx = readyContext();
    expect(evaluateUse(machine, def, ctx)).toEqual({ ok: true });
    const commit = commitUse(machine, def, ctx.resource, { yaw: 0, pitch: 0, targetId: 0 });
    expect(commit.phase).toBe('instant');
    expect(commit.contactDelayMs).toBe(300);
    expect(ctx.resource.value).toBe(75);
    expect(cooldownRemainingMs(machine, def.id)).toBe(10000);
    expect(machine.gcdUntilMs).toBe(GCD_MS);
  });

  it('rejects in priority order: dead, locked, gcd, cooldown, resource, cp', () => {
    const machine = createAbilityMachine();
    const def = makeDef();
    const ctx = readyContext();

    expect(evaluateUse(machine, def, { ...ctx, alive: false })).toEqual({
      ok: false,
      reason: AbilityRejectReason.Dead,
    });
    expect(evaluateUse(machine, def, { ...ctx, level: 1 })).toEqual({ ok: true }); // unlock 1
    expect(evaluateUse(machine, makeDef({ unlockLevel: 10 }), { ...ctx, level: 5 })).toEqual({
      ok: false,
      reason: AbilityRejectReason.Locked,
    });

    commitUse(machine, def, ctx.resource, { yaw: 0, pitch: 0, targetId: 0 });
    // Immediately after: GCD blocks (fires before per-ability cooldown).
    expect(evaluateUse(machine, makeDef({ id: 'ability_warrior_other' }), ctx)).toEqual({
      ok: false,
      reason: AbilityRejectReason.OnGcd,
    });
    tickAbilityMachine(machine, GCD_MS, false);
    expect(evaluateUse(machine, def, ctx)).toEqual({
      ok: false,
      reason: AbilityRejectReason.OnCooldown,
    });

    const poor = readyContext(10);
    const offCd = makeDef({ id: 'ability_warrior_pricey' });
    expect(evaluateUse(machine, offCd, poor)).toEqual({
      ok: false,
      reason: AbilityRejectReason.NoResource,
    });
  });

  it('cooldown refills the charge exactly on time', () => {
    const machine = createAbilityMachine();
    const def = makeDef();
    const ctx = readyContext();
    commitUse(machine, def, ctx.resource, { yaw: 0, pitch: 0, targetId: 0 });
    tickAbilityMachine(machine, 9999, false);
    expect(evaluateUse(machine, def, ctx)).toEqual({
      ok: false,
      reason: AbilityRejectReason.OnCooldown,
    });
    tickAbilityMachine(machine, 1, false);
    expect(evaluateUse(machine, def, ctx)).toEqual({ ok: true });
    expect(cooldownRemainingMs(machine, def.id)).toBe(0);
  });

  it('finishers demand combo points', () => {
    const machine = createAbilityMachine();
    const finisher = validateAbilityDef({
      id: 'ability_rogue_test_eviscerate',
      classId: 'rogue',
      binding: { kind: 'slot', slot: 3 },
      name: 'Test Eviscerate',
      cost: { type: 'energy', amount: 30 },
      comboFinisher: true,
      targeting: { kind: 'melee_arc', angleDeg: 60, reach: 2.5 },
      effects: [{ kind: 'damage', coef: 0.9, coefPerComboPoint: 0.5 }],
      anim: { clip: 'Sword_Attack_Standing', clipSeconds: 0.9, durationMs: 500 },
    });
    const resource = createResourceState('rogue', 10);
    const ctx = { level: 30, alive: true, resource, hasTarget: false };
    expect(evaluateUse(machine, finisher, ctx)).toEqual({
      ok: false,
      reason: AbilityRejectReason.NoComboPoints,
    });
    resource.comboPoints = 3;
    expect(evaluateUse(machine, finisher, ctx)).toEqual({ ok: true });
  });

  it('single-target abilities need a target', () => {
    const machine = createAbilityMachine();
    const mark = makeDef({
      id: 'ability_warrior_pointy',
      cost: { type: 'none', amount: 0 },
      targeting: { kind: 'single', maxRange: 15 },
    });
    expect(evaluateUse(machine, mark, readyContext())).toEqual({
      ok: false,
      reason: AbilityRejectReason.NoTarget,
    });
    expect(evaluateUse(machine, mark, { ...readyContext(), hasTarget: true })).toEqual({
      ok: true,
    });
  });

  it('casts: commit starts the bar, tick releases at castMs with press aim', () => {
    const machine = createAbilityMachine();
    const cast = makeDef({ id: 'ability_warrior_casty', castMs: 1500 });
    const ctx = readyContext();
    const commit = commitUse(machine, cast, ctx.resource, { yaw: 1.5, pitch: 0.1, targetId: 7 });
    expect(commit.phase).toBe('cast');
    expect(evaluateUse(machine, makeDef(), ctx)).toEqual({
      ok: false,
      reason: AbilityRejectReason.AlreadyCasting,
    });
    expect(tickAbilityMachine(machine, 1499, false).released).toBeNull();
    const done = tickAbilityMachine(machine, 1, false);
    expect(done.released).toEqual({
      abilityId: 'ability_warrior_casty',
      aimYaw: 1.5,
      aimPitch: 0.1,
      targetId: 7,
    });
    expect(machine.cast).toBeNull();
  });

  it('moving cancels a rooted cast only past the 150 ms grace', () => {
    const machine = createAbilityMachine();
    const rooted = makeDef({ id: 'ability_warrior_rooted', castMs: 2000, castWhileMoving: false });
    commitUse(machine, rooted, readyContext().resource, { yaw: 0, pitch: 0, targetId: 0 });
    expect(tickAbilityMachine(machine, CAST_MOVE_GRACE_MS, true).moveCanceled).toBe(false);
    // Stopping resets the grace accumulator.
    tickAbilityMachine(machine, 100, false);
    expect(tickAbilityMachine(machine, CAST_MOVE_GRACE_MS, true).moveCanceled).toBe(false);
    expect(tickAbilityMachine(machine, 1, true).moveCanceled).toBe(true);
    expect(machine.cast).toBeNull();
  });

  it('dodge interrupt refunds half the cost; stun refunds nothing', () => {
    const machine = createAbilityMachine();
    const cast = makeDef({ id: 'ability_warrior_casty2', castMs: 1500 });
    commitUse(machine, cast, readyContext().resource, { yaw: 0, pitch: 0, targetId: 0 });
    expect(interruptCast(machine, 'dodge', 25)).toEqual({ hadCast: true, refund: 12 });
    expect(interruptCast(machine, 'dodge', 25)).toEqual({ hadCast: false, refund: 0 });
    commitUse(machine, cast, readyContext().resource, { yaw: 0, pitch: 0, targetId: 0 });
    expect(interruptCast(machine, 'stun', 25)).toEqual({ hadCast: true, refund: 0 });
  });

  it('cooldown export/import round-trips (resume + reject correction)', () => {
    const machine = createAbilityMachine();
    const def = makeDef();
    commitUse(machine, def, readyContext().resource, { yaw: 0, pitch: 0, targetId: 0 });
    tickAbilityMachine(machine, 4000, false);
    const exported = exportCooldowns(machine);
    expect(exported[def.id]).toBe(6000);

    const fresh = createAbilityMachine();
    importCooldowns(fresh, exported, new Map([[def.id, def]]));
    expect(cooldownRemainingMs(fresh, def.id)).toBe(6000);
    expect(evaluateUse(fresh, def, readyContext())).toEqual({
      ok: false,
      reason: AbilityRejectReason.OnCooldown,
    });
    tickAbilityMachine(fresh, 6000, false);
    expect(evaluateUse(fresh, def, readyContext())).toEqual({ ok: true });
  });

  it('channels: commit starts it, ticks fire on schedule, ends after duration', () => {
    const machine = createAbilityMachine();
    const barrage = makeDef({
      id: 'ability_warrior_channely',
      channel: { durationMs: 2400, tickEveryMs: 400 },
      castWhileMoving: 0.4,
    });
    const ctx = readyContext();
    const commit = commitUse(machine, barrage, ctx.resource, { yaw: 0.7, pitch: 0, targetId: 9 });
    expect(commit.phase).toBe('channel');
    // Channeling blocks other presses like a cast does.
    expect(evaluateUse(machine, makeDef({ id: 'ability_warrior_other2' }), ctx)).toEqual({
      ok: false,
      reason: AbilityRejectReason.AlreadyCasting,
    });
    // 6 ticks at 400 ms across the 2400 ms duration (first after one interval).
    let ticks = 0;
    for (let step = 0; step < 6; step++) {
      const result = tickAbilityMachine(machine, 400, false);
      ticks += result.channelTicks.length;
      expect(result.channelTicks.every((t) => t.abilityId === barrage.id && t.targetId === 9)).toBe(
        true,
      );
    }
    expect(ticks).toBe(6);
    expect(machine.channel).toBeNull();
    // A slow frame catches up multiple ticks at once.
    const machine2 = createAbilityMachine();
    commitUse(machine2, barrage, readyContext().resource, { yaw: 0, pitch: 0, targetId: 0 });
    const bigStep = tickAbilityMachine(machine2, 1000, false);
    expect(bigStep.channelTicks.length).toBe(2);
  });

  it('channels: moving cancels only when castWhileMoving is false; dodge interrupts', () => {
    const machine = createAbilityMachine();
    const mobile = makeDef({
      id: 'ability_warrior_mobile_channel',
      channel: { durationMs: 1200, tickEveryMs: 400 },
      castWhileMoving: 0.4,
    });
    commitUse(machine, mobile, readyContext().resource, { yaw: 0, pitch: 0, targetId: 0 });
    expect(tickAbilityMachine(machine, 800, true).moveCanceled).toBe(false);
    expect(machine.channel).not.toBeNull();

    const rooted = makeDef({
      id: 'ability_warrior_rooted_channel',
      channel: { durationMs: 1200, tickEveryMs: 400 },
      castWhileMoving: false,
    });
    const machine3 = createAbilityMachine();
    commitUse(machine3, rooted, readyContext().resource, { yaw: 0, pitch: 0, targetId: 0 });
    tickAbilityMachine(machine3, CAST_MOVE_GRACE_MS, true);
    expect(tickAbilityMachine(machine3, 1, true).moveCanceled).toBe(true);
    expect(machine3.channel).toBeNull();

    // Dodge interrupt clears the channel and refunds half the cost.
    const machine4 = createAbilityMachine();
    commitUse(machine4, mobile, readyContext().resource, { yaw: 0, pitch: 0, targetId: 0 });
    expect(interruptCast(machine4, 'dodge', 30)).toEqual({ hadCast: true, refund: 15 });
    expect(machine4.channel).toBeNull();
  });

  it('zero-cooldown abilities never consume charges — spammable past the GCD', () => {
    // Regression (round 7): commit burned the only charge but a cd-0 def never
    // arms a recharge timer, bricking every spender after ONE use — on both
    // sides, so the server agreed and no correction ever came.
    const machine = createAbilityMachine();
    const def = makeDef({ cooldownMs: 0 });
    for (let press = 0; press < 4; press++) {
      const ctx = readyContext();
      expect(evaluateUse(machine, def, ctx)).toEqual({ ok: true });
      commitUse(machine, def, ctx.resource, { yaw: 0, pitch: 0, targetId: 0 });
      expect(cooldownRemainingMs(machine, def.id)).toBe(0);
      tickAbilityMachine(machine, GCD_MS + 10, false); // clear the GCD between presses
    }
  });
});
