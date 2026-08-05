/**
 * Per-player gathering-profession state (P10, PROFESSIONS.md §1.3).
 *
 * The four professions level independently of the character and of each other,
 * so this is a small map rather than fields on the player. Everything that
 * decides a number is in `@dawned/shared/formulas/professions` — this module
 * holds the state, applies the shared answer, and says what changed.
 */

import {
  MAX_PROFESSION_LEVEL,
  PROFESSIONS,
  addProfXp,
  profXpToNext,
  tierForLevel,
  type Profession,
} from '@dawned/shared';

export interface ProfessionState {
  level: number;
  /** XP into the CURRENT level, matching the wire and the bar. */
  xp: number;
}

/** All four, at level 1 — a fresh character can already chop a birch. */
export const createProfessions = (
  rows: readonly { profession: string; level: number; xp: number }[] = [],
): Map<Profession, ProfessionState> => {
  const state = new Map<Profession, ProfessionState>();
  for (const profession of PROFESSIONS) state.set(profession, { level: 1, xp: 0 });
  for (const row of rows) {
    if (!state.has(row.profession as Profession)) continue;
    state.set(row.profession as Profession, {
      level: Math.min(MAX_PROFESSION_LEVEL, Math.max(1, Math.floor(row.level))),
      xp: Math.max(0, Math.floor(row.xp)),
    });
  }
  return state;
};

export const professionLevel = (
  state: ReadonlyMap<Profession, ProfessionState>,
  profession: Profession,
): number => state.get(profession)?.level ?? 1;

export interface ProfessionAward {
  profession: Profession;
  level: number;
  xp: number;
  /** How many levels this award crossed — 0 for an ordinary gather. */
  levelsGained: number;
}

/** Apply profession XP, cascading levels the way the shared formula says. */
export const awardProfessionXp = (
  state: Map<Profession, ProfessionState>,
  profession: Profession,
  amount: number,
): ProfessionAward => {
  const before = state.get(profession) ?? { level: 1, xp: 0 };
  const after = addProfXp(before, amount);
  state.set(profession, after);
  return {
    profession,
    level: after.level,
    xp: after.xp,
    levelsGained: Math.max(0, after.level - before.level),
  };
};

/** The wire shape for ProfessionSync — the client never runs the curve itself. */
export const professionWire = (
  state: ReadonlyMap<Profession, ProfessionState>,
): { profession: string; level: number; xp: number; xpToNext: number; tier: number }[] =>
  PROFESSIONS.map((profession) => {
    const entry = state.get(profession) ?? { level: 1, xp: 0 };
    return {
      profession,
      level: entry.level,
      xp: entry.xp,
      xpToNext: profXpToNext(entry.level),
      tier: tierForLevel(entry.level),
    };
  });
