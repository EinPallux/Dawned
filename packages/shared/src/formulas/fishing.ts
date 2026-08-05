/**
 * The fishing minigame (docs/design/PROFESSIONS.md §5) — the involved one.
 *
 * Cast → the bobber idles → a **bite** you have a moment to answer → a **reel
 * bar** where a fish drifts and you hold to keep your marker over it. Six
 * seconds of that and it is yours; let it slip and the progress drains until
 * the fish is gone.
 *
 * All of it lives here because the bar is the one place in the game where the
 * client is drawing a fast-moving thing that the server is simultaneously
 * judging. If the two disagree about where the fish is, the player sees a
 * marker sitting on a fish and is told they missed — the single worst thing a
 * minigame can do. So the fish's path is a PURE FUNCTION of a seed and a time,
 * the server picks the seed and sends it at hook, and both sides evaluate the
 * same function. There is nothing to sync after that.
 */

import type { Rarity } from '../content/items.js';

/** Where a fishing attempt is (the wire carries this verbatim). */
export const FishingPhase = {
  /** Line is out, nothing has happened yet. */
  Waiting: 'waiting',
  /** Something is on — press to hook, before the window closes. */
  Bite: 'bite',
  /** The bar is up. */
  Reeling: 'reeling',
  Caught: 'caught',
  /** Missed the bite window, or the progress bar emptied. */
  Escaped: 'escaped',
} as const;
export type FishingPhase = (typeof FishingPhase)[keyof typeof FishingPhase];

/** Bobber idle before a bite, ms (§5: 2–6 s). */
export const BITE_MIN_MS = 2000;
export const BITE_MAX_MS = 6000;
/** How long you have to answer the bite (§5: 0.8 s). */
export const HOOK_WINDOW_MS = 800;
/** Progress needed to land a fish, and how long that takes at a perfect hold. */
export const REEL_FILL_MS = 6000;
/**
 * Drain is slower than fill: a bar that empties as fast as it fills makes one
 * slip fatal, and §5 wants "keep it roughly on target for six seconds", not
 * "never make a mistake".
 */
export const REEL_DRAIN_RATIO = 0.6;

/** How hard a particular fish is to land. */
export interface FishingDifficulty {
  /** Fish travel speed along the bar, bar-lengths per second. */
  driftSpeed: number;
  /** Half-width of the catch marker, in bar fractions (0..0.5). */
  markerHalf: number;
}

/**
 * Difficulty from the fish's tier and rarity (§5: "higher-tier & rare fish
 * drift faster with smaller markers").
 *
 * Deliberately gentle at T1 common — the first fish a player ever hooks should
 * be caught, not lost to a bar they have never seen before.
 */
export const fishingDifficulty = (tier: number, rarity: Rarity): FishingDifficulty => {
  const t = Math.min(5, Math.max(1, Math.round(tier)));
  const rarityStep: Record<Rarity, number> = {
    common: 0,
    uncommon: 1,
    rare: 2,
    epic: 3,
    legendary: 4,
  };
  const step = t - 1 + rarityStep[rarity];
  return {
    driftSpeed: 0.18 + 0.015 * step,
    markerHalf: Math.max(0.06, 0.16 - 0.0105 * step),
  };
};

/**
 * A tiny deterministic hash → [0, 1). Both sides run it; nobody sends numbers.
 *
 * Not cryptographic and does not need to be — its whole job is to give the
 * client and the server the same wobble from the same seed.
 */
export const fishRandom = (seed: number, salt: number): number => {
  let h = (seed ^ (salt * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x1_0000_0000;
};

/** How long this cast idles before the bite (§5: 2–6 s), from the seed. */
export const biteDelayMs = (seed: number): number =>
  Math.round(BITE_MIN_MS + fishRandom(seed, 1) * (BITE_MAX_MS - BITE_MIN_MS));

/**
 * Where the fish sits in the bar at `elapsedMs`, as a fraction 0..1.
 *
 * Two sine waves at unrelated periods, folded into [0,1] by a triangle wave.
 * The second wave is what keeps it from being predictable: one sine is a
 * metronome you can learn in two casts, and a fish that swims on a metronome
 * is not a minigame.
 */
export const fishPosition = (seed: number, elapsedMs: number, drift: FishingDifficulty): number => {
  const t = Math.max(0, elapsedMs) / 1000;
  const phaseA = fishRandom(seed, 2) * Math.PI * 2;
  const phaseB = fishRandom(seed, 3) * Math.PI * 2;
  const raw =
    0.5 +
    0.3 * Math.sin(t * drift.driftSpeed * Math.PI * 2 + phaseA) +
    0.1 * Math.sin(t * drift.driftSpeed * 2.3 * Math.PI * 2 + phaseB);
  // Fold rather than clamp: a clamped fish parks at the wall, which is a free
  // catch for anyone who leaves the marker there.
  const folded = Math.abs((((raw % 2) + 2) % 2) - 1);
  return 1 - folded;
};

/**
 * Marker physics — a held button pushes it up, gravity pulls it down.
 *
 * These are RESPONSIVENESS numbers, and they were chosen by measurement rather
 * than taste. The first pass used gentler accelerations, and the marker lagged
 * so far behind the fish that the crudest possible strategy — hold whenever
 * the marker is below the fish — could not land a T1 common in eighteen
 * seconds. That is not "hard", it is broken: §5 wants the first fish a player
 * ever hooks to be caught.
 *
 * The second pass over-corrected the TOP SPEED, and P10-F caught it against a
 * real server. The measurement that matters is not "can this be won" but "can
 * this be won when the press lands a tick after the eye saw the bar" — which
 * is every press in a server-authoritative game. Same crude strategy, twenty
 * seeds, T1 common:
 *
 *   command delay 0 ticks → 20/20 landed   (all the offline test ever proved)
 *   command delay 1 tick  →  0/20 landed   (what the game actually does)
 *
 * The accelerations were never the problem; the CAP was. One delayed tick at
 * 1.5/s carries the marker 0.075 — half the width of a T1 catch zone — so the
 * correction always arrives after the overshoot and the loop rings instead of
 * settling. At 0.9/s that step is 0.045 and the same crude strategy lands
 * 20/20 through a tick of delay, a T3 rare needs anticipation to land, and a
 * T5 legendary still refuses both. The ladder survives; the
 * unwinnable-in-practice bar does not. Feel is still the owner's pass, and
 * how hard a legendary should be is an open question (USER_QUESTIONS Q27).
 */
export const MARKER_GRAVITY = 3;
export const MARKER_LIFT = 6;
export const MARKER_MAX_SPEED = 0.9;

export interface ReelState {
  /** Marker centre, 0..1. */
  marker: number;
  /** Marker velocity, bar-lengths per second. */
  velocity: number;
  /** Catch progress, 0..1. */
  progress: number;
  /**
   * Highest progress this attempt ever reached.
   *
   * This is what makes "the fish got away" mean *you had it and lost it*
   * rather than *you had not caught up yet*. The marker starts mid-bar and the
   * fish starts wherever the seed says; a player chasing it downward for the
   * first second is playing correctly and must not be told they failed.
   */
  peak: number;
}

export const createReelState = (): ReelState => ({
  marker: 0.5,
  velocity: 0,
  progress: 0,
  peak: 0,
});

/**
 * Advance the bar one step. Pure: same inputs, same result, on both sides.
 *
 * The client runs it every frame for a smooth bar, the server runs it once per
 * tick with the held-button state that arrived on the input stream, and they
 * land in the same place because the fish's position comes from the seed and
 * the marker's from the same physics.
 */
export const reelStep = (
  state: ReelState,
  holding: boolean,
  dtMs: number,
  fish: number,
  drift: FishingDifficulty,
): ReelState => {
  const dt = Math.min(0.2, Math.max(0, dtMs) / 1000);
  const accel = holding ? MARKER_LIFT : -MARKER_GRAVITY;
  let velocity = Math.min(
    MARKER_MAX_SPEED,
    Math.max(-MARKER_MAX_SPEED, state.velocity + accel * dt),
  );
  let marker = state.marker + velocity * dt;
  // The bar's ends are walls, not wrap-around: hitting one kills the velocity
  // so a held button does not bank speed against the ceiling.
  if (marker <= 0) {
    marker = 0;
    velocity = Math.max(0, velocity);
  } else if (marker >= 1) {
    marker = 1;
    velocity = Math.min(0, velocity);
  }
  const onTarget = Math.abs(marker - fish) <= drift.markerHalf;
  const rate = onTarget
    ? dt / (REEL_FILL_MS / 1000)
    : -(dt / (REEL_FILL_MS / 1000)) * REEL_DRAIN_RATIO;
  // Clamped at BOTH ends. Without the floor, a player who never presses ends
  // the attempt at −0.3 progress, which draws as a bar past the left edge and
  // means "how far below empty are you" — a quantity with no meaning.
  const progress = Math.min(1, Math.max(0, state.progress + rate));
  return { marker, velocity, progress, peak: Math.max(state.peak, progress) };
};

/**
 * The fish gives up eventually. Without this a reel can hang for ever: a
 * marker parked at the floor still earns progress every time the fish swims
 * down to it, so an absent player hovers just above empty and never resolves
 * in either direction. Three fill-lengths is generous to someone struggling
 * and final for someone who walked away.
 */
export const REEL_TIMEOUT_MS = REEL_FILL_MS * 3;

/** How much of the bar counts as "you had it" before draining out is a loss. */
export const REEL_LOST_PEAK = 0.2;

/** Has the attempt resolved? `null` while it is still in play. */
export const reelOutcome = (state: ReelState, elapsedMs: number): FishingPhase | null => {
  if (state.progress >= 1) return FishingPhase.Caught;
  // Draining to nothing ends it — but only for someone who had a real hold on
  // it. `peak` is the difference between "lost the fish" and "has not reached
  // it yet"; the threshold is what stops one frame's worth of contact from
  // arming a loss the player never had a chance to feel.
  if (state.peak >= REEL_LOST_PEAK && state.progress <= 0) return FishingPhase.Escaped;
  if (elapsedMs >= REEL_TIMEOUT_MS) return FishingPhase.Escaped;
  return null;
};

/** A cast that has been idle this long with no press has been abandoned. */
export const FISHING_IDLE_TIMEOUT_MS = 45_000;
