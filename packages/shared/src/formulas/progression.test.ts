import { describe, expect, it } from 'vitest';
import { CLASS_BASE_ATTRIBUTES, playerStats, staminaRegenForEnd, zeroAttributes } from './stats.js';
import {
  MAX_LEVEL,
  applyXpGain,
  applyXpRate,
  defaultXpCurve,
  discoveryXp,
  gatherXp,
  killXp,
  respecCost,
  skillPointsForLevel,
  statPointsForLevel,
  totalXpForLevel,
  xpToNext,
  xpToNextDefault,
} from './progression.js';

describe('level curve (PROGRESSION.md §1.2)', () => {
  it('matches every value in the doc table (formula-exact since the P7 doc fix)', () => {
    // Left column…
    expect(xpToNextDefault(1)).toBe(90);
    expect(xpToNextDefault(2)).toBe(300);
    expect(xpToNextDefault(4)).toBe(1020);
    expect(xpToNextDefault(6)).toBe(2070);
    expect(xpToNextDefault(8)).toBe(3420);
    expect(xpToNextDefault(10)).toBe(5060);
    expect(xpToNextDefault(12)).toBe(6960);
    expect(xpToNextDefault(14)).toBe(9120);
    // …and right column of the §1.2 table.
    expect(xpToNextDefault(16)).toBe(11520);
    expect(xpToNextDefault(18)).toBe(14160);
    expect(xpToNextDefault(20)).toBe(17020);
    expect(xpToNextDefault(22)).toBe(20110);
    expect(xpToNextDefault(24)).toBe(23420);
    expect(xpToNextDefault(26)).toBe(26940);
    expect(xpToNextDefault(28)).toBe(30670);
    expect(xpToNextDefault(29)).toBe(32620);
  });

  it('reaches the cap at the documented cumulative total (360,410)', () => {
    const curve = defaultXpCurve();
    expect(totalXpForLevel(curve, MAX_LEVEL)).toBe(360_410);
    expect(totalXpForLevel(curve, 10)).toBe(15_940);
  });

  it('is 0 at and past the cap, and every value is a round₁₀ integer', () => {
    const curve = defaultXpCurve();
    expect(xpToNext(curve, MAX_LEVEL)).toBe(0);
    expect(xpToNext(curve, MAX_LEVEL + 5)).toBe(0);
    for (let level = 1; level < MAX_LEVEL; level++) {
      const need = xpToNext(curve, level);
      expect(need % 10).toBe(0);
      expect(Number.isInteger(need)).toBe(true);
      if (level > 1) expect(need).toBeGreaterThan(xpToNext(curve, level - 1));
    }
  });

  it('applyXpGain carries overflow across multiple level-ups', () => {
    const curve = defaultXpCurve();
    // 90 + 300 + 20 into level 3.
    const result = applyXpGain(curve, { level: 1, xp: 0 }, 410);
    expect(result).toEqual({ level: 3, xp: 20, levelsGained: 2 });
  });

  it('applyXpGain freezes at the cap and never de-levels', () => {
    const curve = defaultXpCurve();
    const nearCap = applyXpGain(curve, { level: 29, xp: xpToNext(curve, 29) - 10 }, 50);
    expect(nearCap.level).toBe(MAX_LEVEL);
    expect(nearCap.xp).toBe(0);
    expect(nearCap.levelsGained).toBe(1);
    const atCap = applyXpGain(curve, { level: MAX_LEVEL, xp: 0 }, 99_999);
    expect(atCap).toEqual({ level: MAX_LEVEL, xp: 0, levelsGained: 0 });
  });
});

describe('kill XP (§1.1)', () => {
  it('follows 8 + 6×L^1.15 at level parity', () => {
    expect(killXp(1, 'normal', 1)).toBe(14); // 8 + 6
    expect(killXp(5, 'normal', 5)).toBe(46);
    expect(killXp(10, 'normal', 10)).toBe(93);
  });

  it('multiplies ranks: ×1.5 elites, ×4 zone bosses', () => {
    expect(killXp(10, 'elite', 10)).toBe(Math.round((8 + 6 * Math.pow(10, 1.15)) * 1.5));
    expect(killXp(10, 'zone_boss', 10)).toBe(Math.round((8 + 6 * Math.pow(10, 1.15)) * 4));
  });

  it('applies the content xpMult override', () => {
    expect(killXp(5, 'normal', 5, 2)).toBe(Math.round((8 + 6 * Math.pow(5, 1.15)) * 2));
    expect(killXp(5, 'normal', 5, 0)).toBe(1); // even a zeroed row ticks the bar
  });

  it('falls off −10%/level beyond 3 below, floored at 10%', () => {
    // Falloff multiplies the UNROUNDED base (8 + 6×5^1.15 = 46.19…).
    expect(killXp(5, 'normal', 8)).toBe(46); // grace band edge, no falloff
    expect(killXp(5, 'normal', 9)).toBe(42); // ×0.9
    expect(killXp(5, 'normal', 13)).toBe(23); // ×0.5
    expect(killXp(5, 'normal', 30)).toBe(5); // floored at ×0.1
  });

  it('grants no bonus for killing above your level', () => {
    expect(killXp(20, 'normal', 10)).toBe(killXp(20, 'normal', 20));
  });

  it('never rounds to 0', () => {
    expect(killXp(1, 'normal', 30)).toBeGreaterThanOrEqual(1);
  });
});

describe('discovery, gathering and xpRate (§1.1, §7)', () => {
  it('discovery pays basis points of the level need', () => {
    expect(discoveryXp('landmark', 5060)).toBe(405); // 8%
    expect(discoveryXp('vista', 5060)).toBe(607); // 12%
    expect(discoveryXp('zone', 5060)).toBe(759); // 15%
    expect(discoveryXp('zone', 0)).toBe(0); // capped characters
  });

  it('gathering trickles 4×tier', () => {
    expect(gatherXp(1)).toBe(4);
    expect(gatherXp(5)).toBe(20);
  });

  it('xpRate scales but a positive award never becomes 0', () => {
    expect(applyXpRate(100, 1.5)).toBe(150);
    expect(applyXpRate(1, 0.25)).toBe(1);
    expect(applyXpRate(0, 8)).toBe(0);
  });
});

describe('point banking and respec (§2, §3, §6)', () => {
  it('banks 3 stat points and 1 skill point per level', () => {
    expect(statPointsForLevel(1)).toBe(0);
    expect(statPointsForLevel(2)).toBe(3);
    expect(statPointsForLevel(30)).toBe(87);
    expect(skillPointsForLevel(1)).toBe(0);
    expect(skillPointsForLevel(2)).toBe(1);
    expect(skillPointsForLevel(30)).toBe(29);
  });

  it('prices the Mirror of Dawn per level', () => {
    expect(respecCost('skills', 10)).toBe(250);
    expect(respecCost('stats', 10)).toBe(500);
    expect(respecCost('skills', 30)).toBe(750);
  });
});

describe('attribute allocation fold (§2)', () => {
  it('allocated points stack on the class base spread', () => {
    const base = playerStats('warrior', 5);
    const built = playerStats('warrior', 5, { str: 4, agi: 0, int: 0, vit: 2, end: 3 });
    expect(built.maxHp).toBe(base.maxHp + 2 * 12);
    expect(built.ap).toBe(base.ap + 4); // STR is the Warrior primary
    expect(built.armor).toBe(base.armor + 4 * 0.5);
    expect(built.maxStamina).toBe(base.maxStamina + 3 * 5);
  });

  it('AGI feeds Rogue AP and everyone’s crit', () => {
    const rogue = playerStats('rogue', 1, { str: 0, agi: 5, int: 0, vit: 0, end: 0 });
    expect(rogue.ap).toBe(CLASS_BASE_ATTRIBUTES.rogue.agi + 5);
    expect(rogue.critPct).toBeCloseTo(5 + 0.04 * (CLASS_BASE_ATTRIBUTES.rogue.agi + 5));
  });

  it('INT feeds SP and the mana-pool attribute', () => {
    const mage = playerStats('mage', 1, { str: 0, agi: 0, int: 6, vit: 0, end: 0 });
    expect(mage.sp).toBe(21);
    expect(mage.int).toBe(21);
  });

  it('END scales stamina regen +0.2/s per 4 points', () => {
    expect(staminaRegenForEnd(0)).toBe(15);
    expect(staminaRegenForEnd(8)).toBe(15.4);
    expect(staminaRegenForEnd(11)).toBe(15.4); // floors to whole steps of 4
    expect(staminaRegenForEnd(12)).toBe(15.6);
    const warrior = playerStats('warrior', 1, zeroAttributes());
    expect(warrior.staminaRegenPerS).toBe(staminaRegenForEnd(CLASS_BASE_ATTRIBUTES.warrior.end));
  });
});
