/**
 * One manifest, two producers (P12-F).
 *
 * `assets:build` writes model entries from packs.json; `assets:icons` writes the
 * game-icons.net set fetched by slug. They share `assets_baked/manifest.json`,
 * and `build()` used to start from an empty asset map — so a plain
 * `pnpm assets:build` DELETED all 256 icon entries.
 *
 * Nothing failed when it did. The SVG files stayed on disk, the asset report
 * read the manifest and cheerfully reported the models it found, and
 * `pnpm check` went green. The symptom was every item, ability and resource
 * node in the game rendering a blank icon, with no line anywhere saying why —
 * and it survived this long only because the habitual order happens to be
 * build-then-icons. That is a trap, not a workflow.
 */

import { describe, expect, it } from 'vitest';
import { carryForeignAssets, FOREIGN_CATEGORIES } from './build.mjs';

const entry = (category) => ({ id: 'x', category, file: `assets_baked/${category}/x.glb` });

describe('a build keeps what another producer wrote', () => {
  it('carries icon entries across a model rebuild', () => {
    const kept = carryForeignAssets({
      icon_lorc__sword: entry('icons'),
      world_props_chest: entry('world/props'),
    });
    expect(Object.keys(kept)).toEqual(['icon_lorc__sword']);
  });

  it('drops every category this command re-produces itself', () => {
    // Models must NOT be carried: a rule removed from packs.json has to
    // disappear from the manifest, or a deleted asset lingers forever.
    const kept = carryForeignAssets({
      world_props_chest: entry('world/props'),
      enemies_glub: entry('enemies'),
      characters_body_a: entry('characters'),
    });
    expect(kept).toEqual({});
  });

  it('survives a missing or empty previous manifest', () => {
    expect(carryForeignAssets()).toEqual({});
    expect(carryForeignAssets({})).toEqual({});
    expect(carryForeignAssets({ broken: {} })).toEqual({});
  });

  it('names icons as the foreign category, so adding a producer is a decision', () => {
    // If a third producer ever writes into this manifest (audio, say), it has
    // to be added here on purpose rather than discovered by its output vanishing.
    expect([...FOREIGN_CATEGORIES]).toEqual(['icons']);
  });
});
