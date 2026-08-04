import { describe, expect, it } from 'vitest';
import { CC_DR_WINDOW_MS, applyCcDr, createCcDrState, drLaneOf } from './cc.js';

describe('CC diminishing returns (COMBAT.md §6.4)', () => {
  it('full → half → immune within the window, per category', () => {
    const state = createCcDrState();
    expect(applyCcDr(state, 'stun', 0, 2000)).toEqual({ durationMs: 2000, tier: 0 });
    expect(applyCcDr(state, 'stun', 1000, 2000)).toEqual({ durationMs: 1000, tier: 1 });
    expect(applyCcDr(state, 'stun', 2000, 2000)).toEqual({ durationMs: 0, tier: 2 });
    // Still immune while the window holds.
    expect(applyCcDr(state, 'stun', 5000, 2000)).toEqual({ durationMs: 0, tier: 2 });
  });

  it('categories track independently; chill shares the slow lane', () => {
    const state = createCcDrState();
    applyCcDr(state, 'stun', 0, 2000);
    // A root right after a stun is still full strength (different lane).
    expect(applyCcDr(state, 'root', 100, 3000)).toEqual({ durationMs: 3000, tier: 0 });
    // Chill and slow escalate together.
    expect(applyCcDr(state, 'chill', 200, 4000)).toEqual({ durationMs: 4000, tier: 0 });
    expect(applyCcDr(state, 'slow', 300, 4000)).toEqual({ durationMs: 2000, tier: 1 });
    expect(drLaneOf('chill')).toBe('slow');
  });

  it('the window resets after 10 quiet seconds — but immunity never self-extends', () => {
    const state = createCcDrState();
    applyCcDr(state, 'root', 0, 3000);
    applyCcDr(state, 'root', 1000, 3000); // half, window now until 11000
    // Immune attempts during the window must not push the window out.
    applyCcDr(state, 'root', 5000, 3000);
    applyCcDr(state, 'root', 10999, 3000);
    // The half-application at t=1000 set the window to 11000 — fresh after.
    expect(applyCcDr(state, 'root', 11000, 3000)).toEqual({ durationMs: 3000, tier: 0 });
  });

  it('non-CC categories bypass DR entirely', () => {
    const state = createCcDrState();
    for (let i = 0; i < 5; i++) {
      expect(applyCcDr(state, 'burn', i * 100, 6000)).toEqual({ durationMs: 6000, tier: 0 });
    }
    expect(drLaneOf('poison')).toBeNull();
  });

  it('window constant matches the design doc', () => {
    expect(CC_DR_WINDOW_MS).toBe(10000);
  });
});
