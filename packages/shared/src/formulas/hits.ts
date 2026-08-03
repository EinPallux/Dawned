/**
 * Hit-detection geometry (docs/design/COMBAT.md §5) — pure functions the
 * server resolves truth with and the client may reuse for previews.
 *
 * The world fights on terrain, so shapes are horizontal (XZ) tests with a
 * vertical band check: a target overlaps if its capsule's Y span comes within
 * HIT_VERTICAL_TOLERANCE_M of the attack's origin height. Full 3D capsule
 * sweeps buy nothing on heightmap ground and cost clarity.
 */

import { HIT_VERTICAL_TOLERANCE_M } from '../constants.js';
import { angleDelta } from '../math/vec.js';

/** A hittable body: vertical capsule, feet at y. */
export interface HitTarget {
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
}

const verticalOverlap = (originY: number, target: HitTarget): boolean =>
  originY + HIT_VERTICAL_TOLERANCE_M >= target.y &&
  originY - HIT_VERTICAL_TOLERANCE_M <= target.y + target.height;

/**
 * Melee arc / cone: a sector of reach `reach` and full angle `angleRad`,
 * opening from (x,z) along `yaw` (0 = +Z, the game's facing convention).
 * Returns indices into `targets`, nearest first, capped at `maxTargets`.
 *
 * The angular test is against the target's nearest edge, not its center — a
 * fat target brushing the sector's border is hit, which reads fair on screen.
 */
export const arcHits = (
  x: number,
  y: number,
  z: number,
  yaw: number,
  reach: number,
  angleRad: number,
  targets: readonly HitTarget[],
  maxTargets: number,
): number[] => {
  const hits: { index: number; distSq: number }[] = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    if (!verticalOverlap(y, t)) continue;
    const dx = t.x - x;
    const dz = t.z - z;
    const dist = Math.hypot(dx, dz);
    if (dist - t.radius > reach) continue;
    if (dist > 1e-6) {
      const bearing = Math.atan2(dx, dz);
      // Angular slack from the target's radius: asin clamped for overlaps.
      const slack = dist > t.radius ? Math.asin(t.radius / dist) : Math.PI;
      if (Math.abs(angleDelta(yaw, bearing)) > angleRad / 2 + slack) continue;
    }
    hits.push({ index: i, distSq: dx * dx + dz * dz });
  }
  hits.sort((a, b) => a.distSq - b.distSq);
  return hits.slice(0, maxTargets).map((h) => h.index);
};

/** Ground circle (AoE): 2D center distance vs radius + target radius. */
export const circleHits = (
  x: number,
  y: number,
  z: number,
  radius: number,
  targets: readonly HitTarget[],
): number[] => {
  const hits: number[] = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    if (!verticalOverlap(y, t)) continue;
    const reach = radius + t.radius;
    if ((t.x - x) ** 2 + (t.z - z) ** 2 <= reach * reach) hits.push(i);
  }
  return hits;
};

export interface SweepHit {
  index: number;
  /** Fraction 0..1 along this step's travel at first contact. */
  t: number;
}

/**
 * Projectile step: a sphere of `radius` travelling from (x,z) by (dx,dz) this
 * tick. Returns the FIRST capsule contact along the travel, or null. The
 * vertical band uses the projectile's height at contact (linear y + dy·t).
 */
export const sweepFirstHit = (
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
  radius: number,
  targets: readonly HitTarget[],
  /** Skip an index (the shooter). −1 to test all. */
  ignoreIndex: number,
): SweepHit | null => {
  let best: SweepHit | null = null;
  const lenSq = dx * dx + dz * dz;
  for (let i = 0; i < targets.length; i++) {
    if (i === ignoreIndex) continue;
    const target = targets[i]!;
    const hitRadius = radius + target.radius;
    const rx = target.x - x;
    const rz = target.z - z;
    // Closest-approach parameter of the 2D ray to the capsule axis.
    let t: number;
    if (lenSq < 1e-12) {
      t = 0;
    } else {
      t = (rx * dx + rz * dz) / lenSq;
    }
    // First contact, not closest approach: solve |P(t) − C| = hitRadius.
    const cx = x - target.x;
    const cz = z - target.z;
    const b = 2 * (cx * dx + cz * dz);
    const c = cx * cx + cz * cz - hitRadius * hitRadius;
    if (c <= 0) {
      t = 0; // started overlapping
    } else {
      const disc = b * b - 4 * lenSq * c;
      if (disc < 0 || lenSq < 1e-12) continue;
      t = (-b - Math.sqrt(disc)) / (2 * lenSq);
      if (t < 0 || t > 1) continue;
    }
    const contactY = y + dy * t;
    if (!verticalOverlap(contactY, target)) continue;
    if (!best || t < best.t) best = { index: i, t };
  }
  return best;
};

/**
 * Dash-through: a capsule of width `width` swept from (x1,z1) to (x2,z2),
 * collecting every target whose distance to the segment ≤ width + radius.
 */
export const dashSweepHits = (
  x1: number,
  y: number,
  z1: number,
  x2: number,
  z2: number,
  width: number,
  targets: readonly HitTarget[],
): number[] => {
  const hits: number[] = [];
  const dx = x2 - x1;
  const dz = z2 - z1;
  const lenSq = dx * dx + dz * dz;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    if (!verticalOverlap(y, t)) continue;
    let px: number;
    let pz: number;
    if (lenSq < 1e-12) {
      px = x1;
      pz = z1;
    } else {
      const u = Math.max(0, Math.min(1, ((t.x - x1) * dx + (t.z - z1) * dz) / lenSq));
      px = x1 + dx * u;
      pz = z1 + dz * u;
    }
    const reach = width + t.radius;
    if ((t.x - px) ** 2 + (t.z - pz) ** 2 <= reach * reach) hits.push(i);
  }
  return hits;
};
