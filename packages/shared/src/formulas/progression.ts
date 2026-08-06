/**
 * Progression math (docs/design/PROGRESSION.md) — levels, XP sources, point
 * banking and respec pricing. Both sides consume it: the server awards and
 * persists, the client predicts bar fills and validates allocation clicks
 * before they travel.
 *
 * The level curve itself is CONTENT (`content_xp_curve`, one row per level,
 * panel-editable); the formulas here are the shipped defaults that generate
 * those rows and the interpreters that read them back.
 */

import type { EnemyRank } from './stats.js';

/** Level cap for 0.1.0 (PROGRESSION.md §1.2). */
export const MAX_LEVEL = 30;

/** Attribute points banked per level-up (PROGRESSION.md §2). */
export const STAT_POINTS_PER_LEVEL = 3;

/** Skill points: 1 per level starting at level 2 → 29 at cap (§3). */
export const SKILL_POINTS_PER_LEVEL = 1;

/** Total attribute points a character of `level` has been granted. */
export const statPointsForLevel = (level: number): number =>
  STAT_POINTS_PER_LEVEL * (Math.min(MAX_LEVEL, Math.max(1, level)) - 1);

/** Total skill points a character of `level` has been granted. */
export const skillPointsForLevel = (level: number): number =>
  SKILL_POINTS_PER_LEVEL * (Math.min(MAX_LEVEL, Math.max(1, level)) - 1);

// ---------------------------------------------------------------------------
// Level curve (§1.2)
// ---------------------------------------------------------------------------

/** Shipped default: `round₁₀(90 × L^1.75)`. 0 at the cap (no next level). */
export const xpToNextDefault = (level: number): number => {
  if (level >= MAX_LEVEL) return 0;
  return Math.round((90 * Math.pow(level, 1.75)) / 10) * 10;
};

/**
 * A loaded curve: `xpToNext[level]` for levels 1..29 (index by level, slot 0
 * unused). Built from published `content_xp_curve` rows at boot — see
 * content/xp-curve.ts for the row schema + completeness validation.
 */
export type XpCurve = readonly number[];

/** The formula-generated default curve (tests, seeds, offline tools). */
export const defaultXpCurve = (): XpCurve => {
  const curve: number[] = new Array<number>(MAX_LEVEL).fill(0);
  for (let level = 1; level < MAX_LEVEL; level++) curve[level] = xpToNextDefault(level);
  return curve;
};

/** XP needed to leave `level` (0 at the cap). */
export const xpToNext = (curve: XpCurve, level: number): number =>
  level >= 1 && level < MAX_LEVEL ? (curve[level] ?? 0) : 0;

/** Cumulative XP from level 1 to reach `level` (pacing checks, /setlevel). */
export const totalXpForLevel = (curve: XpCurve, level: number): number => {
  let total = 0;
  for (let l = 1; l < Math.min(level, MAX_LEVEL); l++) total += xpToNext(curve, l);
  return total;
};

export interface XpProgress {
  level: number;
  /** XP into the current level (always < xpToNext at that level). */
  xp: number;
}

export interface XpGainResult extends XpProgress {
  /** How many level-ups this gain triggered (0 = just the bar moved). */
  levelsGained: number;
}

/**
 * Apply an XP amount to a character's progress, carrying overflow across as
 * many level-ups as it funds. At the cap XP stops accumulating (no XP loss
 * exists in the game — there is simply nothing left to fill, §7).
 */
export const applyXpGain = (curve: XpCurve, progress: XpProgress, amount: number): XpGainResult => {
  let level = Math.min(MAX_LEVEL, Math.max(1, progress.level));
  let xp = Math.max(0, progress.xp) + Math.max(0, Math.floor(amount));
  let levelsGained = 0;
  while (level < MAX_LEVEL) {
    const need = xpToNext(curve, level);
    if (need <= 0 || xp < need) break;
    xp -= need;
    level += 1;
    levelsGained += 1;
  }
  if (level >= MAX_LEVEL) xp = 0; // capped: the bar stays empty, nothing accrues
  return { level, xp, levelsGained };
};

// ---------------------------------------------------------------------------
// XP sources (§1.1)
// ---------------------------------------------------------------------------

/** Rank multipliers on kill XP (§1.1: ×1.5 elites, ×4 zone bosses). */
export const KILL_XP_RANK_MULT: Record<EnemyRank, number> = {
  normal: 1,
  elite: 1.5,
  zone_boss: 4,
  world_boss: 4,
};

/** Level-gap falloff starts this many levels below the killer. */
export const KILL_XP_FALLOFF_GRACE = 3;
/** −10% per level beyond the grace band… */
export const KILL_XP_FALLOFF_PER_LEVEL = 0.1;
/** …never below 10% (§1.1 — generous for friends, still anti-farm). */
export const KILL_XP_FALLOFF_FLOOR = 0.1;

/**
 * Kill XP before the world xpRate (§1.1): `8 + 6 × mobLevel^1.15`, rank
 * multiplied, reduced when the killer out-levels the mob beyond the grace
 * band. Killing UP never grants a bonus. `xpMult` is the enemy row's
 * per-content override (rare tuning handle, default 1). Always ≥ 1.
 */
export const killXp = (
  mobLevel: number,
  rank: EnemyRank,
  killerLevel: number,
  xpMult = 1,
): number => {
  const base = (8 + 6 * Math.pow(Math.max(1, mobLevel), 1.15)) * KILL_XP_RANK_MULT[rank] * xpMult;
  const below = killerLevel - mobLevel;
  const falloff =
    below > KILL_XP_FALLOFF_GRACE
      ? Math.max(
          KILL_XP_FALLOFF_FLOOR,
          1 - KILL_XP_FALLOFF_PER_LEVEL * (below - KILL_XP_FALLOFF_GRACE),
        )
      : 1;
  return Math.max(1, Math.round(base * falloff));
};

/** Tag rule (§1.1): ≥10% damage contribution OR any heal on the tagger. */
export const XP_TAG_DAMAGE_FRACTION = 0.1;

/**
 * Discovery XP in basis points of the discoverer's current level-need
 * (§1.1 — percent-based so discoveries stay meaningful at every level).
 * Zone first-entry ships with P7; POIs consume the same table at P11.
 */
export const DISCOVERY_XP_BP = {
  landmark: 800,
  vista: 1200,
  zone: 1500,
} as const;
export type DiscoveryKind = keyof typeof DISCOVERY_XP_BP;

/**
 * Per-POI-kind discovery value, basis points against the level's need
 * (WORLD.md §4.1). These are the DEFAULTS the map editor stamps onto a new
 * placement's `xpBasis`; the authored row then owns the number, so a
 * particularly hard-won vista can be worth more than the table says.
 *
 * The ordering is the design's: a camp is a fight you found, a vista is a
 * climb, a cache is a search, and a curiosity is a joke — paid for being
 * charming rather than for being far.
 */
export const POI_XP_BASIS = {
  curiosity: 400,
  landmark: 800,
  shrine: 900,
  cache: 1000,
  camp: 1000,
  vista: 1200,
} as const;
export type PoiXpKind = keyof typeof POI_XP_BASIS;

/**
 * A POI's discovery XP. Takes the authored basis rather than the kind, because
 * the row is what ships — reading the kind here would silently ignore an author
 * who deliberately raised one.
 */
export const poiDiscoveryXp = (xpBasis: number, xpToNextAtLevel: number): number =>
  xpToNextAtLevel <= 0 ? 0 : Math.max(1, Math.round((xpToNextAtLevel * xpBasis) / 10000));

/** Basis-points XP against the level's need; capped characters get nothing. */
export const discoveryXp = (kind: DiscoveryKind, xpToNextAtLevel: number): number =>
  xpToNextAtLevel <= 0
    ? 0
    : Math.max(1, Math.round((xpToNextAtLevel * DISCOVERY_XP_BP[kind]) / 10000));

/** Gathering trickle (§1.1): `4 × nodeTier` — consumed at P10. */
export const gatherXp = (nodeTier: number): number => 4 * Math.max(1, Math.floor(nodeTier));

/**
 * World XP-rate modifier (`world_settings.xpRate`, §7). Applied LAST, and a
 * positive award never rounds to zero (§7 "every action ticks the bar").
 */
export const applyXpRate = (amount: number, xpRate: number): number =>
  amount <= 0 ? 0 : Math.max(1, Math.round(amount * xpRate));

// ---------------------------------------------------------------------------
// Respec (§6 — Mirror of Dawn, Dawnhaven)
// ---------------------------------------------------------------------------

/** Full skill-tree refund price per character level, in gold. */
export const RESPEC_SKILLS_GOLD_PER_LEVEL = 25;
/** Attribute re-allocation price per character level, in gold. */
export const RESPEC_STATS_GOLD_PER_LEVEL = 50;

export type RespecKind = 'skills' | 'stats';

export const respecCost = (kind: RespecKind, level: number): number =>
  (kind === 'skills' ? RESPEC_SKILLS_GOLD_PER_LEVEL : RESPEC_STATS_GOLD_PER_LEVEL) *
  Math.max(1, Math.min(MAX_LEVEL, level));
