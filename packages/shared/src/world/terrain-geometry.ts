/**
 * Terrain chunk geometry, as plain typed arrays.
 *
 * The game client renders chunks and — from A2 — so does the map editor, in a
 * different repo with its own three.js. If each built its own vertices the
 * editor would eventually be showing a world that is not the one players walk
 * on, and the divergence would be invisible until someone published.
 *
 * So the geometry lives here: positions, per-vertex colors (the splat blend
 * with its jitter) and the index buffer, including the skirt ring. Neither side
 * owns the look; both wrap these arrays in a `BufferGeometry`. Nothing in this
 * file imports three — shared stays renderer-free, and the server can pull the
 * same module for the height maths without dragging WebGL types in.
 */

import { CHUNK_SIZE_M, CHUNK_VERTS } from './map.js';
import { SPLAT_MAP_SIZE, type MapChunk } from './chunk-codec.js';

/** How far the skirt ring drops below the chunk's edge, in metres. */
export const SKIRT_DEPTH = 4;

export interface ChunkGeometryData {
  /** (grid + skirt) × 3, chunk-local: x/z in [0, 64], y in world metres. */
  positions: Float32Array;
  /** (grid + skirt) × 3, linear RGB in [0, 1]. */
  colors: Float32Array;
  /** Triangle list, already trimmed to the used length. */
  indices: Uint32Array;
}

/**
 * Deterministic per-vertex jitter in [-1, 1] from WORLD grid coordinates.
 *
 * World-space, not chunk-local, so the pattern is continuous across a chunk
 * boundary — the same vertex on both sides of a seam gets the same jitter, and
 * the seam stays invisible.
 */
export const vertexJitter = (ix: number, iz: number): number => {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1;
};

/** Bilinear splat weight lookup for one layer at chunk-local metre coordinates. */
export const splatWeightAt = (splat: Uint8Array, layer: number, lx: number, lz: number): number => {
  const texel = CHUNK_SIZE_M / SPLAT_MAP_SIZE; // 2 m
  const sx = Math.min(Math.max(lx / texel - 0.5, 0), SPLAT_MAP_SIZE - 1.001);
  const sz = Math.min(Math.max(lz / texel - 0.5, 0), SPLAT_MAP_SIZE - 1.001);
  const ix = Math.floor(sx);
  const iz = Math.floor(sz);
  const fx = sx - ix;
  const fz = sz - iz;
  const mapOffset = layer >= 4 ? SPLAT_MAP_SIZE * SPLAT_MAP_SIZE * 4 : 0;
  const channel = layer & 3;
  const at = (x: number, z: number): number =>
    splat[mapOffset + (z * SPLAT_MAP_SIZE + Math.min(x, SPLAT_MAP_SIZE - 1)) * 4 + channel]!;
  const top = at(ix, iz) + (at(ix + 1, iz) - at(ix, iz)) * fx;
  const bottom = at(ix, iz + 1) + (at(ix + 1, iz + 1) - at(ix, iz + 1)) * fx;
  return top + (bottom - top) * fz;
};

/** Linear RGB per splat layer, in layer order. Supplied by the caller so the
 * palette stays one list (SPLAT_LAYERS) rather than a copy per renderer. */
export type LayerRgb = readonly (readonly [number, number, number])[];

/**
 * Build one chunk's render geometry.
 *
 * Positions are chunk-local (0…64 on x/z), so the caller places the mesh at the
 * chunk's min corner — that keeps float precision good 1 km from the origin.
 * `worldBaseX/Z` only feed the jitter hash, which must be world-continuous.
 */
export const buildChunkGeometryData = (
  chunk: MapChunk,
  layerRgb: LayerRgb,
  worldBaseX: number,
  worldBaseZ: number,
): ChunkGeometryData => {
  const verts = CHUNK_VERTS;
  const gridCount = verts * verts;
  const skirtCount = verts * 4;
  const positions = new Float32Array((gridCount + skirtCount) * 3);
  const colors = new Float32Array((gridCount + skirtCount) * 3);

  for (let iz = 0; iz < verts; iz++) {
    for (let ix = 0; ix < verts; ix++) {
      const i = iz * verts + ix;
      positions[i * 3] = ix;
      positions[i * 3 + 1] = chunk.heights[i]!;
      positions[i * 3 + 2] = iz;

      let r = 0;
      let g = 0;
      let b = 0;
      let total = 0;
      for (let layer = 0; layer < layerRgb.length; layer++) {
        const weight = splatWeightAt(chunk.splat, layer, ix, iz);
        if (weight <= 0) continue;
        const rgb = layerRgb[layer]!;
        total += weight;
        r += rgb[0] * weight;
        g += rgb[1] * weight;
        b += rgb[2] * weight;
      }
      // Renormalise (weights need not sum to 255) and jitter ±4% so a field of
      // one layer reads as terrain rather than billiard felt.
      const scale =
        (total > 0 ? 1 / total : 0) * (1 + vertexJitter(worldBaseX + ix, worldBaseZ + iz) * 0.04);
      colors[i * 3] = r * scale;
      colors[i * 3 + 1] = g * scale;
      colors[i * 3 + 2] = b * scale;
    }
  }

  const cells = verts - 1;
  const indices = new Uint32Array((cells * cells + cells * 4) * 6);
  let at = 0;
  for (let iz = 0; iz < cells; iz++) {
    for (let ix = 0; ix < cells; ix++) {
      const a = iz * verts + ix;
      const b = a + 1;
      const c = a + verts;
      const d = c + 1;
      indices[at++] = a;
      indices[at++] = c;
      indices[at++] = b;
      indices[at++] = b;
      indices[at++] = c;
      indices[at++] = d;
    }
  }

  // Skirts: copy each border vertex, drop it, stitch a quad strip per edge, so
  // the gap against a not-yet-loaded neighbour never shows as a crack.
  const edges: [number, (i: number) => number][] = [
    [0, (i) => i], // north row (iz = 0), left→right
    [1, (i) => (verts - 1) * verts + (verts - 1 - i)], // south row, right→left
    [2, (i) => (verts - 1 - i) * verts], // west column, bottom→top
    [3, (i) => i * verts + (verts - 1)], // east column, top→bottom
  ];
  for (const [edge, gridIndex] of edges) {
    const skirtBase = gridCount + edge * verts;
    for (let i = 0; i < verts; i++) {
      const src = gridIndex(i);
      const dst = skirtBase + i;
      positions[dst * 3] = positions[src * 3]!;
      positions[dst * 3 + 1] = positions[src * 3 + 1]! - SKIRT_DEPTH;
      positions[dst * 3 + 2] = positions[src * 3 + 2]!;
      colors[dst * 3] = colors[src * 3]!;
      colors[dst * 3 + 1] = colors[src * 3 + 1]!;
      colors[dst * 3 + 2] = colors[src * 3 + 2]!;
      if (i > 0) {
        const prevSrc = gridIndex(i - 1);
        indices[at++] = prevSrc;
        indices[at++] = dst - 1;
        indices[at++] = src;
        indices[at++] = src;
        indices[at++] = dst - 1;
        indices[at++] = dst;
      }
    }
  }

  return { positions, colors, indices: indices.subarray(0, at) };
};
