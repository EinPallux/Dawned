/**
 * Baked props are the size a person would expect (P12-F).
 *
 * These run against the REAL baked output, like `merge-clips.test.mjs` runs
 * against the real pack: the thing being asserted is that the bake produced
 * something a player can stand next to, and a fixture cannot say that.
 *
 * Why it exists: the Medieval Village Pack is authored at roughly 1/2.5 metre
 * scale, so its bonfire is 41 cm across as shipped. A `scale` rule corrects it,
 * and NOTHING would have noticed if that rule were dropped, mistyped or applied
 * twice — a 41 cm campfire and a 2.5 m one both bake fine, both pass the asset
 * report, and both look plausible in a screenshot with nothing beside them. You
 * find out by walking a 1.8 m character up to one.
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { worldSpaceBounds } from './model-size.mjs';
import { REPO_ROOT, MANIFEST_PATH } from './build.mjs';

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));

const sizeOf = async (id) => {
  const entry = manifest.assets[id];
  if (!entry) throw new Error(`${id} is not in the manifest — run \`pnpm assets:build\``);
  const bounds = worldSpaceBounds(await io.read(path.join(REPO_ROOT, entry.file)));
  if (!bounds) throw new Error(`${id} baked with no geometry`);
  return bounds.size;
};

/**
 * `[id, minMetres, maxMetres]` on the LARGEST dimension — a loose band on
 * purpose. This is not a feel test (the owner tunes feel in one pass at the
 * end); it is a "did the unit conversion happen" test, and the failure it
 * guards against is off by 2.5×, not by 10 %.
 */
const PROPS = [
  ['world_props_bonfire_lit', 0.6, 2.0], // a campfire you crouch beside
  ['world_props_well', 1.5, 4.0],
  ['world_props_marketstand_1', 1.5, 4.5],
  ['world_props_cart', 1.2, 3.5],
  ['world_props_barrel', 0.5, 1.8],
  ['world_props_shrine', 1.2, 4.0], // waist-to-overhead standing stone
  ['world_props_arch_gate', 2.5, 6.0], // you walk THROUGH it
  ['world_props_pointer_001', 1.2, 3.5], // readable at eye height
  ['world_props_chest', 0.6, 2.0],
];

describe('baked props are believable metres', () => {
  for (const [id, low, high] of PROPS) {
    it(`${id} is ${low}–${high} m on its longest side`, async () => {
      const size = await sizeOf(id);
      expect(Math.max(...size)).toBeGreaterThanOrEqual(low);
      expect(Math.max(...size)).toBeLessThanOrEqual(high);
    });
  }

  it('measures the node transform, not just the vertices', async () => {
    // The regression this whole module exists for. The shrine's geometry spans
    // about a centimetre and its node scales it to standing-stone height, so a
    // check that read POSITION accessors alone would report 0.01 m and pass a
    // band starting at 0. Reading > 1 m proves the transform is included.
    const [, height] = await sizeOf('world_props_shrine');
    expect(height).toBeGreaterThan(1);
  });

  it('lights the campfire — its flame material emits', async () => {
    const entry = manifest.assets['world_props_bonfire_lit'];
    const document = await io.read(path.join(REPO_ROOT, entry.file));
    const lit = document
      .getRoot()
      .listMaterials()
      .filter((material) => material.getEmissiveFactor().some((channel) => channel > 0));
    expect(lit.map((material) => material.getName())).toContain('Fire');
  });
});
