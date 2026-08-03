/**
 * CC diminishing returns on players (P6, COMBAT.md §6.4): same-category CC
 * within 10 s lands at full → half → immune, protecting the solo experience
 * against mob packs. One tracker per player, one lane per category
 * (stun / root / slow — chill shares the slow lane).
 *
 * The window is measured from each APPLICATION: every landed (non-immune) CC
 * restarts the 10 s clock, so a chain-stunning pack escalates to immunity
 * fast and the lane only resets after 10 quiet seconds.
 */

import type { EffectCategory } from '../content/abilities.js';

export const CC_DR_WINDOW_MS = 10000;

/** Which DR lane a status category belongs to (null = no DR, always full). */
export const drLaneOf = (category: EffectCategory): 'stun' | 'root' | 'slow' | null => {
  switch (category) {
    case 'stun':
      return 'stun';
    case 'root':
      return 'root';
    case 'slow':
    case 'chill':
      return 'slow';
    default:
      return null;
  }
};

interface DrLane {
  /** Applications inside the current window (0 = fresh). */
  hits: number;
  /** Clock time the lane resets (10 s after the last landed application). */
  windowUntilMs: number;
}

export interface CcDrState {
  lanes: Map<'stun' | 'root' | 'slow', DrLane>;
}

export const createCcDrState = (): CcDrState => ({ lanes: new Map() });

export interface CcApplication {
  /** Duration to actually apply (0 = immune, nothing lands). */
  durationMs: number;
  /** 0 = full, 1 = halved, 2 = immune — UI feedback ("Immune!" floater). */
  tier: 0 | 1 | 2;
}

/**
 * Register a CC application attempt and get the DR-adjusted duration.
 * Categories without a DR lane pass through at full strength.
 */
export const applyCcDr = (
  state: CcDrState,
  category: EffectCategory,
  nowMs: number,
  baseDurationMs: number,
): CcApplication => {
  const laneKey = drLaneOf(category);
  if (laneKey === null) return { durationMs: baseDurationMs, tier: 0 };

  let lane = state.lanes.get(laneKey);
  if (!lane || nowMs >= lane.windowUntilMs) {
    lane = { hits: 0, windowUntilMs: 0 };
    state.lanes.set(laneKey, lane);
  }

  if (lane.hits >= 2) {
    // Immune: the attempt does NOT extend the window — immunity that keeps
    // refreshing itself under fire would never expire.
    return { durationMs: 0, tier: 2 };
  }

  const tier = lane.hits as 0 | 1;
  lane.hits += 1;
  lane.windowUntilMs = nowMs + CC_DR_WINDOW_MS;
  return { durationMs: tier === 0 ? baseDurationMs : Math.round(baseDurationMs / 2), tier };
};
