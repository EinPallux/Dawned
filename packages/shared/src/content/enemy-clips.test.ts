import { describe, expect, it } from 'vitest';

import { ENEMY_MODEL_CLIPS } from './enemy-clips.js';

/**
 * `enemy-clips.ts` is generated from the baked models by `pnpm assets:clips`.
 * These do not re-check what a rig owns — the glTF is the only thing that can
 * answer that, and re-listing it here by hand is the mistake the generator
 * exists to remove. They check the SHAPE the publish rail depends on.
 */
describe('the enemy clip registry', () => {
  it('covers every baked enemy model', () => {
    // 39 after P12-C. A number here is a tripwire: if a bake adds a model and
    // nobody re-runs the generator, the panel would let an ability name any
    // clip at all for it, because an absent model has no list to check against.
    expect(Object.keys(ENEMY_MODEL_CLIPS).length).toBe(39);
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
   * The four KayKit skeletons bake with NO clips at all — the pack ships its
   * meshes and its animations in different files
   * (`Animations/gltf/Rig_Medium/*.glb`), the way our own player rigs are
   * composed, and the enemy pipeline bakes one model per file. Until a merge
   * step exists they can stand and nothing else, so no Emberwood enemy may be
   * authored onto one.
   *
   * Listed BY NAME rather than skipped by a rule, so the list shrinks as they
   * are fixed instead of the check being softened. Recorded in
   * NPCS_ENEMIES.md §4.1 and ASSET_PIPELINE.md.
   */
  const CLIPLESS = [
    'enemies_skeleton_minion',
    'enemies_skeleton_rogue',
    'enemies_skeleton_mage',
    'enemies_skeleton_warrior',
  ];

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
    // were found.
    for (const [id, clips] of Object.entries(ENEMY_MODEL_CLIPS)) {
      if (CLIPLESS.includes(id)) continue;
      expect(
        clips.some((clip) => /idle/i.test(clip)),
        `${id} has no idle clip`,
      ).toBe(true);
      expect(clips.includes('Death'), `${id} has no Death clip`).toBe(true);
    }
  });

  it('has no duplicate clip names within a model', () => {
    for (const [id, clips] of Object.entries(ENEMY_MODEL_CLIPS)) {
      expect(new Set(clips).size, `${id} lists a clip twice`).toBe(clips.length);
    }
  });
});
