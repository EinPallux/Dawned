/**
 * Server-side fishing (P10-C, PROFESSIONS.md §5).
 *
 * A fishing spot is a resource node whose profession is `fishing`, so it
 * inherits everything the other three already have: tier gates, XP, respawn,
 * codex, the first-tap claim. What is different is the CHANNEL — instead of a
 * three-second timer, holding a fishing node runs a minigame.
 *
 * The server owns every decision: when the bite comes, which fish, whether the
 * hook press was in time, and how the bar actually went. The client's copy of
 * the bar is a prediction it draws from the same seed, which is why nothing
 * about the fish's position is ever sent.
 */

import {
  FishingPhase,
  HOOK_WINDOW_MS,
  REEL_TIMEOUT_MS,
  biteDelayMs,
  createReelState,
  fishPosition,
  fishingDifficulty,
  pickWeighted,
  professionGatherXp,
  reelOutcome,
  reelStep,
  type ItemDef,
  type ReelState,
  type ResourceNodeDef,
} from '@dawned/shared';

/** One player's fishing attempt. */
export interface FishingSession {
  placementId: string;
  nodeId: string;
  tier: number;
  /** Drift seed — the client gets this and evaluates the same fish path. */
  seed: number;
  phase: FishingPhase;
  /** Server time the line went out. */
  castAtMs: number;
  /** Server time the bite happens (rolled from the seed). */
  biteAtMs: number;
  /** Server time the hook window closes; 0 until the bite. */
  hookUntilMs: number;
  /** Server time the reel bar opened; 0 until hooked. */
  reelStartedAtMs: number;
  reel: ReelState;
  /** Which fish is on the line — decided at the bite, not at the catch. */
  fishItemId: string;
  fishQty: number;
  driftSpeed: number;
  markerHalf: number;
  /** Where the player stood when they cast — the leash, as for any gather. */
  originX: number;
  originZ: number;
}

/**
 * Open a fishing attempt on a node.
 *
 * The fish is chosen NOW rather than on the catch: the bar's difficulty has to
 * match what is actually on the line, and deciding the prize after the player
 * has fought for it would mean a legendary that drifted like a sprat.
 */
export const startFishing = (
  def: ResourceNodeDef,
  placementId: string,
  seed: number,
  nowMs: number,
  originX: number,
  originZ: number,
  rolls: { fishPick: number; fishQty: number },
  items: ReadonlyMap<string, ItemDef>,
  /**
   * `/ops/fish` — force which of this water's yields is on the line, instead of
   * rolling for it. A rare is one weight in ten, so measuring "is the rare's bar
   * winnable?" by fishing until one turns up measures the YIELD ROLL's luck, not
   * the bar. Ignored when the water does not list the item, so a stale lever
   * silently falls back to a normal cast rather than handing out a fish that
   * does not live here.
   */
  forceItemId?: string,
): FishingSession => {
  const forced = forceItemId ? def.yields.find((y) => y.itemId === forceItemId) : undefined;
  const chosen = forced ?? pickWeighted(def.yields, rolls.fishPick);
  const span = chosen ? chosen.qtyMax - chosen.qtyMin + 1 : 1;
  const qty = chosen ? chosen.qtyMin + Math.floor(Math.min(0.999999, rolls.fishQty) * span) : 1;
  const rarity = chosen ? (items.get(chosen.itemId)?.rarity ?? 'common') : 'common';
  const difficulty = fishingDifficulty(def.tier, rarity);
  return {
    placementId,
    nodeId: def.id,
    tier: def.tier,
    seed,
    phase: FishingPhase.Waiting,
    castAtMs: nowMs,
    biteAtMs: nowMs + biteDelayMs(seed),
    hookUntilMs: 0,
    reelStartedAtMs: 0,
    reel: createReelState(),
    fishItemId: chosen?.itemId ?? '',
    fishQty: qty,
    driftSpeed: difficulty.driftSpeed,
    markerHalf: difficulty.markerHalf,
    originX,
    originZ,
  };
};

/** What one tick of fishing did — the caller turns this into events. */
export interface FishingTick {
  /** True when the phase changed and the client needs telling. */
  changed: boolean;
  /** Set once the attempt is over. */
  resolved: 'caught' | 'escaped' | null;
}

/**
 * Advance one attempt by a tick.
 *
 * `holding` is the Reel button off the 20 Hz input stream. The server runs the
 * SAME `reelStep` the client is running, against the same fish position, so
 * its progress is the authority and the client's is a prediction that gets
 * corrected — never a second opinion.
 */
export const stepFishing = (
  session: FishingSession,
  holding: boolean,
  nowMs: number,
  dtMs: number,
): FishingTick => {
  switch (session.phase) {
    case FishingPhase.Waiting: {
      if (nowMs < session.biteAtMs) return { changed: false, resolved: null };
      session.phase = FishingPhase.Bite;
      session.hookUntilMs = nowMs + HOOK_WINDOW_MS;
      return { changed: true, resolved: null };
    }
    case FishingPhase.Bite: {
      // The window closing is a miss. The server decides that, not the client:
      // a late press must not be able to argue it was early.
      if (nowMs <= session.hookUntilMs) return { changed: false, resolved: null };
      session.phase = FishingPhase.Escaped;
      return { changed: true, resolved: 'escaped' };
    }
    case FishingPhase.Reeling: {
      const elapsed = nowMs - session.reelStartedAtMs;
      const fish = fishPosition(session.seed, elapsed, {
        driftSpeed: session.driftSpeed,
        markerHalf: session.markerHalf,
      });
      session.reel = reelStep(session.reel, holding, dtMs, fish, {
        driftSpeed: session.driftSpeed,
        markerHalf: session.markerHalf,
      });
      const outcome = reelOutcome(session.reel, elapsed);
      if (!outcome) return { changed: false, resolved: null };
      session.phase = outcome;
      return {
        changed: true,
        resolved: outcome === FishingPhase.Caught ? 'caught' : 'escaped',
      };
    }
    default:
      return { changed: false, resolved: null };
  }
};

/** Answer a bite. Returns false when the press was early or late. */
export const hookFishing = (session: FishingSession, nowMs: number): boolean => {
  if (session.phase !== FishingPhase.Bite) return false;
  if (nowMs > session.hookUntilMs) return false;
  session.phase = FishingPhase.Reeling;
  session.reelStartedAtMs = nowMs;
  session.reel = createReelState();
  return true;
};

/** Profession XP for landing this fish — the same curve every gather uses. */
export const fishingXp = (session: FishingSession, profLevel: number): number =>
  professionGatherXp(session.tier, profLevel);

/** A cast nobody has touched for a very long time has been abandoned. */
export const fishingExpired = (session: FishingSession, nowMs: number): boolean =>
  session.phase === FishingPhase.Reeling
    ? nowMs - session.reelStartedAtMs > REEL_TIMEOUT_MS + 2000
    : nowMs - session.castAtMs > 60_000;
