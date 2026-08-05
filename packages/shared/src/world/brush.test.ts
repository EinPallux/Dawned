/**
 * Brush math is what the map editor writes the world with — and what a
 * server-side generator re-applies. These pin the properties the editor's feel
 * depends on, and the ones a seam would hide behind.
 */

import { describe, expect, it } from 'vitest';
import {
  BrushFalloff,
  BrushKind,
  applyBrushToChunk,
  applySplatToChunk,
  baseSplat,
  chunksTouchedBy,
  falloffAt,
  paintSplatTexel,
  readSplat,
  vertexWorld,
  type BrushStroke,
} from './brush.js';
import { CHUNK_VERTS, CHUNK_SIZE_M, WORLD_ORIGIN_M } from './map.js';
import { SPLAT_LAYER_COUNT, SPLAT_MAP_SIZE } from './chunk-codec.js';

const flat = (height = 0): Float32Array => new Float32Array(CHUNK_VERTS * CHUNK_VERTS).fill(height);

const stroke = (over: Partial<BrushStroke> = {}): BrushStroke => ({
  kind: BrushKind.Raise,
  x: WORLD_ORIGIN_M + CHUNK_SIZE_M / 2,
  z: WORLD_ORIGIN_M + CHUNK_SIZE_M / 2,
  radius: 8,
  strength: 4,
  falloff: BrushFalloff.Smooth,
  dt: 0.25,
  invert: false,
  target: 0,
  ...over,
});

describe('falloff curves', () => {
  it('every curve is full at the centre and zero at the rim', () => {
    for (const falloff of [
      BrushFalloff.Smooth,
      BrushFalloff.Linear,
      BrushFalloff.Sharp,
      BrushFalloff.Constant,
    ]) {
      expect(falloffAt(0, falloff)).toBeCloseTo(1, 6);
      expect(falloffAt(1, falloff)).toBe(0);
      expect(falloffAt(1.5, falloff)).toBe(0);
    }
  });

  it('smooth and linear never increase outward (no rim artefacts)', () => {
    for (const falloff of [BrushFalloff.Smooth, BrushFalloff.Linear, BrushFalloff.Sharp]) {
      let previous = Infinity;
      for (let t = 0; t <= 1; t += 0.05) {
        const w = falloffAt(t, falloff);
        expect(w).toBeLessThanOrEqual(previous + 1e-9);
        previous = w;
      }
    }
  });

  it('constant really is constant — mesas need a hard disc', () => {
    expect(falloffAt(0.99, BrushFalloff.Constant)).toBe(1);
  });
});

describe('sculpt brushes', () => {
  it('raise lifts the centre most and leaves the rim untouched', () => {
    const heights = flat();
    const changed = applyBrushToChunk(heights, 0, 0, stroke());
    expect(changed).toBeGreaterThan(0);
    const mid = Math.floor(CHUNK_VERTS / 2);
    expect(heights[mid * CHUNK_VERTS + mid]!).toBeCloseTo(1, 5); // 4 m/s × 0.25 s
    expect(heights[0]!).toBe(0); // corner is well outside an 8 m radius
  });

  it('ctrl-invert digs by the same amount it would have raised', () => {
    const up = flat();
    const down = flat();
    applyBrushToChunk(up, 0, 0, stroke());
    applyBrushToChunk(down, 0, 0, stroke({ invert: true }));
    for (let i = 0; i < up.length; i++) expect(down[i]!).toBeCloseTo(-up[i]!, 6);
  });

  it('a held stroke is frame-rate independent', () => {
    // Two half-steps must land where one full step does, or a fast machine
    // sculpts faster than a slow one.
    const once = flat();
    const twice = flat();
    applyBrushToChunk(once, 0, 0, stroke({ dt: 0.5 }));
    applyBrushToChunk(twice, 0, 0, stroke({ dt: 0.25 }));
    applyBrushToChunk(twice, 0, 0, stroke({ dt: 0.25 }));
    const mid = Math.floor(CHUNK_VERTS / 2);
    expect(twice[mid * CHUNK_VERTS + mid]!).toBeCloseTo(once[mid * CHUNK_VERTS + mid]!, 5);
  });

  it('flatten converges toward its target and never overshoots it', () => {
    const heights = flat(10);
    for (let i = 0; i < 40; i++) {
      applyBrushToChunk(
        heights,
        0,
        0,
        stroke({
          kind: BrushKind.Flatten,
          target: 3,
          strength: 0.5,
          falloff: BrushFalloff.Constant,
        }),
      );
    }
    const mid = Math.floor(CHUNK_VERTS / 2);
    const value = heights[mid * CHUNK_VERTS + mid]!;
    expect(value).toBeGreaterThanOrEqual(3);
    expect(value).toBeLessThan(3.01);
  });

  it('terrace snaps to multiples of its step', () => {
    const heights = flat();
    for (let i = 0; i < CHUNK_VERTS * CHUNK_VERTS; i++) heights[i] = 4.3;
    for (let i = 0; i < 60; i++) {
      applyBrushToChunk(
        heights,
        0,
        0,
        stroke({
          kind: BrushKind.Terrace,
          target: 2,
          strength: 0.6,
          falloff: BrushFalloff.Constant,
        }),
      );
    }
    const mid = Math.floor(CHUNK_VERTS / 2);
    expect(heights[mid * CHUNK_VERTS + mid]!).toBeCloseTo(4, 2);
  });

  it('smooth pulls a spike down toward its neighbours', () => {
    const heights = flat();
    const mid = Math.floor(CHUNK_VERTS / 2);
    heights[mid * CHUNK_VERTS + mid] = 20;
    const sample = (x: number, z: number): number => {
      const ix = Math.round((x - WORLD_ORIGIN_M) / (CHUNK_SIZE_M / (CHUNK_VERTS - 1)));
      const iz = Math.round((z - WORLD_ORIGIN_M) / (CHUNK_SIZE_M / (CHUNK_VERTS - 1)));
      if (ix < 0 || iz < 0 || ix >= CHUNK_VERTS || iz >= CHUNK_VERTS) return 0;
      return heights[iz * CHUNK_VERTS + ix]!;
    };
    applyBrushToChunk(
      heights,
      0,
      0,
      stroke({ kind: BrushKind.Smooth, strength: 1, dt: 0.5 }),
      sample,
    );
    expect(heights[mid * CHUNK_VERTS + mid]!).toBeLessThan(20);
    expect(heights[mid * CHUNK_VERTS + mid]!).toBeGreaterThan(0);
  });

  it('reports zero changes when the stroke misses the chunk entirely', () => {
    const heights = flat();
    const changed = applyBrushToChunk(heights, 0, 0, stroke({ x: 5000, z: 5000 }));
    expect(changed).toBe(0);
  });
});

describe('which chunks a stroke touches', () => {
  it('includes every chunk whose vertices fall inside the disc', () => {
    // Sit exactly on the seam between chunk (0,0) and (1,0): BOTH own a copy of
    // that vertex row, and writing only one opens a visible crack.
    const seamX = WORLD_ORIGIN_M + CHUNK_SIZE_M;
    const touched = chunksTouchedBy(seamX, WORLD_ORIGIN_M + CHUNK_SIZE_M / 2, 6);
    const keys = touched.map((c) => `${c.cx},${c.cy}`);
    expect(keys).toContain('0,0');
    expect(keys).toContain('1,0');
  });

  it('clips to the world instead of returning chunks that do not exist', () => {
    const touched = chunksTouchedBy(WORLD_ORIGIN_M, WORLD_ORIGIN_M, 40);
    expect(touched.every((c) => c.cx >= 0 && c.cy >= 0)).toBe(true);
  });

  it('a seam vertex has the same world position from either chunk', () => {
    const fromLeft = vertexWorld(0, 0, CHUNK_VERTS - 1, 3);
    const fromRight = vertexWorld(1, 0, 0, 3);
    expect(fromRight.x).toBeCloseTo(fromLeft.x, 9);
    expect(fromRight.z).toBeCloseTo(fromLeft.z, 9);
  });
});

describe('splat painting', () => {
  it('a fresh chunk is one layer at full weight', () => {
    const splat = baseSplat(0);
    expect(readSplat(splat, 0, 0)).toBe(255);
    for (let layer = 1; layer < SPLAT_LAYER_COUNT; layer++) {
      expect(readSplat(splat, 0, layer)).toBe(0);
    }
  });

  it('every texel always sums to 255 — the shader divides by the sum', () => {
    const splat = baseSplat(0);
    for (const [layer, weight] of [
      [1, 0.4],
      [3, 0.9],
      [7, 0.2],
      [2, 1],
    ] as const) {
      paintSplatTexel(splat, 5, layer, weight);
      let sum = 0;
      for (let i = 0; i < SPLAT_LAYER_COUNT; i++) sum += readSplat(splat, 5, i);
      expect(sum).toBe(255);
    }
  });

  it('painting to full strength really reaches 255', () => {
    const splat = baseSplat(0);
    paintSplatTexel(splat, 9, 4, 1);
    expect(readSplat(splat, 9, 4)).toBe(255);
    expect(readSplat(splat, 9, 0)).toBe(0);
  });

  it('slope and height masks refuse texels outside the band', () => {
    const splat = baseSplat(0);
    const painted = applySplatToChunk(
      splat,
      0,
      0,
      {
        x: WORLD_ORIGIN_M + CHUNK_SIZE_M / 2,
        z: WORLD_ORIGIN_M + CHUNK_SIZE_M / 2,
        radius: 20,
        strength: 1,
        falloff: BrushFalloff.Constant,
        layer: 2,
        dt: 0.25,
        slopeMin: 40,
        slopeMax: 90,
        heightMin: -100,
        heightMax: 100,
      },
      () => ({ height: 5, slopeDeg: 10 }), // flat ground: outside the 40°+ band
    );
    expect(painted).toBe(0);
    expect(readSplat(splat, 0, 2)).toBe(0);
  });

  it('paints where the mask allows', () => {
    const splat = baseSplat(0);
    const painted = applySplatToChunk(
      splat,
      0,
      0,
      {
        x: WORLD_ORIGIN_M + CHUNK_SIZE_M / 2,
        z: WORLD_ORIGIN_M + CHUNK_SIZE_M / 2,
        radius: 20,
        strength: 1,
        falloff: BrushFalloff.Constant,
        layer: 2,
        dt: 0.25,
        slopeMin: 0,
        slopeMax: 90,
        heightMin: -100,
        heightMax: 100,
      },
      () => ({ height: 5, slopeDeg: 55 }),
    );
    expect(painted).toBeGreaterThan(0);
    const centre = (SPLAT_MAP_SIZE / 2) * SPLAT_MAP_SIZE + SPLAT_MAP_SIZE / 2;
    expect(readSplat(splat, centre, 2)).toBeGreaterThan(0);
  });
});
