/**
 * Questions about `ENEMY_MODEL_CLIPS` — deliberately NOT in the same file.
 *
 * `enemy-clips.ts` is written whole by `pnpm assets:clips`. This helper used to
 * live at the bottom of it, and the first run of the generator deleted it: the
 * game repo never calls it, so `pnpm check` stayed green, and the only thing
 * that broke was the PANEL's publish cross-check — the one that refuses an
 * ability naming a clip its model does not own, which is the reason the
 * registry exists at all (docs/design/NPCS_ENEMIES.md §4.1).
 *
 * A generated file may hold generated data and nothing else.
 */

import { ENEMY_MODEL_CLIPS } from './enemy-clips.js';

/**
 * Clips an enemy def names that its model does not own. Empty for a model we
 * have no bake record of — an unknown model is a different problem, and
 * guessing "every clip is missing" would bury the real one.
 */
export const missingClips = (modelRef: string, clips: readonly string[]): readonly string[] => {
  const owned = ENEMY_MODEL_CLIPS[modelRef];
  if (!owned || owned.length === 0) return [];
  return [...new Set(clips.filter((clip) => !owned.includes(clip)))];
};
