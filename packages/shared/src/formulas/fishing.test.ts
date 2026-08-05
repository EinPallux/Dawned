/**
 * The fishing minigame's rules (PROFESSIONS.md §5).
 *
 * The property that earns its keep is determinism: the client draws the fish
 * and the server judges it, from the same seed, and if those two ever disagree
 * the player watches their marker sit on a fish and gets told they missed.
 */

import { describe, expect, it } from 'vitest';
import {
  BITE_MAX_MS,
  BITE_MIN_MS,
  FishingPhase,
  MARKER_MAX_SPEED,
  REEL_FILL_MS,
  REEL_LOST_PEAK,
  REEL_TIMEOUT_MS,
  biteDelayMs,
  createReelState,
  fishPosition,
  fishRandom,
  fishingDifficulty,
  reelOutcome,
  reelStep,
  type ReelState,
} from './fishing.js';

const EASY = fishingDifficulty(1, 'common');
const HARD = fishingDifficulty(5, 'legendary');

describe('the seeded wobble', () => {
  it('is the same everywhere, which is the whole point', () => {
    expect(fishRandom(12345, 7)).toBe(fishRandom(12345, 7));
    expect(fishRandom(12345, 8)).not.toBe(fishRandom(12345, 7));
  });

  it('stays inside [0, 1)', () => {
    for (let seed = 0; seed < 500; seed++) {
      const value = fishRandom(seed, 3);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('spreads across the range rather than clustering', () => {
    const buckets = new Array<number>(10).fill(0);
    for (let seed = 0; seed < 2000; seed++) {
      const index = Math.min(9, Math.floor(fishRandom(seed, 1) * 10));
      buckets[index] = (buckets[index] ?? 0) + 1;
    }
    for (const count of buckets) expect(count).toBeGreaterThan(100);
  });
});

describe('the bite delay', () => {
  it('lands inside the 2–6 s window the design asks for', () => {
    for (let seed = 0; seed < 500; seed++) {
      const delay = biteDelayMs(seed);
      expect(delay).toBeGreaterThanOrEqual(BITE_MIN_MS);
      expect(delay).toBeLessThanOrEqual(BITE_MAX_MS);
    }
  });

  it('is not the same every cast', () => {
    const delays = new Set([0, 1, 2, 3, 4, 5].map(biteDelayMs));
    expect(delays.size).toBeGreaterThan(3);
  });
});

describe('difficulty', () => {
  it('makes rare, high-tier fish faster and smaller', () => {
    expect(HARD.driftSpeed).toBeGreaterThan(EASY.driftSpeed);
    expect(HARD.markerHalf).toBeLessThan(EASY.markerHalf);
  });

  it('keeps a T1 common gentle — the first fish should be caught', () => {
    expect(EASY.markerHalf).toBeGreaterThanOrEqual(0.15);
  });

  it('never shrinks the marker to something unhittable', () => {
    for (let tier = 1; tier <= 5; tier++) {
      for (const rarity of ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const) {
        expect(fishingDifficulty(tier, rarity).markerHalf).toBeGreaterThanOrEqual(0.05);
      }
    }
  });
});

describe('the fish in the bar', () => {
  it('stays inside the bar at every moment, at every difficulty', () => {
    for (const drift of [EASY, HARD]) {
      for (let ms = 0; ms < 30_000; ms += 37) {
        const pos = fishPosition(4242, ms, drift);
        expect(pos).toBeGreaterThanOrEqual(0);
        expect(pos).toBeLessThanOrEqual(1);
      }
    }
  });

  /** The anti-desync property: both sides evaluate, nobody transmits. */
  it('is a pure function of seed and time', () => {
    expect(fishPosition(99, 1234, EASY)).toBe(fishPosition(99, 1234, EASY));
    expect(fishPosition(100, 1234, EASY)).not.toBe(fishPosition(99, 1234, EASY));
  });

  it('actually moves, and does not park at a wall', () => {
    const samples: number[] = [];
    for (let ms = 0; ms < 12_000; ms += 250) samples.push(fishPosition(7, ms, EASY));
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    expect(max - min).toBeGreaterThan(0.4);
    // A fish that sits at 0 or 1 is a free catch for a parked marker.
    const atWall = samples.filter((value) => value < 0.02 || value > 0.98).length;
    expect(atWall / samples.length).toBeLessThan(0.1);
  });

  it('is not a metronome you learn in two casts', () => {
    // A single sine repeats exactly one period later; the second wave breaks it.
    const period = 1000 / EASY.driftSpeed;
    expect(Math.abs(fishPosition(3, 0, EASY) - fishPosition(3, period, EASY))).toBeGreaterThan(
      0.001,
    );
  });
});

describe('the reel bar', () => {
  const runHold = (holds: boolean[], seed = 11, drift = EASY): ReelState => {
    let state = createReelState();
    let elapsed = 0;
    for (const holding of holds) {
      state = reelStep(state, holding, 50, fishPosition(seed, elapsed, drift), drift);
      elapsed += 50;
    }
    return state;
  };

  it('starts in the middle with nothing earned', () => {
    const start = createReelState();
    expect(start.marker).toBe(0.5);
    expect(start.progress).toBe(0);
  });

  it('lifts the marker while held and drops it when released', () => {
    const up = reelStep(createReelState(), true, 100, 0.5, EASY);
    expect(up.marker).toBeGreaterThan(0.5);
    const down = reelStep(createReelState(), false, 100, 0.5, EASY);
    expect(down.marker).toBeLessThan(0.5);
  });

  it('keeps the marker inside the bar and kills banked speed at a wall', () => {
    let state = createReelState();
    for (let i = 0; i < 100; i++) state = reelStep(state, true, 50, 0.5, EASY);
    expect(state.marker).toBe(1);
    expect(state.velocity).toBeLessThanOrEqual(0);

    let falling = createReelState();
    for (let i = 0; i < 100; i++) falling = reelStep(falling, false, 50, 0.5, EASY);
    expect(falling.marker).toBe(0);
    expect(falling.velocity).toBeGreaterThanOrEqual(0);
  });

  it('never exceeds the speed cap', () => {
    let state = createReelState();
    for (let i = 0; i < 50; i++) {
      state = reelStep(state, true, 50, 0.0, EASY);
      expect(Math.abs(state.velocity)).toBeLessThanOrEqual(MARKER_MAX_SPEED + 1e-9);
    }
  });

  it('fills in about six seconds when the marker sits on the fish', () => {
    // Feed the fish's own position as the marker target by holding it there:
    // easier to assert on the rate directly.
    let state = createReelState();
    let elapsed = 0;
    while (state.progress < 1 && elapsed < 20_000) {
      state = { ...reelStep(state, true, 50, state.marker, EASY), marker: state.marker };
      elapsed += 50;
    }
    expect(elapsed).toBeGreaterThanOrEqual(REEL_FILL_MS - 200);
    expect(elapsed).toBeLessThanOrEqual(REEL_FILL_MS + 400);
  });

  it('drains more slowly than it fills — one slip is not fatal', () => {
    const filled = { marker: 0.5, velocity: 0, progress: 0.5, peak: 0.5 };
    const draining = reelStep(filled, false, 1000, 0.0, EASY);
    expect(draining.progress).toBeGreaterThan(0.5 - 1000 / REEL_FILL_MS);
    expect(draining.progress).toBeLessThan(0.5);
  });

  it('lands a fish the player tracks, and loses one they ignore', () => {
    // Tracking: hold whenever the marker is below the fish.
    let tracked = createReelState();
    let elapsed = 0;
    while (tracked.progress < 1 && elapsed < 30_000) {
      const fish = fishPosition(11, elapsed, EASY);
      tracked = reelStep(tracked, tracked.marker < fish, 50, fish, EASY);
      elapsed += 50;
    }
    expect(tracked.progress).toBe(1);
    expect(reelOutcome(tracked, elapsed)).toBe(FishingPhase.Caught);

    // Ignoring: never press. The marker falls to the floor and stays there,
    // earning a crumb whenever the fish swims low — which is exactly why the
    // attempt needs a clock as well as a floor.
    const ignored = runHold(new Array<boolean>(120).fill(false));
    expect(ignored.progress).toBeLessThan(0.2);
    expect(reelOutcome(ignored, REEL_TIMEOUT_MS)).toBe(FishingPhase.Escaped);
  });

  it('never hangs: an attempt nobody resolves times out', () => {
    // The hole this closes: a parked marker hovering just above empty is
    // neither caught nor escaped, and without a clock it stays that way.
    const hovering = { marker: 0, velocity: 0, progress: 0.07, peak: 0.1 };
    expect(reelOutcome(hovering, REEL_TIMEOUT_MS - 1)).toBeNull();
    expect(reelOutcome(hovering, REEL_TIMEOUT_MS)).toBe(FishingPhase.Escaped);
  });

  it('does not call it escaped for a player who has not caught up yet', () => {
    // The marker starts mid-bar and the fish starts wherever the seed says. A
    // player chasing it downward is playing correctly, and telling them the
    // fish escaped a second in is the harshest possible reading of "empty".
    const fresh = createReelState();
    expect(reelOutcome(fresh, 200)).toBeNull();
    expect(reelOutcome(fresh, 5000)).toBeNull();
    expect(reelOutcome(fresh, REEL_TIMEOUT_MS)).toBe(FishingPhase.Escaped);
  });

  it('ends it for a player who HAD it and lost it', () => {
    const hadIt = { marker: 0, velocity: 0, progress: 0, peak: 0.6 };
    expect(reelOutcome(hadIt, 4000)).toBe(FishingPhase.Escaped);
    // …but a single frame of contact is not "having it".
    const barelyTouched = { marker: 0, velocity: 0, progress: 0, peak: 0.01 };
    expect(reelOutcome(barelyTouched, 4000)).toBeNull();
  });

  it('is still in play while progress is partial', () => {
    expect(reelOutcome({ marker: 0.5, velocity: 0, progress: 0.4, peak: 0.4 }, 4000)).toBeNull();
  });

  it('survives a hitched frame without teleporting the marker', () => {
    const hitched = reelStep(createReelState(), true, 5000, 0.5, EASY);
    // dt is clamped: a 5 s stall must not launch the marker across the bar.
    expect(hitched.marker).toBeLessThan(0.8);
  });
});

/**
 * The property that matters most and is easiest to lose to a tuning tweak:
 * **the bar has to be beatable.**
 *
 * The strategy below is the crudest one that exists — hold whenever the marker
 * is under the fish, with no anticipation whatsoever. A human does better. If
 * even this cannot land a T1 common, the minigame is not hard, it is broken,
 * and §5 is explicit that the first fish a player ever hooks should be caught.
 *
 * This caught a real regression: the first physics pass left the marker so
 * far behind the fish that NO seed was winnable at any difficulty.
 */
describe('the bar is beatable', () => {
  const play = (seed: number, drift = EASY, limitMs = REEL_TIMEOUT_MS): number | null => {
    let state = createReelState();
    for (let elapsed = 50; elapsed < limitMs; elapsed += 50) {
      const fish = fishPosition(seed, elapsed, drift);
      state = reelStep(state, state.marker < fish, 50, fish, drift);
      if (state.progress >= 1) return elapsed;
    }
    return null;
  };

  const SEEDS = Array.from({ length: 20 }, (_, index) => (index + 1) * 137);

  it('lands an easy fish from every seed, with the dumbest strategy there is', () => {
    const times = SEEDS.map((seed) => play(seed));
    expect(times.filter((time) => time !== null)).toHaveLength(SEEDS.length);
  });

  it('takes longer than the perfect-hold time — it is a fight, not a formality', () => {
    const times = SEEDS.map((seed) => play(seed)).filter((time): time is number => time !== null);
    const average = times.reduce((sum, time) => sum + time, 0) / times.length;
    expect(average).toBeGreaterThan(REEL_FILL_MS);
  });

  it('keeps the hardest fish possible, and clearly harder', () => {
    const hard = SEEDS.map((seed) => play(seed, HARD)).filter((time) => time !== null);
    expect(hard.length).toBeGreaterThan(0);
    expect(hard.length).toBeLessThan(SEEDS.length);
  });
});

describe('stepping the bar in slices', () => {
  // The client steps the reel once a frame, so `dtMs` is whatever the last
  // frame cost. It used to CLAMP a long frame instead of slicing it, which
  // advanced the marker for less time than had actually passed — while the
  // fish, a pure function of wall-clock elapsed, kept going. A hitching client
  // therefore watched its marker fall behind a fish it could see, and below
  // roughly 8 fps the bar stopped being winnable at all. These pin the property
  // the sliced version relies on.
  const drift = fishingDifficulty(1, 'common');

  const stepOver = (totalMs: number, sliceMs: number, holding: boolean): ReelState => {
    let state = createReelState();
    const slices = Math.round(totalMs / sliceMs);
    for (let i = 0; i < slices; i++) {
      const at = sliceMs * (i + 1);
      state = reelStep(state, holding, sliceMs, fishPosition(7, at, drift), drift);
    }
    return state;
  };

  it('carries the marker the same distance however the time is cut up', () => {
    const coarse = stepOver(600, 200, true);
    const fine = stepOver(600, 20, true);
    expect(fine.marker).toBeCloseTo(coarse.marker, 1);
  });

  it('does not let a slower stepper travel further than real time allows', () => {
    // Two seconds of holding, at 20 Hz and at 5 Hz. Both hit the speed cap, so
    // both must end up at the same wall.
    const fast = stepOver(2000, 50, true);
    const slow = stepOver(2000, 200, true);
    expect(fast.marker).toBe(1);
    expect(slow.marker).toBe(1);
  });
});

describe('the reel, played through a server', () => {
  /**
   * The tests above play the bar with the decision and the step at the same
   * instant. No real player ever does: the press goes up, the server applies
   * it on its next tick, and the bar the eye is steering is always a tick
   * ahead of the bar being scored. P10-F measured the difference against a
   * live server — the same crude strategy that lands 20/20 offline landed
   * 0/12 through the wire — so the property worth pinning is this one, not
   * the zero-latency one.
   */
  const playDelayed = (seed: number, drift = EASY, delayTicks = 1): number | null => {
    let state = createReelState();
    const commands: boolean[] = [];
    for (let elapsed = 50; elapsed < REEL_TIMEOUT_MS; elapsed += 50) {
      const fish = fishPosition(seed, elapsed, drift);
      commands.push(state.marker < fish);
      const applied = commands[Math.max(0, commands.length - 1 - delayTicks)] ?? false;
      state = reelStep(state, applied, 50, fish, drift);
      if (state.progress >= 1) return elapsed;
      if (state.peak >= REEL_LOST_PEAK && state.progress <= 0) return null;
    }
    return null;
  };

  const SEEDS = Array.from({ length: 20 }, (_, index) => (index + 1) * 137);

  it('still lands an easy fish when every press arrives a tick late', () => {
    const landed = SEEDS.map((seed) => playDelayed(seed)).filter((time) => time !== null);
    expect(landed).toHaveLength(SEEDS.length);
  });

  it('survives a second tick of delay — a bad connection is not an unwinnable one', () => {
    const landed = SEEDS.map((seed) => playDelayed(seed, EASY, 2)).filter((time) => time !== null);
    expect(landed.length).toBeGreaterThan(SEEDS.length / 2);
  });

  it('still refuses a legendary to the crudest strategy — the ladder survives', () => {
    const landed = SEEDS.map((seed) => playDelayed(seed, HARD)).filter((time) => time !== null);
    expect(landed.length).toBeLessThan(SEEDS.length);
  });
});
