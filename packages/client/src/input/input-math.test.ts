/**
 * Pins the WASD → world mapping to the camera rig's actual screen axes.
 *
 * The ground truth mirrors three.js lookAt: with the camera behind a character
 * facing (sin yaw, cos yaw), screen-right = up × (eye − target) = (−cos, sin).
 * P3's first playtest shipped with the strafe sign flipped (A went right);
 * these tests make that regression impossible to reintroduce quietly.
 */

import { describe, expect, it } from 'vitest';
import { cameraRelativeMove } from './input.js';

const close = (a: { moveX: number; moveZ: number }, x: number, z: number): void => {
  expect(a.moveX).toBeCloseTo(x, 10);
  expect(a.moveZ).toBeCloseTo(z, 10);
};

/** Screen-right for a camera looking along (sin yaw, cos yaw) with +Y up. */
const screenRight = (yaw: number): { x: number; z: number } => ({
  x: -Math.cos(yaw),
  z: Math.sin(yaw),
});

describe('cameraRelativeMove', () => {
  it('W walks the facing direction, S the opposite', () => {
    close(cameraRelativeMove(1, 0, 0), 0, 1);
    close(cameraRelativeMove(-1, 0, 0), 0, -1);
    close(cameraRelativeMove(1, 0, Math.PI / 2), 1, 0);
  });

  it('D strafes toward screen-right, A toward screen-left, at every yaw', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 3, 2.1]) {
      const right = screenRight(yaw);
      close(cameraRelativeMove(0, 1, yaw), right.x, right.z);
      close(cameraRelativeMove(0, -1, yaw), -right.x, -right.z);
    }
  });

  it('facing +Z (yaw 0): D goes to −X, which the camera shows as rightward', () => {
    // The regression that shipped: D mapped to +X (screen LEFT for this rig).
    const d = cameraRelativeMove(0, 1, 0);
    expect(d.moveX).toBeLessThan(0);
  });

  it('diagonals are normalized, never faster than a straight line', () => {
    const diagonal = cameraRelativeMove(1, 1, 1.234);
    expect(Math.hypot(diagonal.moveX, diagonal.moveZ)).toBeCloseTo(1, 10);
  });
});
