/**
 * World-population content: the rules the map editor writes against and the
 * bake re-checks. Scatter determinism is the load-bearing one — the editor
 * PREVIEWS a forest and the bake EMITS it from the same density grid, so if
 * these two ever disagree the owner ships a different forest than they painted.
 */

import { describe, expect, it } from 'vitest';
import {
  SCATTER_GRID,
  interactableSchema,
  placementsFileSchema,
  poiSchema,
  propPlacementSchema,
  resolveScatter,
  scatterSetSchema,
  validateInteractable,
  type Interactable,
} from './placements.js';

const set = scatterSetSchema.parse({
  id: 'scatter_weald_cover',
  name: 'Weald ground cover',
  entries: [
    { modelRef: 'nature_grass_a', weight: 3 },
    { modelRef: 'nature_fern_a', weight: 2 },
    { modelRef: 'nature_mushroom_a', weight: 0.5 },
  ],
  densityPer100m2: 60,
  maxSlopeDeg: 35,
  minHeight: 0.2,
});

const fullDensity = new Array<number>(SCATTER_GRID * SCATTER_GRID).fill(255);
const flatGround = () => ({ height: 5, slopeDeg: 4 });

describe('scatter resolution', () => {
  it('is deterministic — the preview and the bake must agree exactly', () => {
    const a = resolveScatter(set, 3, 4, fullDensity, 0, 0, flatGround);
    const b = resolveScatter(set, 3, 4, fullDensity, 0, 0, flatGround);
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  it('places different instances in different chunks (no tiling pattern)', () => {
    const a = resolveScatter(set, 3, 4, fullDensity, 0, 0, flatGround);
    const b = resolveScatter(set, 5, 4, fullDensity, 0, 0, flatGround);
    expect(a.map((s) => s.rotation)).not.toEqual(b.map((s) => s.rotation));
  });

  it('scales the count with painted density', () => {
    const half = new Array<number>(SCATTER_GRID * SCATTER_GRID).fill(128);
    const dense = resolveScatter(set, 1, 1, fullDensity, 0, 0, flatGround);
    const light = resolveScatter(set, 1, 1, half, 0, 0, flatGround);
    expect(light.length).toBeLessThan(dense.length);
    expect(light.length).toBeGreaterThan(dense.length * 0.3);
  });

  it('a light dusting still places something', () => {
    // 8/255 density over a 4 m cell is well under one instance per cell. A
    // naive floor() would place nothing at all and the brush would feel dead.
    const faint = new Array<number>(SCATTER_GRID * SCATTER_GRID).fill(8);
    expect(resolveScatter(set, 2, 2, faint, 0, 0, flatGround).length).toBeGreaterThan(0);
  });

  it('respects the set slope and height limits', () => {
    const cliff = resolveScatter(set, 1, 1, fullDensity, 0, 0, () => ({
      height: 5,
      slopeDeg: 70,
    }));
    expect(cliff).toEqual([]);
    const underwater = resolveScatter(set, 1, 1, fullDensity, 0, 0, () => ({
      height: -3,
      slopeDeg: 2,
    }));
    expect(underwater).toEqual([]);
  });

  it('skips points with no terrain rather than planting them at zero', () => {
    expect(resolveScatter(set, 1, 1, fullDensity, 0, 0, () => null)).toEqual([]);
  });

  it('respects entry weights over a large sample', () => {
    const counts: Record<string, number> = {};
    for (let cx = 0; cx < 20; cx++) {
      for (const s of resolveScatter(set, cx, 0, fullDensity, 0, 0, flatGround)) {
        counts[s.modelRef] = (counts[s.modelRef] ?? 0) + 1;
      }
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(500);
    // 3 : 2 : 0.5 out of 5.5 → 55 % / 36 % / 9 %.
    expect(counts.nature_grass_a! / total).toBeGreaterThan(0.45);
    expect(counts.nature_grass_a! / total).toBeLessThan(0.65);
    expect(counts.nature_mushroom_a! / total).toBeLessThan(0.18);
  });

  it('places every instance inside the cell it was painted in', () => {
    const one = new Array<number>(SCATTER_GRID * SCATTER_GRID).fill(0);
    one[0] = 255;
    const samples = resolveScatter(set, 0, 0, one, 100, 200, flatGround);
    for (const s of samples) {
      expect(s.x).toBeGreaterThanOrEqual(100);
      expect(s.x).toBeLessThan(104);
      expect(s.z).toBeGreaterThanOrEqual(200);
      expect(s.z).toBeLessThan(204);
    }
  });
});

describe('interactable rules the flat schema cannot express', () => {
  const base = (over: Partial<Interactable>): Interactable =>
    interactableSchema.parse({
      id: 'thing_test',
      kind: 'chest',
      name: 'Test',
      x: 0,
      z: 0,
      modelRef: 'props_chest_a',
      ...over,
    });

  it('a chest without a loot table is a bug, not content', () => {
    expect(validateInteractable(base({ lootTableId: null }))).toHaveLength(1);
    expect(validateInteractable(base({ lootTableId: 'loot_weald_gear' }))).toEqual([]);
  });

  it('a portal needs somewhere to go', () => {
    expect(validateInteractable(base({ kind: 'portal', destX: null }))).toHaveLength(1);
    expect(validateInteractable(base({ kind: 'portal', destX: 10, destZ: 20 }))).toEqual([]);
  });

  it('a signpost with no text says nothing', () => {
    expect(validateInteractable(base({ kind: 'signpost', text: '  ' }))).toHaveLength(1);
    expect(validateInteractable(base({ kind: 'signpost', text: 'To Dawnhaven' }))).toEqual([]);
  });

  it('only shrines join the travel graph', () => {
    expect(validateInteractable(base({ kind: 'campfire', travelNode: true }))).toHaveLength(1);
    expect(validateInteractable(base({ kind: 'shrine', travelNode: true }))).toEqual([]);
  });
});

describe('schemas', () => {
  it('a prop only needs a model and a spot — the rest defaults', () => {
    const prop = propPlacementSchema.parse({
      id: 'prop_rock_1',
      modelRef: 'nature_rock_a',
      x: 12,
      z: -40,
    });
    expect(prop.scale).toBe(1);
    expect(prop.yOffset).toBe(0);
    expect(prop.solid).toBe(false);
  });

  it('refuses unknown fields so a typo cannot silently do nothing', () => {
    expect(() =>
      propPlacementSchema.parse({ id: 'prop_x', modelRef: 'm', x: 0, z: 0, rotaton: 1 }),
    ).toThrow();
  });

  it('a scatter set cannot have an inverted scale range', () => {
    expect(() =>
      scatterSetSchema.parse({
        id: 'scatter_bad',
        name: 'Bad',
        entries: [{ modelRef: 'm', scaleMin: 2, scaleMax: 1 }],
      }),
    ).toThrow();
  });

  it('the baked file round-trips through its schema', () => {
    const file = placementsFileSchema.parse({
      props: [{ id: 'prop_a', modelRef: 'nature_rock_a', x: 1, z: 2 }],
      scatterSets: [set],
      scatter: [{ cx: 1, cy: 2, setId: set.id, density: fullDensity }],
      pois: [poiSchema.parse({ id: 'poi_vista', name: 'Vista', kind: 'vista', x: 0, z: 0 })],
      interactables: [],
    });
    expect(placementsFileSchema.parse(JSON.parse(JSON.stringify(file)))).toEqual(file);
  });
});
