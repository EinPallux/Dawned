import { describe, expect, it } from 'vitest';

import { ENEMY_MODEL_CLIPS } from './enemy-clips.js';
import { missingClips } from './enemy-clip-check.js';

/**
 * `enemy-clips.ts` is generated from the baked models by `pnpm assets:clips`.
 * These do not re-check what a rig owns — the glTF is the only thing that can
 * answer that, and re-listing it here by hand is the mistake the generator
 * exists to remove. They check the SHAPE the publish rail depends on.
 */
describe('the enemy clip registry', () => {
  it('covers every baked enemy model', () => {
    // 40 after P12-C. A number here is a tripwire: if a bake adds a model and
    // nobody re-runs the generator, the panel would let an ability name any
    // clip at all for it, because an absent model has no list to check against.
    expect(Object.keys(ENEMY_MODEL_CLIPS).length).toBe(40);
  });

  it('names every model with the `enemies_` prefix content refers to', () => {
    for (const id of Object.keys(ENEMY_MODEL_CLIPS)) {
      expect(id).toMatch(/^enemies_[a-z0-9_]+$/);
    }
  });

  it('strips the exporter armature prefix', () => {
    // Clips arrive as `CharacterArmature|Idle`. A registry holding the prefixed
    // name would refuse every ability ever authored, since content names `Idle`.
    for (const clips of Object.values(ENEMY_MODEL_CLIPS)) {
      for (const clip of clips) expect(clip).not.toContain('|');
    }
  });

  /**
   * The four KayKit skeletons used to bake with NO clips at all — the pack
   * ships its meshes and its animations in different files
   * (`Animations/gltf/Rig_Medium/*.glb`), the way our own player rigs are
   * composed, and the enemy pipeline bakes one model per file. The pipeline's
   * `mergeClips` rule option stitches them back together (P12-C), so the list
   * is empty; it stays here BY NAME rather than as a rule, so a future pack
   * with the same split shows up as a failure instead of a soft skip.
   * Recorded in NPCS_ENEMIES.md §4.1 and ASSET_PIPELINE.md.
   */
  const CLIPLESS: string[] = [];

  it('knows exactly which rigs cannot animate yet', () => {
    const empty = Object.entries(ENEMY_MODEL_CLIPS)
      .filter(([, clips]) => clips.length === 0)
      .map(([id]) => id)
      .sort();
    expect(empty).toEqual([...CLIPLESS].sort());
  });

  it('gives every usable rig something to idle and die with', () => {
    // The two the runtime plays for EVERY enemy regardless of its kit. A rig
    // missing one is a model that cannot be used, and better found here than
    // as a corpse frozen mid-stride — which is exactly how the skeletons above
    // were found. KayKit suffixes its variants (`Death_A`), so match a prefix
    // rather than an exact name.
    for (const [id, clips] of Object.entries(ENEMY_MODEL_CLIPS)) {
      if (CLIPLESS.includes(id)) continue;
      expect(
        clips.some((clip) => /idle/i.test(clip)),
        `${id} has no idle clip`,
      ).toBe(true);
      expect(
        clips.some((clip) => /^death/i.test(clip)),
        `${id} has no Death clip`,
      ).toBe(true);
    }
  });

  it('has no duplicate clip names within a model', () => {
    for (const [id, clips] of Object.entries(ENEMY_MODEL_CLIPS)) {
      expect(new Set(clips).size, `${id} lists a clip twice`).toBe(clips.length);
    }
  });
});

/**
 * `missingClips` is the ONLY consumer of the registry in either repo — the
 * panel's publish cross-check calls it to refuse an ability that would animate
 * nothing. It used to live at the bottom of the generated file, and the first
 * `pnpm assets:clips` run deleted it: the game repo never calls it, so nothing
 * here went red, and the break only surfaced as a typecheck failure in the
 * OTHER repo. These exist so that the next deletion has somewhere to fail.
 */
describe('missingClips', () => {
  it('names the clips a model does not own', () => {
    // The P5 bug in one line: the Spore Lobber's panic swat asked a mushnub
    // rig for `Punch`, and the swing landed while animating nothing.
    expect(missingClips('enemies_mushnub', ['Bite_Front', 'Punch'])).toEqual(['Punch']);
  });

  it('is silent for a model with no bake record', () => {
    // "Every clip is missing" for an unknown model would bury the real
    // problem, which is that the model is not in the manifest at all.
    expect(missingClips('enemies_not_a_thing', ['Punch'])).toEqual([]);
  });

  it('accepts a clip the rig really has, on both packs', () => {
    expect(missingClips('enemies_mushnub', ['Bite_Front', 'Idle', 'Death'])).toEqual([]);
    // KayKit's names are suffixed and unprefixed — a check that assumed the
    // Quaternius shape would refuse every skeleton ability ever authored.
    expect(missingClips('enemies_skeleton_warrior', ['Running_A', 'Interact'])).toEqual([]);
  });
});
