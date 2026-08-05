/**
 * PROFESSIONS.md §1 as executable rules. These are the numbers the client draws
 * a hold bar from, the server times a channel with, and the panel previews a
 * gathering session with — a disagreement between any two of those is a bar
 * that finishes before the yield lands, so they get pinned here.
 */

import { describe, expect, it } from 'vitest';
import {
  GATHER_CHANNEL_MS,
  GATHER_RANGE_M,
  GATHER_XP_PER_TIER,
  GatherRefusal,
  MAX_NODE_TIER,
  MAX_PROFESSION_LEVEL,
  PROFESSIONS,
  TIER_GATES,
  addProfXp,
  gateForTier,
  gatherChannelMs,
  gatherRefusalFor,
  gatherRefusalText,
  professionGatherXp,
  procChance,
  profXpToNext,
  tierForLevel,
  totalProfXpForLevel,
} from './professions.js';
import { gatherXp as characterGatherXp } from './progression.js';

describe('tier gates', () => {
  it('matches the design doc: 1 / 7 / 13 / 19 / 25', () => {
    expect([1, 2, 3, 4, 5].map(gateForTier)).toEqual([1, 7, 13, 19, 25]);
  });

  it('unlocks exactly one tier at each gate level', () => {
    expect(tierForLevel(1)).toBe(1);
    expect(tierForLevel(6)).toBe(1);
    expect(tierForLevel(7)).toBe(2);
    expect(tierForLevel(12)).toBe(2);
    expect(tierForLevel(13)).toBe(3);
    expect(tierForLevel(19)).toBe(4);
    expect(tierForLevel(24)).toBe(4);
    expect(tierForLevel(25)).toBe(5);
    expect(tierForLevel(MAX_PROFESSION_LEVEL)).toBe(MAX_NODE_TIER);
  });

  it('clamps a tier that came off the wire', () => {
    expect(gateForTier(0)).toBe(1);
    expect(gateForTier(99)).toBe(25);
  });

  it('has one gate entry per tier', () => {
    expect(TIER_GATES).toHaveLength(MAX_NODE_TIER + 1);
  });
});

describe('profession XP curve', () => {
  it('is round₁₀(60 × L^1.6)', () => {
    expect(profXpToNext(1)).toBe(60);
    expect(profXpToNext(2)).toBe(Math.round((60 * Math.pow(2, 1.6)) / 10) * 10);
    expect(profXpToNext(10)).toBe(Math.round((60 * Math.pow(10, 1.6)) / 10) * 10);
  });

  it('rises monotonically and stops at the cap', () => {
    for (let level = 1; level < MAX_PROFESSION_LEVEL - 1; level++) {
      expect(profXpToNext(level + 1)).toBeGreaterThan(profXpToNext(level));
    }
    expect(profXpToNext(MAX_PROFESSION_LEVEL)).toBe(0);
    expect(profXpToNext(MAX_PROFESSION_LEVEL + 5)).toBe(0);
  });

  it('sums the same way a player earns it', () => {
    let total = 0;
    for (let level = 1; level < 12; level++) total += profXpToNext(level);
    expect(totalProfXpForLevel(12)).toBe(total);
  });
});

describe('gather XP', () => {
  it('pays 12 × tier at the frontier', () => {
    expect(professionGatherXp(1, 1)).toBe(GATHER_XP_PER_TIER);
    expect(professionGatherXp(2, 7)).toBe(GATHER_XP_PER_TIER * 2);
    expect(professionGatherXp(5, 25)).toBe(GATHER_XP_PER_TIER * 5);
  });

  it('halves for a node below the best tier you have unlocked', () => {
    // Level 13 unlocks T3, so a T1 birch is back country.
    expect(professionGatherXp(1, 13)).toBe(GATHER_XP_PER_TIER / 2);
    expect(professionGatherXp(3, 13)).toBe(GATHER_XP_PER_TIER * 3);
  });

  it('does not halve a node you have only just unlocked', () => {
    expect(professionGatherXp(2, 7)).toBe(GATHER_XP_PER_TIER * 2);
    expect(professionGatherXp(2, 12)).toBe(GATHER_XP_PER_TIER * 2);
    expect(professionGatherXp(2, 13)).toBe(GATHER_XP_PER_TIER); // T3 is now the frontier
  });

  it('leaves the CHARACTER trickle to progression.ts', () => {
    // PROGRESSION.md §1.1 owns that number (`gatherXp`, 4 × tier). A second
    // one here would be two answers to one question.
    expect(characterGatherXp(3)).toBe(12);
  });
});

describe('addProfXp', () => {
  it('banks XP inside a level', () => {
    expect(addProfXp({ level: 1, xp: 0 }, 30)).toEqual({ level: 1, xp: 30 });
  });

  it('levels exactly at the threshold', () => {
    expect(addProfXp({ level: 1, xp: 0 }, profXpToNext(1))).toEqual({ level: 2, xp: 0 });
  });

  it('cascades through several levels in one award', () => {
    const enough = profXpToNext(1) + profXpToNext(2) + profXpToNext(3) + 5;
    expect(addProfXp({ level: 1, xp: 0 }, enough)).toEqual({ level: 4, xp: 5 });
  });

  it('stops at the cap and drops the overflow', () => {
    const result = addProfXp({ level: MAX_PROFESSION_LEVEL, xp: 0 }, 10_000);
    expect(result).toEqual({ level: MAX_PROFESSION_LEVEL, xp: 0 });
  });

  it('reaches the cap from level 1 given the whole curve', () => {
    const result = addProfXp({ level: 1, xp: 0 }, totalProfXpForLevel(MAX_PROFESSION_LEVEL));
    expect(result.level).toBe(MAX_PROFESSION_LEVEL);
  });

  it('ignores negative awards rather than un-levelling', () => {
    expect(addProfXp({ level: 3, xp: 10 }, -500)).toEqual({ level: 3, xp: 10 });
  });
});

describe('the channel', () => {
  it('is 3 s at the gate', () => {
    expect(gatherChannelMs(1, 1)).toBe(GATHER_CHANNEL_MS);
    expect(gatherChannelMs(2, 7)).toBe(GATHER_CHANNEL_MS);
  });

  it('drops 25 % four levels past the gate', () => {
    expect(gatherChannelMs(1, 4)).toBe(GATHER_CHANNEL_MS);
    expect(gatherChannelMs(1, 5)).toBe(Math.round(GATHER_CHANNEL_MS * 0.75));
    expect(gatherChannelMs(3, 17)).toBe(Math.round(GATHER_CHANNEL_MS * 0.75));
    expect(gatherChannelMs(3, 16)).toBe(GATHER_CHANNEL_MS);
  });

  it('respects a per-node base time', () => {
    expect(gatherChannelMs(1, 1, 5000)).toBe(5000);
    expect(gatherChannelMs(1, 30, 5000)).toBe(3750);
  });

  it('never goes below a fifth of a second, whatever a row says', () => {
    expect(gatherChannelMs(1, 30, 0)).toBeGreaterThanOrEqual(150);
  });
});

describe('refusals', () => {
  it('lets a level-1 gatherer take a T1 node in range', () => {
    expect(gatherRefusalFor(1, 1, 2)).toBeNull();
  });

  it('refuses a tier above the gate', () => {
    expect(gatherRefusalFor(3, 7, 2)).toBe(GatherRefusal.TierLocked);
    expect(gatherRefusalFor(3, 13, 2)).toBeNull();
  });

  it('checks range before the gate — the nearer truth wins', () => {
    expect(gatherRefusalFor(5, 1, GATHER_RANGE_M + 1)).toBe(GatherRefusal.TooFar);
  });

  it('has words for every code, and for one it has never seen', () => {
    for (const code of Object.values(GatherRefusal)) {
      expect(gatherRefusalText(code).length).toBeGreaterThan(0);
    }
    expect(gatherRefusalText('not_a_real_code')).toBe('You cannot gather that.');
  });
});

describe('procs', () => {
  it('is 3 % + 0.2 % per level', () => {
    expect(procChance(0)).toBeCloseTo(0.03, 6);
    expect(procChance(10)).toBeCloseTo(0.05, 6);
    expect(procChance(30)).toBeCloseTo(0.09, 6);
  });

  it('gives risky nodes their extra roll (§1.4)', () => {
    expect(procChance(10, 1)).toBeCloseTo(0.1, 6);
  });

  it('stays a treat rather than a certainty', () => {
    expect(procChance(30, 20)).toBeLessThanOrEqual(0.5);
  });
});

describe('the profession list', () => {
  it('is the four the design names', () => {
    expect([...PROFESSIONS]).toEqual(['woodcutting', 'mining', 'herbalism', 'fishing']);
  });
});
