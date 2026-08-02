/**
 * THE shared movement step — the anti-desync layer.
 *
 * The client predicts with this function and the server re-simulates with the very
 * same code (docs/tech/NETWORKING.md §3). It must stay:
 *  - deterministic for identical inputs (no Math.random, no Date, no globals),
 *  - allocation-free (state is mutated in place; called 20+ times/sec/entity),
 *  - free of any client- or server-only concept.
 *
 * Any change here is a protocol-level change: bump PROTOCOL_VERSION and re-run the
 * prediction parity test (movement.test.ts).
 */

import {
  AIR_CONTROL,
  BASE_STAMINA,
  FALL_DAMAGE_MAX_FRACTION,
  FALL_DAMAGE_MIN_HEIGHT,
  FALL_DAMAGE_PER_METRE,
  GRAVITY,
  JUMP_VELOCITY,
  MOVE_ACCEL,
  MOVE_DECEL,
  MOVE_SPEED,
  SPRINT_MIN_STAMINA,
  SPRINT_MULTIPLIER,
  SPRINT_STAMINA_PER_SEC,
  STAMINA_REGEN_DELAY_MS,
  STAMINA_REGEN_PER_SEC,
  TERMINAL_VELOCITY,
  WORLD_BOUNDS,
} from '../constants.js';
import { InputButton } from '../protocol/opcodes.js';
import { clamp } from '../math/vec.js';

/** Everything the movement step reads and writes for one character. */
export interface MovementState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  grounded: boolean;
  sprinting: boolean;
  stamina: number;
  maxStamina: number;
  /** Milliseconds since stamina was last spent (drives the regen delay). */
  staminaIdleMs: number;
  /** Highest Y since leaving the ground — the fall-damage reference height. */
  fallPeakY: number;
}

/** One tick of player intent, as sent by the client. */
export interface MovementIntent {
  /** Camera-relative axes in −1..1. */
  moveX: number;
  moveZ: number;
  /** Facing in radians. */
  yaw: number;
  /** Bitfield of {@link InputButton}. */
  buttons: number;
}

/** Terrain the simulation walks on. P0 ships a flat plane; P2 swaps in heightmap chunks. */
export interface TerrainSampler {
  heightAt(x: number, z: number): number;
}

/** Flat ground at a fixed height — the P0 dev world and a useful test fixture. */
export const flatTerrain = (height = 0): TerrainSampler => ({
  heightAt: () => height,
});

/** Outcome of a single step; consumed by the server to apply damage/events. */
export interface MovementStepResult {
  /** Fraction of max HP lost by landing this step (0 when none). */
  fallDamageFraction: number;
  /** True on the tick the character touched down. */
  landed: boolean;
  /** True on the tick the character left the ground by jumping. */
  jumped: boolean;
  /** Distance fallen when landing, in metres (0 otherwise). */
  fallDistance: number;
}

/** Max stamina for a character (docs/design/PROGRESSION.md §2). */
export const maxStaminaFor = (level: number, endurance: number): number =>
  BASE_STAMINA + 5 * endurance + 2 * (level - 1);

export const createMovementState = (
  x = 0,
  y = 0,
  z = 0,
  maxStamina = BASE_STAMINA,
): MovementState => ({
  x,
  y,
  z,
  vx: 0,
  vy: 0,
  vz: 0,
  yaw: 0,
  grounded: true,
  sprinting: false,
  stamina: maxStamina,
  maxStamina,
  staminaIdleMs: STAMINA_REGEN_DELAY_MS,
  fallPeakY: y,
});

export const copyMovementState = (
  out: MovementState,
  src: Readonly<MovementState>,
): MovementState => Object.assign(out, src);

export const cloneMovementState = (src: Readonly<MovementState>): MovementState => ({ ...src });

/**
 * Advance one character by `dt` seconds. Mutates `state` and returns what happened.
 *
 * Step order is part of the contract — client and server must not diverge here.
 */
export function stepMovement(
  state: MovementState,
  intent: Readonly<MovementIntent>,
  dt: number,
  terrain: TerrainSampler,
): MovementStepResult {
  const result: MovementStepResult = {
    fallDamageFraction: 0,
    landed: false,
    jumped: false,
    fallDistance: 0,
  };

  // 1. Facing follows the client's aim directly (combat re-validates aim from P4).
  state.yaw = intent.yaw;

  // 2. Normalize the movement axes; a stick/keys diagonal must not outrun a straight line.
  let dirX = clamp(intent.moveX, -1, 1);
  let dirZ = clamp(intent.moveZ, -1, 1);
  const dirLength = Math.sqrt(dirX * dirX + dirZ * dirZ);
  if (dirLength > 1) {
    dirX /= dirLength;
    dirZ /= dirLength;
  }
  const wantsMove = dirLength > 0.001;

  // 3. Sprint gating: needs input, stamina to start, and any stamina to continue.
  const sprintHeld = (intent.buttons & InputButton.Sprint) !== 0;
  const canStartSprint = state.stamina >= SPRINT_MIN_STAMINA;
  const sprinting =
    sprintHeld && wantsMove && (state.sprinting ? state.stamina > 0 : canStartSprint);
  state.sprinting = sprinting;

  // 4. Accelerate horizontal velocity toward the target.
  const speed = MOVE_SPEED * (sprinting ? SPRINT_MULTIPLIER : 1);
  const targetVx = dirX * speed;
  const targetVz = dirZ * speed;
  const baseRate = wantsMove ? MOVE_ACCEL : MOVE_DECEL;
  const rate = state.grounded ? baseRate : baseRate * AIR_CONTROL;
  const maxDelta = rate * dt;

  const dvx = targetVx - state.vx;
  const dvz = targetVz - state.vz;
  const deltaLength = Math.sqrt(dvx * dvx + dvz * dvz);
  if (deltaLength <= maxDelta || deltaLength === 0) {
    state.vx = targetVx;
    state.vz = targetVz;
  } else {
    const scale = maxDelta / deltaLength;
    state.vx += dvx * scale;
    state.vz += dvz * scale;
  }

  // 5. Jump (free — costs no stamina, per docs/design/COMBAT.md §7).
  if (state.grounded && (intent.buttons & InputButton.Jump) !== 0) {
    state.vy = JUMP_VELOCITY;
    state.grounded = false;
    state.fallPeakY = state.y;
    result.jumped = true;
  }

  // 6. Gravity.
  if (!state.grounded) {
    state.vy -= GRAVITY * dt;
    if (state.vy < -TERMINAL_VELOCITY) state.vy = -TERMINAL_VELOCITY;
  }

  // 7. Integrate.
  state.x += state.vx * dt;
  state.y += state.vy * dt;
  state.z += state.vz * dt;

  // 8. World bounds (hard clamp; the real world edge is ocean + invisible wall).
  state.x = clamp(state.x, -WORLD_BOUNDS, WORLD_BOUNDS);
  state.z = clamp(state.z, -WORLD_BOUNDS, WORLD_BOUNDS);

  // 9. Ground resolution + fall damage.
  const groundY = terrain.heightAt(state.x, state.z);
  if (state.y <= groundY) {
    if (!state.grounded) {
      const drop = state.fallPeakY - groundY;
      result.landed = true;
      result.fallDistance = drop > 0 ? drop : 0;
      if (drop > FALL_DAMAGE_MIN_HEIGHT) {
        result.fallDamageFraction = Math.min(
          (drop - FALL_DAMAGE_MIN_HEIGHT) * FALL_DAMAGE_PER_METRE,
          FALL_DAMAGE_MAX_FRACTION,
        );
      }
    }
    state.y = groundY;
    state.vy = 0;
    state.grounded = true;
    state.fallPeakY = groundY;
  } else {
    state.grounded = false;
    if (state.y > state.fallPeakY) state.fallPeakY = state.y;
  }

  // 10. Stamina: spend while sprinting, otherwise regenerate after the delay.
  if (sprinting) {
    state.stamina = Math.max(0, state.stamina - SPRINT_STAMINA_PER_SEC * dt);
    state.staminaIdleMs = 0;
  } else {
    state.staminaIdleMs += dt * 1000;
    if (state.staminaIdleMs >= STAMINA_REGEN_DELAY_MS) {
      state.stamina = Math.min(state.maxStamina, state.stamina + STAMINA_REGEN_PER_SEC * dt);
    }
  }

  return result;
}

/**
 * Upper bound on how far a character may legitimately travel in one step —
 * the server's anti-speedhack clamp (docs/tech/SECURITY.md §2).
 */
export const maxHorizontalStep = (dt: number): number => MOVE_SPEED * SPRINT_MULTIPLIER * dt;
