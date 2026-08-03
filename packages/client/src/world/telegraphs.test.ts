/**
 * Telegraph decal orientation: the exact server shape must extend toward the
 * caster's FACING (+Z at yaw 0 — shared movement dir = (sin yaw, cos yaw)).
 * Round-6 playtest: cones rendered 180° behind every enemy because the sector
 * was centered on the wrong pole; these tests pin all three shapes.
 */

import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { circleGeometry, coneGeometry, rectGeometry } from './telegraphs.js';

const meanAndSpan = (
  geometry: THREE.BufferGeometry,
): { meanZ: number; minZ: number; maxZ: number; maxAbsX: number; maxY: number } => {
  const position = geometry.getAttribute('position');
  let sumZ = 0;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxAbsX = 0;
  let maxY = 0;
  for (let i = 0; i < position.count; i++) {
    const z = position.getZ(i);
    sumZ += z;
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    maxAbsX = Math.max(maxAbsX, Math.abs(position.getX(i)));
    maxY = Math.max(maxY, Math.abs(position.getY(i)));
  }
  return { meanZ: sumZ / position.count, minZ, maxZ, maxAbsX, maxY };
};

describe('telegraph decal geometry', () => {
  it('cone extends FORWARD (+Z) from the caster, flat on the ground', () => {
    const cone = meanAndSpan(coneGeometry(1.8, (100 * Math.PI) / 180));
    expect(cone.meanZ).toBeGreaterThan(0.3); // firmly in front, not behind
    expect(cone.maxZ).toBeCloseTo(1.8, 1); // reaches the full range forward
    expect(cone.minZ).toBeGreaterThanOrEqual(-1e-6); // nothing behind the caster
    expect(cone.maxY).toBeLessThan(1e-6); // flat after the ground rotation
  });

  it('cone spread stays symmetric around the facing axis', () => {
    const position = coneGeometry(2, Math.PI / 2).getAttribute('position');
    let sumX = 0;
    for (let i = 0; i < position.count; i++) sumX += position.getX(i);
    expect(Math.abs(sumX / position.count)).toBeLessThan(1e-6);
  });

  it('rect extends [0, length] forward with the given width', () => {
    const rect = meanAndSpan(rectGeometry(4, 1.5));
    expect(rect.minZ).toBeCloseTo(0, 5);
    expect(rect.maxZ).toBeCloseTo(4, 5);
    expect(rect.maxAbsX).toBeCloseTo(0.75, 5);
    expect(rect.maxY).toBeLessThan(1e-6);
  });

  it('circle stays centered on the caster', () => {
    const circle = meanAndSpan(circleGeometry(2.5));
    expect(circle.minZ).toBeCloseTo(-2.5, 4);
    expect(circle.maxZ).toBeCloseTo(2.5, 4);
    expect(Math.abs(circle.meanZ)).toBeLessThan(0.1);
  });
});
