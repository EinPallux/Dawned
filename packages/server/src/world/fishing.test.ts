/**
 * Server-side fishing (P10-C). The shared module owns the maths; this covers
 * the decisions the server has to make on its own: when the bite comes, which
 * fish is on the line, whether a press was in time, and what a caught or
 * escaped attempt does to the spot.
 */

import { describe, expect, it } from 'vitest';
import {
  FishingPhase,
  HOOK_WINDOW_MS,
  REEL_TIMEOUT_MS,
  biteDelayMs,
  fishPosition,
  validateItemDef,
  validateResourceNodeDef,
  type ItemDef,
  type ResourceNodeDef,
} from '@dawned/shared';
import { fishingExpired, fishingXp, hookFishing, startFishing, stepFishing } from './fishing.js';

const SPRAT: ItemDef = validateItemDef({
  id: 'item_material_dawn_sprat',
  name: 'Dawn Sprat',
  category: 'material',
  rarity: 'common',
  icon: 'fish-1',
  stack: 50,
  value: 5,
});
const SUNSCALE: ItemDef = validateItemDef({
  id: 'item_material_sunscale',
  name: 'Sunscale',
  category: 'material',
  rarity: 'rare',
  icon: 'fish-2',
  stack: 20,
  value: 40,
});
const ITEMS = new Map([
  [SPRAT.id, SPRAT],
  [SUNSCALE.id, SUNSCALE],
]);

const SHOAL: ResourceNodeDef = validateResourceNodeDef({
  id: 'node_fishing_shore_shoal',
  name: 'Shore Shoal',
  profession: 'fishing',
  tier: 1,
  modelRef: 'nature_fish_ripple',
  yields: [
    { itemId: SPRAT.id, qtyMin: 1, qtyMax: 1, weight: 9 },
    { itemId: SUNSCALE.id, qtyMin: 1, qtyMax: 1, weight: 1 },
  ],
});

const cast = (seed = 1234, nowMs = 10_000, rolls = { fishPick: 0, fishQty: 0 }) =>
  startFishing(SHOAL, 'shoal_1', seed, nowMs, 0, 0, rolls, ITEMS);

describe('casting', () => {
  it('opens waiting, with the bite already scheduled from the seed', () => {
    const session = cast();
    expect(session.phase).toBe(FishingPhase.Waiting);
    expect(session.biteAtMs).toBe(10_000 + biteDelayMs(1234));
  });

  /**
   * The fish is decided at the CAST, not at the catch: the bar's difficulty has
   * to match what is on the line, and picking the prize after the player has
   * fought for it would mean a rare that drifted like a common.
   */
  it('picks the fish up front, and sizes the bar to it', () => {
    const common = cast(1, 0, { fishPick: 0.1, fishQty: 0 });
    const rare = cast(1, 0, { fishPick: 0.95, fishQty: 0 });
    expect(common.fishItemId).toBe(SPRAT.id);
    expect(rare.fishItemId).toBe(SUNSCALE.id);
    expect(rare.markerHalf).toBeLessThan(common.markerHalf);
    expect(rare.driftSpeed).toBeGreaterThan(common.driftSpeed);
  });
});

describe('the bite', () => {
  it('does nothing until the delay has run', () => {
    const session = cast();
    expect(stepFishing(session, false, session.biteAtMs - 1, 50).changed).toBe(false);
    expect(session.phase).toBe(FishingPhase.Waiting);
  });

  it('opens a window when it lands', () => {
    const session = cast();
    const tick = stepFishing(session, false, session.biteAtMs, 50);
    expect(tick.changed).toBe(true);
    expect(session.phase).toBe(FishingPhase.Bite);
    expect(session.hookUntilMs).toBe(session.biteAtMs + HOOK_WINDOW_MS);
  });

  it('takes a press inside the window', () => {
    const session = cast();
    stepFishing(session, false, session.biteAtMs, 50);
    expect(hookFishing(session, session.hookUntilMs - 10)).toBe(true);
    expect(session.phase).toBe(FishingPhase.Reeling);
  });

  it('refuses a press after the window — the SERVER owns that clock', () => {
    const session = cast();
    stepFishing(session, false, session.biteAtMs, 50);
    expect(hookFishing(session, session.hookUntilMs + 1)).toBe(false);
  });

  it('refuses a press before anything is on the line', () => {
    const session = cast();
    expect(hookFishing(session, session.castAtMs + 10)).toBe(false);
    expect(session.phase).toBe(FishingPhase.Waiting);
  });

  it('lets the fish go when the window closes unanswered', () => {
    const session = cast();
    stepFishing(session, false, session.biteAtMs, 50);
    const missed = stepFishing(session, false, session.hookUntilMs + 1, 50);
    expect(missed.resolved).toBe('escaped');
    expect(session.phase).toBe(FishingPhase.Escaped);
  });
});

describe('the reel', () => {
  /** Drive an attempt with a player who actually tracks the fish. */
  const playWell = (session: ReturnType<typeof cast>, limitMs = 30_000) => {
    let now = session.reelStartedAtMs;
    for (let elapsed = 50; elapsed < limitMs; elapsed += 50) {
      now += 50;
      const fish = fishPosition(session.seed, elapsed, {
        driftSpeed: session.driftSpeed,
        markerHalf: session.markerHalf,
      });
      const tick = stepFishing(session, session.reel.marker < fish, now, 50);
      if (tick.resolved) return tick.resolved;
    }
    return null;
  };

  it('lands the fish for a player who tracks it', () => {
    const session = cast();
    stepFishing(session, false, session.biteAtMs, 50);
    hookFishing(session, session.biteAtMs + 100);
    expect(playWell(session)).toBe('caught');
    expect(session.reel.progress).toBe(1);
  });

  it('loses it for a player who never presses', () => {
    const session = cast();
    stepFishing(session, false, session.biteAtMs, 50);
    hookFishing(session, session.biteAtMs + 100);
    let now = session.reelStartedAtMs;
    let resolved: string | null = null;
    for (let elapsed = 0; elapsed < REEL_TIMEOUT_MS + 1000 && !resolved; elapsed += 50) {
      now += 50;
      resolved = stepFishing(session, false, now, 50).resolved;
    }
    expect(resolved).toBe('escaped');
  });

  it('is judged by the SERVER stepping the same bar the client draws', () => {
    // Two identical runs from one seed land in exactly the same place — which
    // is the property that lets the client predict the bar at all.
    const a = cast(777);
    const b = cast(777);
    for (const session of [a, b]) {
      stepFishing(session, false, session.biteAtMs, 50);
      hookFishing(session, session.biteAtMs + 100);
    }
    playWell(a);
    playWell(b);
    expect(a.reel.progress).toBe(b.reel.progress);
    expect(a.reel.marker).toBe(b.reel.marker);
  });
});

describe('housekeeping', () => {
  it('pays the same profession XP a gather of that tier would', () => {
    expect(fishingXp(cast(), 1)).toBe(12);
    expect(fishingXp(cast(), 13)).toBe(6);
  });

  it('expires a cast nobody ever answered', () => {
    const session = cast(1, 0);
    expect(fishingExpired(session, 30_000)).toBe(false);
    expect(fishingExpired(session, 61_000)).toBe(true);
  });

  it('expires a reel left running far past its own timeout', () => {
    const session = cast(1, 0);
    stepFishing(session, false, session.biteAtMs, 50);
    hookFishing(session, session.biteAtMs + 10);
    expect(fishingExpired(session, session.reelStartedAtMs + 1000)).toBe(false);
    expect(fishingExpired(session, session.reelStartedAtMs + REEL_TIMEOUT_MS + 3000)).toBe(true);
  });
});
