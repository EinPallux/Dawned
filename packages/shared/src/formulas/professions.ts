/**
 * Gathering-profession math (docs/design/PROFESSIONS.md §1).
 *
 * Four professions level 1–30 independently of the character level. Everything
 * that decides whether a swing at a node is legal, how long it takes and what
 * it is worth lives here, because BOTH sides need the same answer: the client
 * draws the hold bar and greys the prompt out, the server times the channel and
 * awards the yield, and the panel previews a gathering session while the owner
 * places nodes.
 *
 * The gates are deterministic — a node you are allowed to touch always yields.
 * PROFESSIONS.md §1.1 is explicit about that ("no fail-rolls; deterministic
 * gates keep it kind"), so nothing in this file rolls against success.
 */

/** The four gathering professions (§1). */
export const PROFESSIONS = ['woodcutting', 'mining', 'herbalism', 'fishing'] as const;
export type Profession = (typeof PROFESSIONS)[number];

/** Independent level cap per profession (§1.3). */
export const MAX_PROFESSION_LEVEL = 30;

/** Node tiers T1–T5. */
export const MIN_NODE_TIER = 1;
export const MAX_NODE_TIER = 5;

/**
 * Profession level that unlocks each tier, indexed by tier (§1.1: 7/13/19/25
 * for T2–T5). Slot 0 is unused so `TIER_GATES[tier]` reads straight.
 */
export const TIER_GATES: readonly number[] = [0, 1, 7, 13, 19, 25];

/** The profession level a tier needs; unknown tiers clamp into range. */
export const gateForTier = (tier: number): number =>
  TIER_GATES[Math.min(MAX_NODE_TIER, Math.max(MIN_NODE_TIER, Math.round(tier)))] ?? 1;

/** The highest tier a profession level may gather (1 at level 1, 5 at 25+). */
export const tierForLevel = (level: number): number => {
  let unlocked = MIN_NODE_TIER;
  for (let tier = MIN_NODE_TIER; tier <= MAX_NODE_TIER; tier++) {
    if (level >= gateForTier(tier)) unlocked = tier;
  }
  return unlocked;
};

// ---------------------------------------------------------------------------
// XP and levels (§1.3)
// ---------------------------------------------------------------------------

/** Shipped default: `round₁₀(60 × L^1.6)`. 0 at the cap (no next level). */
export const profXpToNext = (level: number): number => {
  if (level >= MAX_PROFESSION_LEVEL) return 0;
  return Math.round((60 * Math.pow(Math.max(1, level), 1.6)) / 10) * 10;
};

/** Cumulative profession XP from level 1 to reach `level`. */
export const totalProfXpForLevel = (level: number): number => {
  let total = 0;
  for (let l = 1; l < Math.min(level, MAX_PROFESSION_LEVEL); l++) total += profXpToNext(l);
  return total;
};

/** XP for gathering a node, before any multipliers: `12 × nodeTier` (§1.3). */
export const GATHER_XP_PER_TIER = 12;

/**
 * PROFESSION XP a gather is worth at this profession level.
 *
 * The halving is the "soft push toward the frontier": a node BELOW the best
 * tier you have unlocked pays half, so farming T1 birches at level 25 is a
 * choice rather than a strategy. It is deliberately soft — half, not nothing —
 * because a low-tier node next to a quest you are doing should still count.
 *
 * The CHARACTER-level trickle from the same gather is a different number and
 * lives where the rest of the character curve does: `gatherXp` in
 * progression.ts (PROGRESSION.md §1.1). Do not add a second one here.
 */
export const professionGatherXp = (nodeTier: number, profLevel: number): number => {
  const tier = Math.min(MAX_NODE_TIER, Math.max(MIN_NODE_TIER, Math.round(nodeTier)));
  const base = GATHER_XP_PER_TIER * tier;
  return tier < tierForLevel(profLevel) ? Math.round(base * 0.5) : base;
};

export interface ProfProgress {
  level: number;
  /** XP into the current level (always < profXpToNext at that level). */
  xp: number;
}

/**
 * Apply an XP award, cascading through as many levels as it covers.
 *
 * Same contract as the character-level version in progression.ts: a gather that
 * covers two levels must level twice, and XP past the cap is dropped rather
 * than banked (there is nothing to bank it toward).
 */
export const addProfXp = (from: ProfProgress, amount: number): ProfProgress => {
  let level = Math.min(MAX_PROFESSION_LEVEL, Math.max(1, Math.floor(from.level)));
  let xp = Math.max(0, Math.floor(from.xp)) + Math.max(0, Math.floor(amount));
  for (;;) {
    const need = profXpToNext(level);
    if (need <= 0) return { level, xp: 0 };
    if (xp < need) return { level, xp };
    xp -= need;
    level += 1;
  }
};

// ---------------------------------------------------------------------------
// The channel (§1.1 step 3)
// ---------------------------------------------------------------------------

/** Base hold-to-gather time, ms. */
export const GATHER_CHANNEL_MS = 3000;
/** Profession levels above a tier's gate at which the channel speeds up. */
export const GATHER_SPEED_LEVELS = 4;
/** How much faster, once that threshold is met. */
export const GATHER_SPEED_BONUS = 0.25;

/**
 * How long this player must hold to take this node.
 *
 * −25 % once the profession is 4 levels past the tier's gate: the reward for
 * out-levelling a tier is that farming it stops feeling slow, which is also
 * why the XP halves at the same time. One makes the frontier attractive, the
 * other makes the back country quick.
 */
export const gatherChannelMs = (
  nodeTier: number,
  profLevel: number,
  baseMs = GATHER_CHANNEL_MS,
): number => {
  const gate = gateForTier(nodeTier);
  const fast = profLevel >= gate + GATHER_SPEED_LEVELS;
  return Math.round(Math.max(200, baseMs) * (fast ? 1 - GATHER_SPEED_BONUS : 1));
};

/** Why the server refused a gather — the client turns these into words. */
export const GatherRefusal = {
  /** The node is depleted and still respawning. */
  Depleted: 'depleted',
  /** Profession level below the tier gate. */
  TierLocked: 'tier_locked',
  /** Out of interaction range. */
  TooFar: 'too_far',
  /** Dead, casting, in combat — anything that owns the character right now. */
  Busy: 'busy',
  /** Another player claimed this node first (§1.1 first-tap rule). */
  Claimed: 'claimed',
  /** The bag has no room for the yield. */
  BagFull: 'bag_full',
  /** No such node in the world. */
  Unknown: 'unknown',
} as const;
export type GatherRefusal = (typeof GatherRefusal)[keyof typeof GatherRefusal];

/** Human text per refusal — one place, so client and ops logs agree. */
export const GATHER_REFUSAL_TEXT: Record<GatherRefusal, string> = {
  [GatherRefusal.Depleted]: 'Already harvested — it will regrow shortly.',
  [GatherRefusal.TierLocked]: 'Your profession level is too low for this node.',
  [GatherRefusal.TooFar]: 'Too far away.',
  [GatherRefusal.Busy]: 'Not while you are busy.',
  [GatherRefusal.Claimed]: 'Someone else got there first.',
  [GatherRefusal.BagFull]: 'Your bag is full.',
  [GatherRefusal.Unknown]: 'Nothing to gather there.',
};

export const gatherRefusalText = (code: string): string =>
  (GATHER_REFUSAL_TEXT as Partial<Record<string, string>>)[code] ?? 'You cannot gather that.';

/** How close a player must stand to interact with a node, metres. */
export const GATHER_RANGE_M = 3.5;
/**
 * How far they may drift mid-channel before it breaks. Slightly beyond the
 * interact range so standing still with normal position jitter never cancels
 * a hold the player did not move out of.
 */
export const GATHER_BREAK_RANGE_M = 5;

// ---------------------------------------------------------------------------
// Procs (§1.1 step 5)
// ---------------------------------------------------------------------------

export const PROC_BASE_CHANCE = 0.03;
export const PROC_CHANCE_PER_LEVEL = 0.002;
/** A rare-material roll: `3% + 0.2% × profLevel`, capped so it stays a treat. */
export const procChance = (profLevel: number, bonusRolls = 0): number => {
  const base = PROC_BASE_CHANCE + PROC_CHANCE_PER_LEVEL * Math.max(0, profLevel);
  return Math.min(0.5, base * (1 + Math.max(0, bonusRolls)));
};

/** Can this player gather this node at all? `null` = yes. */
export const gatherRefusalFor = (
  nodeTier: number,
  profLevel: number,
  distanceM: number,
): GatherRefusal | null => {
  if (distanceM > GATHER_RANGE_M) return GatherRefusal.TooFar;
  if (profLevel < gateForTier(nodeTier)) return GatherRefusal.TierLocked;
  return null;
};
