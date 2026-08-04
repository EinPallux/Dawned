/**
 * Which animation clips each baked enemy model actually HAS.
 *
 * This is a fact about the pipeline's output, not a rendering decision: the
 * client's logical mapping (idle → `Flying_Idle` for a floater) stays in the
 * client, but "does `enemies_mushnub` own a clip called Punch" is one answer
 * both repos need — the panel to refuse an ability that would animate nothing,
 * the game to know what it can play.
 *
 * It matters because the Quaternius bundle rigs its models in three families
 * with NON-interchangeable names: walkers attack with `Bite_Front`, floaters
 * with `Headbutt`/`Punch`, humanoids with `Punch`/`Weapon`, and the walkers
 * even spell the hit react differently (`HitRecieve`). Naming a clip the rig
 * does not have is silent: the swing still lands, it just plays nothing. That
 * shipped once — the P5 Spore Lobber's panic swat asked a mushnub for `Punch`.
 *
 * REGENERATE after baking new enemy models: read each glTF's animation list
 * (`assets_baked/enemies/*.glb`, names are `CharacterArmature|<clip>`) rather
 * than editing by hand — a guessed entry defeats the whole point.
 */
export const ENEMY_MODEL_CLIPS: Record<string, readonly string[]> = {
  enemies_armabee: [
    'Death',
    'Fast_Flying',
    'Flying_Idle',
    'Headbutt',
    'HitReact',
    'No',
    'Punch',
    'Yes',
  ],
  enemies_armabee_evolved: [
    'Death',
    'Fast_Flying',
    'Flying_Idle',
    'Headbutt',
    'HitReact',
    'No',
    'Punch',
    'Yes',
  ],
  enemies_cat: ['Bite_Front', 'Dance', 'Death', 'HitRecieve', 'Idle', 'Jump', 'No', 'Walk', 'Yes'],
  enemies_frog: [
    'Death',
    'Duck',
    'HitReact',
    'Idle',
    'Jump',
    'Jump_Idle',
    'Jump_Land',
    'No',
    'Punch',
    'Run',
    'Walk',
    'Wave',
    'Weapon',
    'Yes',
  ],
  enemies_ghost: [
    'Death',
    'Fast_Flying',
    'Flying_Idle',
    'Headbutt',
    'HitReact',
    'No',
    'Punch',
    'Yes',
  ],
  enemies_glub: [
    'Death',
    'Fast_Flying',
    'Flying_Idle',
    'Headbutt',
    'HitReact',
    'No',
    'Punch',
    'Yes',
  ],
  enemies_glub_evolved: [
    'Death',
    'Fast_Flying',
    'Flying_Idle',
    'Headbutt',
    'HitReact',
    'No',
    'Punch',
    'Yes',
  ],
  enemies_green_blob: [
    'Bite_Front',
    'Dance',
    'Death',
    'HitRecieve',
    'Idle',
    'Jump',
    'No',
    'Walk',
    'Yes',
  ],
  enemies_mushnub: [
    'Bite_Front',
    'Dance',
    'Death',
    'HitRecieve',
    'Idle',
    'Jump',
    'No',
    'Walk',
    'Yes',
  ],
  enemies_mushnub_evolved: [
    'Bite_Front',
    'Dance',
    'Death',
    'HitRecieve',
    'Idle',
    'Jump',
    'No',
    'Walk',
    'Yes',
  ],
  enemies_mushroom_king: [
    'Death',
    'Duck',
    'HitReact',
    'Idle',
    'Jump',
    'Jump_Idle',
    'Jump_Land',
    'No',
    'Punch',
    'Run',
    'Walk',
    'Wave',
    'Weapon',
    'Yes',
  ],
  enemies_orc: [
    'Death',
    'Duck',
    'HitReact',
    'Idle',
    'Jump',
    'Jump_Idle',
    'Jump_Land',
    'No',
    'Punch',
    'Run',
    'Walk',
    'Wave',
    'Weapon',
    'Yes',
  ],
  enemies_pigeon: [
    'Bite_Front',
    'Dance',
    'Death',
    'HitRecieve',
    'Idle',
    'Jump',
    'No',
    'Walk',
    'Yes',
  ],
  enemies_pink_blob: [
    'Bite_Front',
    'Dance',
    'Death',
    'HitRecieve',
    'Idle',
    'Jump',
    'No',
    'Walk',
    'Yes',
  ],
  enemies_skeleton_minion: [],
  enemies_wizard: [
    'Bite_Front',
    'Dance',
    'Death',
    'HitRecieve',
    'Idle',
    'Jump',
    'No',
    'Walk',
    'Yes',
  ],
};

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
