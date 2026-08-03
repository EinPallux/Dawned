/**
 * Enemy stagger meter (docs/design/COMBAT.md §6.4) — the "poise" rhythm that
 * makes combo payoffs land. Players never have a meter (explicit CC only).
 *
 * Decay tuning note: COMBAT.md defines fill/trigger but not decay; the shipped
 * default (pause 2.5 s after the last gain, then 15/s) keeps sustained combos
 * honest while a fled fight bleeds back to zero — logged in USER_QUESTIONS.md
 * with this recommendation.
 */

import { STAGGER_DECAY_DELAY_MS, STAGGER_DECAY_PER_S, STAGGER_THRESHOLD } from '../constants.js';

export interface StaggerState {
  /** 0..STAGGER_THRESHOLD. */
  meter: number;
  /** Ms since the last meter gain (drives decay delay). */
  sinceGainMs: number;
}

export const createStaggerState = (): StaggerState => ({
  meter: 0,
  sinceGainMs: STAGGER_DECAY_DELAY_MS,
});

/**
 * Add stagger (scaled by the target's rank gain factor). Returns true when the
 * meter fills — the caller triggers the HitReact stun, vulnerability window
 * and resets the meter.
 */
export const addStagger = (state: StaggerState, amount: number, gainFactor: number): boolean => {
  if (gainFactor <= 0 || amount <= 0) return false;
  state.meter += amount * gainFactor;
  state.sinceGainMs = 0;
  if (state.meter >= STAGGER_THRESHOLD) {
    state.meter = 0;
    return true;
  }
  return false;
};

/** Advance decay by dt. Only time BEYOND the delay decays — exact at any step size. */
export const tickStagger = (state: StaggerState, dtMs: number): void => {
  const before = state.sinceGainMs;
  state.sinceGainMs += dtMs;
  if (state.meter <= 0) return;
  const decayableMs = state.sinceGainMs - Math.max(before, STAGGER_DECAY_DELAY_MS);
  if (decayableMs > 0) {
    state.meter = Math.max(0, state.meter - (STAGGER_DECAY_PER_S * decayableMs) / 1000);
  }
};
