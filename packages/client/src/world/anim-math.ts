/**
 * Pure math for animation heading selection — extracted from the character
 * view so the space conversions are unit-testable (input-math.test.ts pins
 * them against the camera/input conventions; getting a sign wrong here is
 * invisible at yaw 0/π and wrecks every other camera angle).
 */

/** Shortest-path angle wrap into (−π, π] — yaw deltas must not jump at ±π. */
export const wrapAngle = (angle: number): number => {
  let a = angle % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
};

/**
 * Heading of a world-space velocity in model-local space, for a rig facing +Z
 * rotated by `rotation.y = yaw`: 0 = forward, positive = character-LEFT,
 * ±π = backward (the character-view sector convention).
 *
 * This is Ry(−yaw)·v — and the minus lives in the MATRIX, not the sin/cos
 * arguments. The shipped P3 version evaluated sin/cos at −yaw while also
 * using the inverse-rotation formula, double-negating into Ry(+yaw): headings
 * read as 2·yaw − true direction, so running forward at camera yaw 90° played
 * the backpedal clip and every camera turn cycled the 8-way sectors twice per
 * revolution ("animations switch around when walking" — the action-camera
 * playtest report). Yaw 0 and π are fixed points of that bug, which is why
 * the original smoke asserts missed it.
 */
export const headingFromVelocity = (vx: number, vz: number, yaw: number): number => {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const localX = vx * cos - vz * sin;
  const localZ = vx * sin + vz * cos;
  return Math.atan2(localX, localZ);
};

/**
 * Model-local heading of a WASD combination (forward = W−S, strafe = D−A),
 * or null when no direction is held.
 *
 * For the LOCAL player the pressed keys are the truth of intended motion:
 * screen-relative axes are yaw-invariant by construction, so this heading is
 * piecewise constant no matter how fast the camera turns. Velocity-derived
 * heading lags the live mouse yaw by intent sampling (20 Hz) plus smoothing
 * (~100 ms total) — during a hard flick it sweeps across sector borders and
 * flashes strafe/backpedal clips mid-turn. Remotes keep the velocity path:
 * their yaw and velocity both come from snapshots, so the pair is coherent.
 */
export const headingFromInput = (forward: number, strafe: number): number | null => {
  if (forward === 0 && strafe === 0) return null;
  // Character-right (D, strafe +1) is model-local −X; forward (W) is +Z.
  // 0 − strafe rather than −strafe: negating a zero strafe gives −0, and
  // atan2(−0, −1) flips plain backward (S) to −π instead of the canonical +π.
  return Math.atan2(0 - strafe, forward);
};
