import { describe, expect, it } from 'vitest';
import {
  cloneMovementState,
  createMovementState,
  beginDash,
  endDash,
  flatTerrain,
  isDodgeInvulnerable,
  maxHorizontalStep,
  maxStaminaFor,
  stepMovement,
  type MovementIntent,
  type MovementState,
  type TerrainSampler,
} from './movement.js';
import {
  BASE_STAMINA,
  DODGE_COOLDOWN_MS,
  DODGE_DISTANCE_M,
  DODGE_DURATION_S,
  DODGE_STAMINA_COST,
  FALL_DAMAGE_MAX_FRACTION,
  MOVE_SPEED,
  SPRINT_MULTIPLIER,
  SPRINT_STAMINA_PER_SEC,
  TICK_DT,
} from '../constants.js';
import { InputButton } from '../protocol/opcodes.js';

const ground = flatTerrain(0);
const idle: MovementIntent = { moveX: 0, moveZ: 0, yaw: 0, buttons: 0 };
const forward: MovementIntent = { moveX: 0, moveZ: 1, yaw: 0, buttons: 0 };
const forwardSprint: MovementIntent = { ...forward, buttons: InputButton.Sprint };

/** Run `ticks` fixed steps and return the state (mutated in place). */
const simulate = (
  state: MovementState,
  intent: MovementIntent,
  ticks: number,
  terrain: TerrainSampler = ground,
): MovementState => {
  for (let i = 0; i < ticks; i++) stepMovement(state, intent, TICK_DT, terrain);
  return state;
};

describe('stepMovement — horizontal', () => {
  it('reaches jog speed and holds it', () => {
    const state = simulate(createMovementState(), forward, 40);
    expect(Math.hypot(state.vx, state.vz)).toBeCloseTo(MOVE_SPEED, 4);
  });

  it('sprints faster than it jogs and drains stamina for it', () => {
    const jog = simulate(createMovementState(), forward, 40);
    const sprint = simulate(createMovementState(), forwardSprint, 40);
    expect(Math.hypot(sprint.vx, sprint.vz)).toBeCloseTo(MOVE_SPEED * SPRINT_MULTIPLIER, 4);
    expect(sprint.stamina).toBeLessThan(jog.stamina);
    expect(sprint.stamina).toBeCloseTo(BASE_STAMINA - SPRINT_STAMINA_PER_SEC * 40 * TICK_DT, 4);
  });

  it('never lets a diagonal outrun a straight line', () => {
    const straight = simulate(createMovementState(), forward, 60);
    const diagonal = simulate(createMovementState(), { ...forward, moveX: 1, moveZ: 1 }, 60);
    expect(Math.hypot(diagonal.vx, diagonal.vz)).toBeLessThanOrEqual(
      Math.hypot(straight.vx, straight.vz) + 1e-6,
    );
  });

  it('decelerates to a stop when input is released', () => {
    const state = simulate(createMovementState(), forward, 40);
    simulate(state, idle, 30);
    expect(Math.hypot(state.vx, state.vz)).toBeCloseTo(0, 5);
  });

  it('stops sprinting when stamina runs out', () => {
    const state = createMovementState();
    state.stamina = 2; // below SPRINT_MIN_STAMINA — cannot start
    simulate(state, forwardSprint, 20);
    expect(state.sprinting).toBe(false);
    expect(Math.hypot(state.vx, state.vz)).toBeCloseTo(MOVE_SPEED, 4);
  });

  it('regenerates stamina only after the idle delay', () => {
    const state = createMovementState();
    simulate(state, forwardSprint, 20); // spend
    const spent = state.stamina;
    simulate(state, forward, 10); // 0.5 s — still inside the 1 s delay
    expect(state.stamina).toBe(spent);
    simulate(state, forward, 40); // now past it
    expect(state.stamina).toBeGreaterThan(spent);
  });

  it('clamps stamina to the pool for the character', () => {
    const max = maxStaminaFor(30, 20);
    const state = createMovementState(0, 0, 0, max);
    simulate(state, idle, 400);
    expect(state.stamina).toBe(max);
    expect(max).toBe(BASE_STAMINA + 5 * 20 + 2 * 29);
  });

  it('keeps the character inside world bounds', () => {
    const state = createMovementState();
    simulate(state, { moveX: 1, moveZ: 0, yaw: 0, buttons: InputButton.Sprint }, 20_000);
    expect(Math.abs(state.x)).toBeLessThanOrEqual(1024);
  });

  it('respects the anti-speedhack step bound every tick', () => {
    const state = createMovementState();
    const bound = maxHorizontalStep(TICK_DT);
    for (let i = 0; i < 200; i++) {
      const before = { x: state.x, z: state.z };
      stepMovement(state, { ...forwardSprint, moveX: 1 }, TICK_DT, ground);
      const travelled = Math.hypot(state.x - before.x, state.z - before.z);
      expect(travelled).toBeLessThanOrEqual(bound + 1e-6);
    }
  });
});

describe('stepMovement — vertical', () => {
  it('jumps, rises, and lands back on the ground', () => {
    const state = createMovementState();
    const jump = stepMovement(state, { ...idle, buttons: InputButton.Jump }, TICK_DT, ground);
    expect(jump.jumped).toBe(true);
    expect(state.grounded).toBe(false);

    let landedTick = -1;
    let apex = state.y;
    for (let i = 0; i < 60; i++) {
      const result = stepMovement(state, idle, TICK_DT, ground);
      apex = Math.max(apex, state.y);
      if (result.landed) {
        landedTick = i;
        break;
      }
    }
    expect(apex).toBeGreaterThan(0.9);
    expect(apex).toBeLessThan(1.4);
    expect(landedTick).toBeGreaterThan(0);
    expect(state.grounded).toBe(true);
    expect(state.y).toBe(0);
  });

  it('cannot double-jump in mid-air', () => {
    const state = createMovementState();
    stepMovement(state, { ...idle, buttons: InputButton.Jump }, TICK_DT, ground);
    const second = stepMovement(state, { ...idle, buttons: InputButton.Jump }, TICK_DT, ground);
    expect(second.jumped).toBe(false);
  });

  it('takes no fall damage below the threshold', () => {
    const state = createMovementState(0, 10, 0);
    state.grounded = false;
    state.fallPeakY = 10;
    let damage = 0;
    for (let i = 0; i < 200; i++) {
      const result = stepMovement(state, idle, TICK_DT, ground);
      if (result.landed) {
        damage = result.fallDamageFraction;
        break;
      }
    }
    expect(damage).toBe(0);
  });

  it('applies 6% per metre beyond 12 m', () => {
    const state = createMovementState(0, 20, 0);
    state.grounded = false;
    state.fallPeakY = 20;
    let result = { fallDamageFraction: 0, fallDistance: 0 };
    for (let i = 0; i < 400; i++) {
      const step = stepMovement(state, idle, TICK_DT, ground);
      if (step.landed) {
        result = step;
        break;
      }
    }
    expect(result.fallDistance).toBeCloseTo(20, 1);
    expect(result.fallDamageFraction).toBeCloseTo((20 - 12) * 0.06, 2);
  });

  it('caps fall damage so a full-HP character survives any drop', () => {
    const state = createMovementState(0, 900, 0);
    state.grounded = false;
    state.fallPeakY = 900;
    let damage = 0;
    for (let i = 0; i < 2000; i++) {
      const step = stepMovement(state, idle, TICK_DT, ground);
      if (step.landed) {
        damage = step.fallDamageFraction;
        break;
      }
    }
    expect(damage).toBe(FALL_DAMAGE_MAX_FRACTION);
    expect(damage).toBeLessThan(1);
  });

  it('lands on raised terrain instead of falling through it', () => {
    const plateau: TerrainSampler = { heightAt: (x) => (x > 5 ? 3 : 0) };
    const state = createMovementState(0, 0, 0);
    simulate(state, { moveX: 1, moveZ: 0, yaw: 0, buttons: 0 }, 60, plateau);
    expect(state.x).toBeGreaterThan(5);
    expect(state.y).toBe(3);
    expect(state.grounded).toBe(true);
  });
});

describe('stepMovement — downhill ground snap', () => {
  /** A 30° descent along +Z (drops ~0.16 m per jog tick — well within snap range). */
  const downhill: TerrainSampler = { heightAt: (_x, z) => -z * Math.tan(Math.PI / 6) };

  it('stays grounded on every tick of a downhill run (no state flicker)', () => {
    const state = createMovementState(0, 0, 0);
    simulate(state, forwardSprint, 10, downhill); // up to speed
    for (let i = 0; i < 100; i++) {
      stepMovement(state, forwardSprint, TICK_DT, downhill);
      expect(state.grounded).toBe(true);
      expect(state.y).toBeCloseTo(downhill.heightAt(state.x, state.z), 6);
    }
  });

  it('takes no fall damage from a long glued descent', () => {
    const state = createMovementState(0, 0, 0);
    for (let i = 0; i < 200; i++) {
      const result = stepMovement(state, forwardSprint, TICK_DT, downhill);
      expect(result.fallDamageFraction).toBe(0);
    }
    expect(state.y).toBeLessThan(-20); // genuinely descended a long way
  });

  it('jumping still leaves the ground on a slope', () => {
    const state = createMovementState(0, 0, 0);
    simulate(state, forward, 10, downhill);
    stepMovement(state, { ...forward, buttons: InputButton.Jump }, TICK_DT, downhill);
    expect(state.grounded).toBe(false);
    expect(state.vy).toBeGreaterThan(0);
  });

  it('a drop beyond the snap height is a real fall', () => {
    // Walkable plateau ending in a 3 m cliff at z = 2.
    const cliff: TerrainSampler = { heightAt: (_x, z) => (z < 2 ? 0 : -3) };
    const state = createMovementState(0, 0, 0);
    simulate(state, forward, 10, cliff);
    let wentAirborne = false;
    for (let i = 0; i < 40; i++) {
      stepMovement(state, forward, TICK_DT, cliff);
      if (!state.grounded) wentAirborne = true;
    }
    expect(wentAirborne).toBe(true);
    expect(state.y).toBeCloseTo(-3, 5); // and landed below
    expect(state.grounded).toBe(true);
  });
});

describe('client/server prediction parity', () => {
  it('produces bit-identical state for identical input streams', () => {
    // This is the whole anti-desync promise: two independent runs of the same code
    // over the same inputs must not drift by even a float ulp.
    const scripted: MovementIntent[] = [];
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 10_000; i++) {
      scripted.push({
        moveX: rand() * 2 - 1,
        moveZ: rand() * 2 - 1,
        yaw: rand() * Math.PI * 2,
        buttons:
          (rand() > 0.5 ? InputButton.Sprint : 0) |
          (rand() > 0.95 ? InputButton.Jump : 0) |
          (rand() > 0.9 ? InputButton.Dodge : 0),
      });
    }

    const rolling: TerrainSampler = {
      heightAt: (x, z) => Math.sin(x * 0.05) * 2 + Math.cos(z * 0.05) * 2,
    };

    const clientState = createMovementState(0, 0, 0);
    const serverState = createMovementState(0, 0, 0);
    for (const intent of scripted) {
      stepMovement(clientState, intent, TICK_DT, rolling);
      stepMovement(serverState, intent, TICK_DT, rolling);
    }

    expect(clientState).toEqual(serverState);
  });

  it('replays from a snapshot to the same state (reconciliation contract)', () => {
    // The client rewinds to the server's authoritative state and replays unacked
    // inputs; replaying must land exactly where continuous simulation would.
    const intents: MovementIntent[] = Array.from({ length: 12 }, (_, i) => ({
      moveX: i % 3 === 0 ? 1 : -0.4,
      moveZ: 1,
      yaw: i * 0.3,
      buttons: i % 4 === 0 ? InputButton.Sprint : 0,
    }));

    const continuous = createMovementState();
    for (const intent of intents) stepMovement(continuous, intent, TICK_DT, ground);

    const authoritative = createMovementState();
    for (const intent of intents.slice(0, 5)) stepMovement(authoritative, intent, TICK_DT, ground);

    const replayed = cloneMovementState(authoritative);
    for (const intent of intents.slice(5)) stepMovement(replayed, intent, TICK_DT, ground);

    expect(replayed).toEqual(continuous);
  });
});

describe('stepMovement — dodge roll (COMBAT.md §7)', () => {
  const dodgeForward: MovementIntent = { moveX: 0, moveZ: 1, yaw: 0, buttons: InputButton.Dodge };

  it('covers the spec distance in the spec duration, then hands back control', () => {
    const state = createMovementState();
    const ticksInRoll = Math.round(DODGE_DURATION_S / TICK_DT);
    const first = stepMovement(state, dodgeForward, TICK_DT, ground);
    expect(first.dodged).toBe(true);
    // Keep only the roll's own motion: release input after the start tick.
    simulate(state, idle, ticksInRoll - 1);
    expect(state.z).toBeCloseTo(DODGE_DISTANCE_M, 3);
    expect(state.rollTimeLeft).toBe(0);
  });

  it('locks the direction at start — steering mid-roll is ignored', () => {
    const state = createMovementState();
    stepMovement(state, dodgeForward, TICK_DT, ground);
    simulate(state, { moveX: 1, moveZ: 0, yaw: 0, buttons: 0 }, 6);
    // Still travelling +Z; the sideways input has not bent the path.
    expect(Math.abs(state.x)).toBeLessThan(0.2);
    expect(state.vz).toBeGreaterThan(state.vx);
  });

  it('rolls toward the facing when no movement is held', () => {
    const state = createMovementState();
    const yaw = Math.PI / 2; // facing +X
    stepMovement(state, { moveX: 0, moveZ: 0, yaw, buttons: InputButton.Dodge }, TICK_DT, ground);
    simulate(state, { moveX: 0, moveZ: 0, yaw, buttons: 0 }, 10);
    expect(state.x).toBeGreaterThan(3.5);
    expect(Math.abs(state.z)).toBeLessThan(0.01);
  });

  it('spends stamina per roll; held button chains at the duration cadence', () => {
    // The 0.5 s internal cooldown expires INSIDE the 0.55 s roll, so a held
    // button re-rolls the tick after a roll ends — never during one. Two full
    // roll cycles fit in 2 × duration worth of ticks.
    const state = createMovementState();
    const held: MovementIntent = { ...dodgeForward };
    const ticksPerRoll = Math.round(DODGE_DURATION_S / TICK_DT);
    let dodges = 0;
    for (let i = 0; i < ticksPerRoll * 2; i++) {
      if (stepMovement(state, held, TICK_DT, ground).dodged) dodges++;
    }
    expect(dodges).toBe(2);
    expect(state.stamina).toBeCloseTo(BASE_STAMINA - DODGE_STAMINA_COST * 2, 1);
    // A double-tap inside one roll is refused by the cooldown+rolling gates.
    expect(DODGE_COOLDOWN_MS / 1000).toBeLessThan(DODGE_DURATION_S * 2);
  });

  it('refuses without stamina and while airborne', () => {
    const broke = createMovementState();
    broke.stamina = DODGE_STAMINA_COST - 1;
    expect(stepMovement(broke, dodgeForward, TICK_DT, ground).dodged).toBe(false);

    const airborne = createMovementState();
    stepMovement(airborne, { ...dodgeForward, buttons: InputButton.Jump }, TICK_DT, ground);
    expect(airborne.grounded).toBe(false);
    const midair = stepMovement(airborne, dodgeForward, TICK_DT, ground);
    expect(midair.dodged).toBe(false);
  });

  it('exposes the i-frame window at 0.05–0.35 s of the roll', () => {
    const state = createMovementState();
    const windows: boolean[] = [];
    stepMovement(state, dodgeForward, TICK_DT, ground);
    windows.push(isDodgeInvulnerable(state));
    for (let i = 0; i < 11; i++) {
      simulate(state, idle, 1);
      windows.push(isDodgeInvulnerable(state));
    }
    // Post-tick states: ticks 1–7 (elapsed 0.05–0.35 s) are invulnerable,
    // the tail of the roll and the recovery are not.
    expect(windows).toEqual([
      true, // elapsed 0.05
      true,
      true,
      true,
      true,
      true,
      true, // elapsed 0.35
      false, // elapsed 0.40 — vulnerable recovery
      false,
      false,
      false, // roll over
      false,
    ]);
  });

  it('suppresses sprint and jump while rolling', () => {
    const state = createMovementState();
    stepMovement(state, dodgeForward, TICK_DT, ground);
    const result = stepMovement(
      state,
      { moveX: 0, moveZ: 1, yaw: 0, buttons: InputButton.Sprint | InputButton.Jump },
      TICK_DT,
      ground,
    );
    expect(result.jumped).toBe(false);
    expect(state.sprinting).toBe(false);
    expect(state.grounded).toBe(true);
  });

  it('a roll into deep water becomes a swim and the roll ends', () => {
    const shoreline: TerrainSampler = {
      heightAt: (_x, z) => (z < 2 ? 0 : -4),
      waterLevelAt: (_x, z) => (z < 2 ? null : 0.5),
    };
    const state = createMovementState();
    stepMovement(state, dodgeForward, TICK_DT, shoreline);
    simulate(state, idle, 12, shoreline);
    expect(state.swimming).toBe(true);
    expect(state.rollTimeLeft).toBe(0);
  });
});

describe('movement modifiers (P5 stances/effects)', () => {
  it('speedMult scales ground speed on both sides of 1', () => {
    const slow = createMovementState();
    const fast = createMovementState();
    const plain = createMovementState();
    for (let i = 0; i < 40; i++) {
      stepMovement(slow, forward, TICK_DT, ground, { speedMult: 0.6 });
      stepMovement(fast, forward, TICK_DT, ground, { speedMult: 1.1 });
      stepMovement(plain, forward, TICK_DT, ground);
    }
    expect(slow.z).toBeLessThan(plain.z * 0.7);
    expect(fast.z).toBeGreaterThan(plain.z * 1.05);
  });

  it('dodgeCostDelta discounts the roll and gates on the discounted price', () => {
    const dodge: MovementIntent = { moveX: 0, moveZ: 1, yaw: 0, buttons: InputButton.Dodge };
    // 20 stamina: a plain roll (25) is unaffordable, Evasive (-10 → 15) rolls.
    const plain = createMovementState();
    plain.stamina = 20;
    stepMovement(plain, dodge, TICK_DT, ground);
    expect(plain.rollTimeLeft).toBe(0);

    const evasive = createMovementState();
    evasive.stamina = 20;
    stepMovement(evasive, dodge, TICK_DT, ground, { dodgeCostDelta: -10 });
    expect(evasive.rollTimeLeft).toBeGreaterThan(0);
    expect(evasive.stamina).toBe(5);
  });

  it('modifiers leave the neutral path bit-identical (anti-desync)', () => {
    const withMods = createMovementState();
    const without = createMovementState();
    for (let i = 0; i < 60; i++) {
      stepMovement(withMods, forwardSprint, TICK_DT, ground, { speedMult: 1, dodgeCostDelta: 0 });
      stepMovement(without, forwardSprint, TICK_DT, ground);
    }
    expect(withMods).toEqual(without);
  });
});

describe('ability dash (P5 Charge)', () => {
  it('beginDash carries the body the full distance, then stops', () => {
    const state = createMovementState();
    beginDash(state, 0, 1, 12, 24); // 12 m at 24 m/s = 0.5 s = 10 ticks
    simulate(state, idle, 10);
    expect(state.z).toBeCloseTo(12, 1);
    expect(state.dashTimeLeft).toBe(0);
    // Velocity dies with the dash; the body settles instead of sliding on.
    simulate(state, idle, 8);
    expect(state.z).toBeLessThan(12.6);
  });

  it('steering input cannot bend a dash', () => {
    const state = createMovementState();
    beginDash(state, 0, 1, 12, 24);
    simulate(state, { moveX: 1, moveZ: 0, yaw: 0, buttons: 0 }, 10);
    expect(Math.abs(state.x)).toBeLessThan(0.05);
    expect(state.z).toBeCloseTo(12, 1);
  });

  it('dodge cannot start mid-dash; endDash stops on demand', () => {
    const state = createMovementState();
    beginDash(state, 0, 1, 12, 24);
    const dodge: MovementIntent = { moveX: 0, moveZ: 0, yaw: 0, buttons: InputButton.Dodge };
    stepMovement(state, dodge, TICK_DT, ground);
    expect(state.rollTimeLeft).toBe(0); // dash owns the body
    endDash(state);
    stepMovement(state, idle, TICK_DT, ground);
    expect(state.dashTimeLeft).toBe(0);
  });

  it('a dash respects walkability like any other movement', () => {
    const walled: TerrainSampler = {
      heightAt: () => 0,
      walkableAt: (_x, z) => z < 5,
    };
    const state = createMovementState();
    beginDash(state, 0, 1, 12, 24);
    simulate(state, idle, 12, walled);
    expect(state.z).toBeLessThan(5.01);
  });

  it('deep water ends a dash (swim pin owns the body)', () => {
    const shoreline: TerrainSampler = {
      heightAt: (_x, z) => (z < 3 ? 0 : -4),
      waterLevelAt: (_x, z) => (z < 3 ? null : 0.5),
    };
    const state = createMovementState();
    beginDash(state, 0, 1, 12, 24);
    simulate(state, idle, 12, shoreline);
    expect(state.swimming).toBe(true);
    expect(state.dashTimeLeft).toBe(0);
  });
});

describe('hard CC on players (P6, COMBAT.md §6.4)', () => {
  it('root pins the feet but leaves turning free; stun freezes facing too', () => {
    const rooted = simulate(createMovementState(), forward, 20);
    const speedBefore = Math.hypot(rooted.vx, rooted.vz);
    expect(speedBefore).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      stepMovement(rooted, { ...forward, yaw: 1.2 }, TICK_DT, ground, { rooted: true });
    }
    expect(Math.hypot(rooted.vx, rooted.vz)).toBe(0);
    expect(rooted.yaw).toBe(1.2); // turning stays free under root

    const stunned = createMovementState();
    stunned.yaw = 0.4;
    for (let i = 0; i < 10; i++) {
      stepMovement(stunned, { ...forward, yaw: 2.0 }, TICK_DT, ground, { controlsLocked: true });
    }
    expect(Math.hypot(stunned.vx, stunned.vz)).toBe(0);
    expect(stunned.yaw).toBe(0.4); // stun freezes facing
  });

  it('root and stun block dodge and jump but never suppress gravity', () => {
    const state = createMovementState();
    const dodgeIntent: MovementIntent = { ...forward, buttons: InputButton.Dodge };
    stepMovement(state, dodgeIntent, TICK_DT, ground, { rooted: true });
    expect(state.rollTimeLeft).toBe(0);
    expect(state.stamina).toBe(BASE_STAMINA);

    const jumper = createMovementState();
    stepMovement(jumper, { ...idle, buttons: InputButton.Jump }, TICK_DT, ground, {
      controlsLocked: true,
    });
    expect(jumper.grounded).toBe(true); // never left the ground

    // Gravity still applies: a stunned body in the air keeps falling.
    const falling = createMovementState();
    falling.y = 5;
    falling.grounded = false;
    stepMovement(falling, idle, TICK_DT, ground, { controlsLocked: true });
    expect(falling.y).toBeLessThan(5);
  });

  it('an in-flight roll finishes even if a root lands mid-roll', () => {
    const state = createMovementState();
    stepMovement(state, { ...forward, buttons: InputButton.Dodge }, TICK_DT, ground);
    expect(state.rollTimeLeft).toBeGreaterThan(0);
    stepMovement(state, idle, TICK_DT, ground, { rooted: true });
    // The roll still owns the velocity — CC never teleports/halts a committed roll.
    expect(Math.hypot(state.vx, state.vz)).toBeCloseTo(DODGE_DISTANCE_M / DODGE_DURATION_S, 4);
  });
});
