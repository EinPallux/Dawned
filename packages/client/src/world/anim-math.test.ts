/**
 * Pins the animation heading spaces to the camera/input conventions.
 *
 * The dangerous property of these transforms: yaw 0 and π are fixed points of
 * the classic double-rotation mistake (evaluating sin/cos at −yaw AND using
 * the inverse-rotation formula), so tests that only exercise those yaws pass
 * against completely broken math. P3 shipped exactly that — headings read as
 * 2·yaw − direction, and every camera turn cycled the 8-way clips twice per
 * revolution. Every case here therefore sweeps arbitrary yaws.
 */

import { describe, expect, it } from 'vitest';
import { cameraRelativeMove } from '../input/input.js';
import { headingFromInput, headingFromVelocity, wrapAngle } from './anim-math.js';

/** Yaw sweep including the two deceptive fixed points and awkward angles. */
const YAWS = [0, 0.4, Math.PI / 4, Math.PI / 2, 2.1, Math.PI, -0.7, -Math.PI / 2, -2.6];

/** All 8 held-key combinations (forward = W−S, strafe = D−A). */
const KEY_COMBOS: Array<{ forward: number; strafe: number; heading: number }> = [
  { forward: 1, strafe: 0, heading: 0 }, //             W    → fwd
  { forward: 1, strafe: -1, heading: Math.PI / 4 }, //  W+A  → fwd, character-left
  { forward: 0, strafe: -1, heading: Math.PI / 2 }, //  A    → character-left
  { forward: -1, strafe: -1, heading: (3 * Math.PI) / 4 }, // S+A → bwd-left
  { forward: -1, strafe: 0, heading: Math.PI }, //      S    → bwd
  { forward: -1, strafe: 1, heading: (-3 * Math.PI) / 4 }, // S+D → bwd-right
  { forward: 0, strafe: 1, heading: -Math.PI / 2 }, //  D    → character-right
  { forward: 1, strafe: 1, heading: -Math.PI / 4 }, //  W+D  → fwd, character-right
];

describe('headingFromVelocity', () => {
  it('running the facing direction reads as forward at EVERY yaw', () => {
    // The shipped bug: this read 2·yaw — zero only at yaw 0 and π.
    for (const yaw of YAWS) {
      expect(headingFromVelocity(Math.sin(yaw), Math.cos(yaw), yaw)).toBeCloseTo(0, 10);
    }
  });

  it('moving opposite the facing reads as backward at every yaw', () => {
    for (const yaw of YAWS) {
      const heading = headingFromVelocity(-Math.sin(yaw), -Math.cos(yaw), yaw);
      expect(Math.abs(heading)).toBeCloseTo(Math.PI, 10);
    }
  });

  it('character-left motion is positive heading (the sector convention)', () => {
    // Ground truth via the D key: D = character-right = (−cos, sin) at any yaw
    // (input-math.test.ts), so character-LEFT is its negation (cos, −sin).
    for (const yaw of YAWS) {
      const left = headingFromVelocity(Math.cos(yaw), -Math.sin(yaw), yaw);
      expect(left).toBeCloseTo(Math.PI / 2, 10);
      const right = headingFromVelocity(-Math.cos(yaw), Math.sin(yaw), yaw);
      expect(right).toBeCloseTo(-Math.PI / 2, 10);
    }
  });
});

describe('headingFromInput', () => {
  it('is null with no direction held', () => {
    expect(headingFromInput(0, 0)).toBeNull();
  });

  it('maps all 8 key combinations onto their sector centers', () => {
    for (const combo of KEY_COMBOS) {
      expect(headingFromInput(combo.forward, combo.strafe)).toBeCloseTo(combo.heading, 10);
    }
  });
});

describe('input heading ↔ velocity heading consistency', () => {
  it('keys and the velocity they cause agree on the local heading, at every yaw', () => {
    // The full chain: keys → cameraRelativeMove → world velocity → model-local
    // heading must land exactly where headingFromInput points. This is the
    // invariant that breaks loudly if either space conversion regresses.
    for (const yaw of YAWS) {
      for (const combo of KEY_COMBOS) {
        const move = cameraRelativeMove(combo.forward, combo.strafe, yaw);
        const viaVelocity = headingFromVelocity(move.moveX, move.moveZ, yaw);
        expect(wrapAngle(viaVelocity - combo.heading)).toBeCloseTo(0, 9);
      }
    }
  });
});

describe('wrapAngle', () => {
  it('wraps into (−π, π] and preserves shortest-path deltas', () => {
    expect(wrapAngle(Math.PI * 2)).toBeCloseTo(0, 12);
    expect(wrapAngle(Math.PI + 0.1)).toBeCloseTo(-Math.PI + 0.1, 12);
    expect(wrapAngle(-Math.PI - 0.1)).toBeCloseTo(Math.PI - 0.1, 12);
    expect(wrapAngle(0.3)).toBeCloseTo(0.3, 12);
  });
});
