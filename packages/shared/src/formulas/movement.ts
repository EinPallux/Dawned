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
  DODGE_COOLDOWN_MS,
  DODGE_DISTANCE_M,
  DODGE_DURATION_S,
  DODGE_IFRAME_END_S,
  DODGE_IFRAME_START_S,
  DODGE_STAMINA_COST,
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
  /** Seconds left in the current dodge roll (0 = not rolling). COMBAT.md §7. */
  rollTimeLeft: number;
  /** Locked roll direction (unit), set at roll start — rolls do not steer. */
  rollDirX: number;
  rollDirZ: number;
  /** Ms until the next roll may start (internal cooldown, from roll START). */
  rollCooldownMs: number;
  /**
   * Ability dash (Charge, P5): seconds left, locked direction, speed. Started
   * by beginDash on BOTH sides at their own commit (client at press, server at
   * receive) — the same shared integration keeps them reconciled like rolls.
   */
  dashTimeLeft: number;
  dashDirX: number;
  dashDirZ: number;
  dashSpeed: number;
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
   * Whether the sampler actually HAS data covering this point. Optional —
   * samplers that are pure functions of position (dev/flat terrain) always do.
   *
   * A streaming sampler answers `OCEAN_FLOOR_Y` for chunks it has not received
   * yet, which is indistinguishable from real sea floor. Anything that plants
   * something on the ground (world props) must ask this first, or it plants it
   * eleven metres under the island and never notices.
   */
  hasDataAt?(x: number, z: number): boolean;
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
  /** True on the tick a dodge roll started (drives anim/FX and cast cancels). */
  dodged: boolean;
}

/** Why a dodge press cannot start a roll, or null when it can. */
export type DodgeRefusal = 'stamina' | 'cooldown' | 'rooted' | 'swimming' | 'airborne' | 'busy';

/** The effective stamina a roll costs, after P7/buff modifiers. */
export const dodgeCostOf = (modifiers?: MovementModifiers): number =>
  Math.max(0, DODGE_STAMINA_COST + (modifiers?.dodgeCostDelta ?? 0));

/**
 * The dodge gate, as a question anyone can ask (COMBAT.md §7).
 *
 * `stepMovement` decides with this, and the client asks it again when a press
 * produced no roll so the HUD can say WHY — one rule, two readers. Keeping the
 * reason next to the gate is the point: a second copy in the UI would drift,
 * and then the game would explain itself incorrectly, which is worse than
 * saying nothing.
 */
export const dodgeRefusal = (
  state: Readonly<MovementState>,
  rooted: boolean,
  dodgeCost: number,
): DodgeRefusal | null => {
  if (state.rollTimeLeft > 0) return 'busy';
  if (rooted) return 'rooted'; // rooted/stunned: no dodging out of CC (Blink/cleanse do that)
  if (state.dashTimeLeft > 0) return 'busy'; // a dash owns the body until it lands
  if (state.swimming) return 'swimming';
  if (!state.grounded) return 'airborne';
  if (state.rollCooldownMs > 0) return 'cooldown';
  if (state.stamina < dodgeCost) return 'stamina';
  return null;
};

/**
 * Whether the character is inside the roll's invulnerability window
 * (COMBAT.md §7: 0.05–0.35 s from roll start). The server evaluates this on
 * REWOUND state so a roll that was rolling on the player's screen counts
 * (docs/tech/NETWORKING.md §4).
 */
export const isDodgeInvulnerable = (state: Readonly<MovementState>): boolean => {
  if (state.rollTimeLeft <= 0) return false;
  const elapsed = DODGE_DURATION_S - state.rollTimeLeft;
  return elapsed >= DODGE_IFRAME_START_S && elapsed <= DODGE_IFRAME_END_S;
};

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
  rollTimeLeft: 0,
  rollDirX: 0,
  rollDirZ: 0,
  rollCooldownMs: 0,
  dashTimeLeft: 0,
  dashDirX: 0,
  dashDirZ: 0,
  dashSpeed: 0,
});

/** Ability-dash ceiling: caps the anti-speedhack envelope and content speeds. */
export const DASH_MAX_SPEED = 30;

/**
 * Start an ability dash (Charge). Both sides call this at their own commit
 * moment; the shared step then integrates it deterministically. A dash never
 * starts mid-roll or in water (callers gate on it — BadState).
 */
export const beginDash = (
  state: MovementState,
  dirX: number,
  dirZ: number,
  distance: number,
  speed: number,
): void => {
  const length = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
  const clampedSpeed = Math.min(speed, DASH_MAX_SPEED);
  state.dashDirX = dirX / length;
  state.dashDirZ = dirZ / length;
  state.dashSpeed = clampedSpeed;
  state.dashTimeLeft = distance / clampedSpeed;
};

/** Cut a dash short (stop-on-hit, walls handled by integration already). */
export const endDash = (state: MovementState): void => {
  state.dashTimeLeft = 0;
  state.dashSpeed = 0;
};

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
/**
 * External movement modifiers (P5): stance/effect-driven, computed by EACH
 * side from state it already knows (class + held RMB + synced effects), so
 * prediction and authority keep agreeing. Absent = neutral.
 */
export interface MovementModifiers {
  /** Multiplies ground/swim target speed (slows <1, Evasive/Smoke Veil >1). */
  speedMult?: number;
  /** Added to the dodge stamina cost (Evasive Stance −10). Never below 0. */
  dodgeCostDelta?: number;
  /** Stamina regenerated per second (P7: END-scaled via CombatStats). */
  staminaRegenPerS?: number;
  /** Land-sprint stamina drain per second (P7: Marathon −1/s). Min 1. */
  sprintStaminaPerS?: number;
  /**
   * Rooted (P6, COMBAT.md §6.4): feet pinned — no walking, dodging or
   * jumping; turning stays free (aim your Blink out). Gravity still applies.
   */
  rooted?: boolean;
  /**
   * Stunned: full control loss — implies rooted and additionally freezes
   * facing. The shared step enforces it so prediction and authority agree
   * about a CC'd body to the centimeter.
   */
  controlsLocked?: boolean;
}

export function stepMovement(
  state: MovementState,
  intent: Readonly<MovementIntent>,
  dt: number,
  terrain: TerrainSampler,
  modifiers?: Readonly<MovementModifiers>,
): MovementStepResult {
  const result: MovementStepResult = {
    fallDamageFraction: 0,
    landed: false,
    jumped: false,
    fallDistance: 0,
    dodged: false,
  };

  // 0. Hard CC (P6): stun locks everything including facing; root pins the
  // feet but turning stays free. Both block walking/dodge/jump; gravity and
  // an in-flight roll/dash still play out (CC never teleports a body).
  const stunned = modifiers?.controlsLocked === true;
  const rooted = stunned || modifiers?.rooted === true;

  // 1. Facing follows the client's aim directly (combat re-validates aim from P4).
  if (!stunned) state.yaw = intent.yaw;

  // 2. Normalize the movement axes; a stick/keys diagonal must not outrun a straight line.
  let dirX = rooted ? 0 : clamp(intent.moveX, -1, 1);
  let dirZ = rooted ? 0 : clamp(intent.moveZ, -1, 1);
  const dirLength = Math.sqrt(dirX * dirX + dirZ * dirZ);
  if (dirLength > 1) {
    dirX /= dirLength;
    dirZ /= dirLength;
  }
  const wantsMove = dirLength > 0.001;

  // 2b. Dodge roll (COMBAT.md §7): grounded only, gated by stamina + internal
  // cooldown. Direction locks at roll start — movement direction if held, else
  // facing — and steering is ignored until the roll ends. The cooldown runs
  // from roll START so spam can never queue back-to-back rolls.
  state.rollCooldownMs = Math.max(0, state.rollCooldownMs - dt * 1000);
  const dodgeCost = dodgeCostOf(modifiers);
  if (
    (intent.buttons & InputButton.Dodge) !== 0 &&
    dodgeRefusal(state, rooted, dodgeCost) === null
  ) {
    state.rollTimeLeft = DODGE_DURATION_S;
    state.rollCooldownMs = DODGE_COOLDOWN_MS;
    state.stamina -= dodgeCost;
    state.staminaIdleMs = 0;
    if (wantsMove) {
      state.rollDirX = dirX;
      state.rollDirZ = dirZ;
    } else {
      state.rollDirX = Math.sin(state.yaw);
      state.rollDirZ = Math.cos(state.yaw);
    }
    // Normalize: axes may be sub-unit (analog input) — the roll is always unit.
    const len = Math.sqrt(state.rollDirX ** 2 + state.rollDirZ ** 2) || 1;
    state.rollDirX /= len;
    state.rollDirZ /= len;
    result.dodged = true;
  }
  const rolling = state.rollTimeLeft > 0;

  // 3. Sprint gating: needs input, stamina to start, and any stamina to continue.
  // A roll suppresses sprint for its duration (the roll owns the velocity).
  const dashing = !rolling && state.dashTimeLeft > 0;
  const sprintHeld = (intent.buttons & InputButton.Sprint) !== 0;
  const canStartSprint = state.stamina >= SPRINT_MIN_STAMINA;
  const sprinting =
    !rolling &&
    !dashing &&
    sprintHeld &&
    wantsMove &&
    (state.sprinting ? state.stamina > 0 : canStartSprint);
  state.sprinting = sprinting;

  // 4. Accelerate horizontal velocity toward the target. Swim state is read from
  // the previous tick's resolution (one-tick transition lag, identical on both
  // sides) — swimming is slower, and swim control feels like ground control.
  // A roll overrides the whole block: fixed speed along the locked direction.
  if (rolling) {
    const rollSpeed = DODGE_DISTANCE_M / DODGE_DURATION_S;
    state.vx = state.rollDirX * rollSpeed;
    state.vz = state.rollDirZ * rollSpeed;
  } else if (dashing) {
    // Ability dash (Charge): fixed velocity along the locked line; walls stop
    // it through the same walkability slide as everything else.
    state.vx = state.dashDirX * state.dashSpeed;
    state.vz = state.dashDirZ * state.dashSpeed;
  } else {
    const speed =
      MOVE_SPEED *
      (state.swimming ? SWIM_SPEED_FACTOR : 1) *
      (sprinting ? SPRINT_MULTIPLIER : 1) *
      clamp(modifiers?.speedMult ?? 1, 0.1, 2);
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
  }

  // 5. Jump (free — costs no stamina, per docs/design/COMBAT.md §7). Not
  // available mid-roll (the roll owns the character) or under root/stun.
  const wasGrounded = state.grounded;
  if (!rolling && !rooted && state.grounded && (intent.buttons & InputButton.Jump) !== 0) {
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

  // 10. Roll timer: decrement AFTER integration, so the start tick already
  // moves — 11 ticks at 20 Hz cover exactly DODGE_DISTANCE_M. Water ends a
  // roll instantly (the swim pin owns the body; no rolling across the surface).
  if (state.swimming) {
    state.rollTimeLeft = 0;
  } else if (state.rollTimeLeft > 0) {
    state.rollTimeLeft -= dt;
    // Snap float dust to done — a 1e-16 remainder must not buy a 12th tick of
    // roll velocity (deterministic on both sides, so no parity concern).
    if (state.rollTimeLeft < 1e-9) state.rollTimeLeft = 0;
  }
  // 10b. Dash timer — same decrement-after-integration contract as the roll.
  if (state.swimming) {
    state.dashTimeLeft = 0;
  } else if (state.dashTimeLeft > 0) {
    state.dashTimeLeft -= dt;
    if (state.dashTimeLeft < 1e-9) {
      state.dashTimeLeft = 0;
      // Kill the dash velocity so the next frame decelerates from a stand.
      state.vx = 0;
      state.vz = 0;
    }
  }

  // 11. Stamina: spend while sprinting (swim-sprint drains faster, COMBAT.md §7),
  // otherwise regenerate after the delay. Both rates take P7 modifiers (END
  // regen scaling, Marathon sprint discount) — each side computes them from
  // synced state, so prediction stays exact.
  if (sprinting) {
    const drainPerSec = state.swimming
      ? SWIM_SPRINT_STAMINA_PER_SEC
      : Math.max(1, modifiers?.sprintStaminaPerS ?? SPRINT_STAMINA_PER_SEC);
    state.stamina = Math.max(0, state.stamina - drainPerSec * dt);
    state.staminaIdleMs = 0;
  } else {
    state.staminaIdleMs += dt * 1000;
    if (state.staminaIdleMs >= STAMINA_REGEN_DELAY_MS) {
      const regenPerSec = modifiers?.staminaRegenPerS ?? STAMINA_REGEN_PER_SEC;
      state.stamina = Math.min(state.maxStamina, state.stamina + regenPerSec * dt);
    }
  }

  return result;
}

/**
 * Upper bound on how far a character may legitimately travel in one step —
 * the server's anti-speedhack clamp (docs/tech/SECURITY.md §2). Ability
 * dashes (≤ DASH_MAX_SPEED, P5 Charge) are the fastest legitimate movement.
 */
export const maxHorizontalStep = (dt: number): number =>
  Math.max(MOVE_SPEED * SPRINT_MULTIPLIER, DODGE_DISTANCE_M / DODGE_DURATION_S, DASH_MAX_SPEED) *
  dt;
