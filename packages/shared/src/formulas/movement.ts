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
  GROUND_SNAP_M,
  JUMP_VELOCITY,
  MOVE_ACCEL,
  MOVE_DECEL,
  MOVE_SPEED,
  SPRINT_MIN_STAMINA,
  SPRINT_MULTIPLIER,
  SPRINT_STAMINA_PER_SEC,
  STAMINA_REGEN_DELAY_MS,
  STAMINA_REGEN_PER_SEC,
  SWIM_DEPTH,
  SWIM_SPEED_FACTOR,
  SWIM_SPRINT_STAMINA_PER_SEC,
  SWIM_SURFACE_OFFSET,
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
  /** Surface swimming (deep water — docs/design/GAME_DESIGN.md "Movement"). */
  swimming: boolean;
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

/** Terrain the simulation walks on. P0 shipped a flat plane; P2 streams heightmap chunks. */
export interface TerrainSampler {
  heightAt(x: number, z: number): number;
  /**
   * Whether a position may be entered (walkgrid: slope/water classes). Optional —
   * samplers without it (flat/dev terrain) are fully walkable. Enforced by
   * {@link stepMovement} only when moving FROM a walkable cell, so a character
   * that somehow starts on blocked ground can always leave it.
   */
  walkableAt?(x: number, z: number): boolean;
  /**
   * Water surface height at a position, or null where there is no water.
   * Optional — samplers without it never produce swimming.
   */
  waterLevelAt?(x: number, z: number): number | null;
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
  swimming: false,
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

  // 4. Accelerate horizontal velocity toward the target. Swim state is read from
  // the previous tick's resolution (one-tick transition lag, identical on both
  // sides) — swimming is slower, and swim control feels like ground control.
  const speed =
    MOVE_SPEED * (state.swimming ? SWIM_SPEED_FACTOR : 1) * (sprinting ? SPRINT_MULTIPLIER : 1);
  const targetVx = dirX * speed;
  const targetVz = dirZ * speed;
  const baseRate = wantsMove ? MOVE_ACCEL : MOVE_DECEL;
  const rate = state.grounded || state.swimming ? baseRate : baseRate * AIR_CONTROL;
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
  const wasGrounded = state.grounded;
  if (state.grounded && (intent.buttons & InputButton.Jump) !== 0) {
    state.vy = JUMP_VELOCITY;
    state.grounded = false;
    state.fallPeakY = state.y;
    result.jumped = true;
  }

  // 6. Gravity (not while swimming — the surface pin below owns Y).
  if (!state.grounded && !state.swimming) {
    state.vy -= GRAVITY * dt;
    if (state.vy < -TERMINAL_VELOCITY) state.vy = -TERMINAL_VELOCITY;
  }

  // 7. Integrate horizontally against walkability (axis-separated slide: a
  // blocked diagonal still slides along the open axis). Applies airborne too —
  // cliffs and deep water cannot be jumped into. Only enforced from a walkable
  // cell, so nobody can get stuck inside a blocked region.
  const nextX = state.x + state.vx * dt;
  const nextZ = state.z + state.vz * dt;
  if (!terrain.walkableAt || !terrain.walkableAt(state.x, state.z)) {
    state.x = nextX;
    state.z = nextZ;
  } else if (terrain.walkableAt(nextX, nextZ)) {
    state.x = nextX;
    state.z = nextZ;
  } else if (terrain.walkableAt(nextX, state.z)) {
    state.x = nextX;
    state.vz = 0;
  } else if (terrain.walkableAt(state.x, nextZ)) {
    state.z = nextZ;
    state.vx = 0;
  } else {
    state.vx = 0;
    state.vz = 0;
  }
  state.y += state.vy * dt;

  // 8. World bounds (hard clamp; the real world edge is ocean + invisible wall).
  state.x = clamp(state.x, -WORLD_BOUNDS, WORLD_BOUNDS);
  state.z = clamp(state.z, -WORLD_BOUNDS, WORLD_BOUNDS);

  // 9. Water & ground resolution + fall damage.
  const groundY = terrain.heightAt(state.x, state.z);
  const waterLevel = terrain.waterLevelAt?.(state.x, state.z) ?? null;
  const swimmable = waterLevel !== null && waterLevel - groundY > SWIM_DEPTH;
  const surfaceY = waterLevel !== null ? waterLevel - SWIM_SURFACE_OFFSET : 0;

  if (swimmable && state.y <= surfaceY) {
    // Surface swim: pinned just under the waterline. Entering from a fall is a
    // soft splash — swimmable water negates fall damage entirely (COMBAT.md §5).
    state.y = surfaceY;
    state.vy = 0;
    state.grounded = false;
    state.swimming = true;
    state.fallPeakY = state.y;
  } else if (
    wasGrounded &&
    !result.jumped &&
    state.y > groundY &&
    state.y - groundY <= GROUND_SNAP_M
  ) {
    // Downhill ground snap: a grounded character whose new column is a small
    // step below stays GLUED to the slope. Without this, every descending tick
    // flips to "airborne" for one gravity step and back — the grounded state
    // (and its animations) flicker at walking pace. Bigger drops are real
    // falls; a jump this tick always leaves the ground.
    state.y = groundY;
    state.vy = 0;
    state.grounded = true;
    state.swimming = false;
    state.fallPeakY = groundY;
  } else if (state.y <= groundY) {
    if (!state.grounded && !state.swimming) {
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
    state.swimming = false;
    state.fallPeakY = groundY;
  } else {
    state.grounded = false;
    state.swimming = false;
    if (state.y > state.fallPeakY) state.fallPeakY = state.y;
  }

  // 10. Stamina: spend while sprinting (swim-sprint drains faster, COMBAT.md §7),
  // otherwise regenerate after the delay.
  if (sprinting) {
    const drainPerSec = state.swimming ? SWIM_SPRINT_STAMINA_PER_SEC : SPRINT_STAMINA_PER_SEC;
    state.stamina = Math.max(0, state.stamina - drainPerSec * dt);
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
