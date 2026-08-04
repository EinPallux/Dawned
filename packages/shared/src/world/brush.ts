/**
 * Terrain brush math (A2 map editor).
 *
 * Lives in shared, not in the editor, for the same reason every formula does:
 * the editor applies a stroke in the browser and the bake re-reads the result,
 * and a generator on the server applies the SAME functions to seed a landmass.
 * One definition of "what a 12 m smooth-falloff raise does to a height field"
 * means the preview ring on screen is the ground you get.
 *
 * All brushes operate on a chunk's 65×65 height grid in world space; the caller
 * decides which chunks a stroke touches (`chunksTouchedBy`).
 */

import { CHUNK_SIZE_M, CHUNK_VERTS, WORLD_CHUNKS, WORLD_ORIGIN_M } from './map.js';
import { SPLAT_LAYER_COUNT, SPLAT_MAP_SIZE } from './chunk-codec.js';

/** How brush strength decays from centre to rim. */
export const BrushFalloff = {
  /** Cosine shoulder — the default; blends without a visible rim. */
  Smooth: 'smooth',
  /** Straight ramp — predictable slopes, good for ridges. */
  Linear: 'linear',
  /** Nearly flat then a fast edge — carves steps and plateaus. */
  Sharp: 'sharp',
  /** No decay at all — the whole disc moves together (walls, mesas). */
  Constant: 'constant',
} as const;
export type BrushFalloff = (typeof BrushFalloff)[keyof typeof BrushFalloff];

export const BRUSH_FALLOFFS: readonly BrushFalloff[] = [
  BrushFalloff.Smooth,
  BrushFalloff.Linear,
  BrushFalloff.Sharp,
  BrushFalloff.Constant,
];

export const BrushKind = {
  Raise: 'raise',
  Smooth: 'smooth',
  Flatten: 'flatten',
  SetHeight: 'set_height',
  Terrace: 'terrace',
  Noise: 'noise',
} as const;
export type BrushKind = (typeof BrushKind)[keyof typeof BrushKind];

export interface BrushStroke {
  kind: BrushKind;
  /** World-space centre. */
  x: number;
  z: number;
  /** Metres. */
  radius: number;
  /** Metres per second of held brush for Raise; 0–1 weight for the others. */
  strength: number;
  falloff: BrushFalloff;
  /** Seconds this dab represents — keeps a stroke frame-rate independent. */
  dt: number;
  /** Ctrl-held: Raise digs, Terrace inverts, Noise subtracts. */
  invert: boolean;
  /** `Flatten`/`SetHeight` target height; `Terrace` step size. */
  target: number;
}

/** Falloff weight at normalised distance t (0 = centre, 1 = rim). */
export const falloffAt = (t: number, falloff: BrushFalloff): number => {
  if (t >= 1) return 0;
  const clamped = t < 0 ? 0 : t;
  switch (falloff) {
    case BrushFalloff.Constant:
      return 1;
    case BrushFalloff.Linear:
      return 1 - clamped;
    case BrushFalloff.Sharp:
      // Flat core to ~60 %, then a fast shoulder.
      return clamped < 0.6 ? 1 : 1 - (clamped - 0.6) / 0.4;
    case BrushFalloff.Smooth:
    default:
      return 0.5 + 0.5 * Math.cos(Math.PI * clamped);
  }
};

/** World position of a chunk's height sample (ix, iz). */
export const vertexWorld = (
  cx: number,
  cy: number,
  ix: number,
  iz: number,
): { x: number; z: number } => ({
  x: WORLD_ORIGIN_M + cx * CHUNK_SIZE_M + (ix * CHUNK_SIZE_M) / (CHUNK_VERTS - 1),
  z: WORLD_ORIGIN_M + cy * CHUNK_SIZE_M + (iz * CHUNK_SIZE_M) / (CHUNK_VERTS - 1),
});

/**
 * Which chunks a stroke can reach. Includes one extra ring: chunk edges SHARE
 * their vertex row with the neighbour, so a stroke that clips an edge must
 * write both copies or a seam opens where the two disagree.
 */
export const chunksTouchedBy = (
  x: number,
  z: number,
  radius: number,
): { cx: number; cy: number }[] => {
  const min = (v: number) => Math.floor((v - radius - WORLD_ORIGIN_M) / CHUNK_SIZE_M);
  const max = (v: number) => Math.floor((v + radius - WORLD_ORIGIN_M) / CHUNK_SIZE_M);
  const out: { cx: number; cy: number }[] = [];
  for (let cy = min(z); cy <= max(z); cy++) {
    for (let cx = min(x); cx <= max(x); cx++) {
      if (cx < 0 || cy < 0 || cx >= WORLD_CHUNKS || cy >= WORLD_CHUNKS) continue;
      out.push({ cx, cy });
    }
  }
  return out;
};

/** Deterministic value noise for the Noise brush — same on both sides. */
const noise2 = (x: number, z: number): number => {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
};
const smoothNoise = (x: number, z: number): number => {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = noise2(x0, z0);
  const b = noise2(x0 + 1, z0);
  const c = noise2(x0, z0 + 1);
  const d = noise2(x0 + 1, z0 + 1);
  return (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
};

/**
 * Apply one dab to one chunk's heights, in place. Returns how many samples
 * changed — 0 means the stroke missed and the caller can skip the chunk's
 * autosave entirely, which is what keeps a fast brush from writing the whole
 * map every frame.
 *
 * `neighbourHeight` reads a height at an arbitrary world point (for Smooth,
 * which averages across chunk borders); it may return null outside the map.
 */
export const applyBrushToChunk = (
  heights: Float32Array,
  cx: number,
  cy: number,
  stroke: BrushStroke,
  neighbourHeight?: (x: number, z: number) => number | null,
): number => {
  const r2 = stroke.radius * stroke.radius;
  let changed = 0;
  // Raise moves metres per second; the weighted brushes take a 0–1 amount and
  // are damped by dt so a held stroke converges instead of snapping.
  const amount = stroke.kind === BrushKind.Raise ? stroke.strength * stroke.dt : stroke.strength;
  const blend = Math.min(1, stroke.strength * stroke.dt * 6);
  for (let iz = 0; iz < CHUNK_VERTS; iz++) {
    for (let ix = 0; ix < CHUNK_VERTS; ix++) {
      const { x, z } = vertexWorld(cx, cy, ix, iz);
      const dx = x - stroke.x;
      const dz = z - stroke.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > r2) continue;
      const w = falloffAt(Math.sqrt(distSq) / stroke.radius, stroke.falloff);
      if (w <= 0) continue;
      const index = iz * CHUNK_VERTS + ix;
      const before = heights[index]!;
      let next = before;
      switch (stroke.kind) {
        case BrushKind.Raise:
          next = before + (stroke.invert ? -amount : amount) * w;
          break;
        case BrushKind.Smooth: {
          // Average the 3×3 world neighbourhood a metre out, so smoothing works
          // identically across a chunk seam.
          const step = CHUNK_SIZE_M / (CHUNK_VERTS - 1);
          let sum = 0;
          let n = 0;
          for (let oz = -1; oz <= 1; oz++) {
            for (let ox = -1; ox <= 1; ox++) {
              const h = neighbourHeight?.(x + ox * step, z + oz * step);
              if (h === null || h === undefined) continue;
              sum += h;
              n++;
            }
          }
          if (n === 0) break;
          next = before + (sum / n - before) * w * blend;
          break;
        }
        case BrushKind.Flatten:
        case BrushKind.SetHeight:
          next = before + (stroke.target - before) * w * blend;
          break;
        case BrushKind.Terrace: {
          const step = Math.max(0.25, stroke.target);
          const stepped = Math.round(before / step) * step;
          next = before + (stepped - before) * w * blend;
          break;
        }
        case BrushKind.Noise: {
          const n = smoothNoise(x * 0.35, z * 0.35) * 2 - 1;
          next = before + n * (stroke.invert ? -amount : amount) * w;
          break;
        }
      }
      if (next !== before) {
        heights[index] = next;
        changed++;
      }
    }
  }
  return changed;
};

// ---------------------------------------------------------------------------
// Splat painting
// ---------------------------------------------------------------------------

/** World position of a chunk's splat texel (ix, iz) — texel CENTRES. */
export const splatTexelWorld = (
  cx: number,
  cy: number,
  ix: number,
  iz: number,
): { x: number; z: number } => ({
  x: WORLD_ORIGIN_M + cx * CHUNK_SIZE_M + ((ix + 0.5) * CHUNK_SIZE_M) / SPLAT_MAP_SIZE,
  z: WORLD_ORIGIN_M + cy * CHUNK_SIZE_M + ((iz + 0.5) * CHUNK_SIZE_M) / SPLAT_MAP_SIZE,
});

/** Read one layer weight (0–255) out of the packed two-RGBA splat buffer. */
export const readSplat = (splat: Uint8Array, texel: number, layer: number): number =>
  splat[(layer < 4 ? 0 : SPLAT_MAP_SIZE * SPLAT_MAP_SIZE * 4) + texel * 4 + (layer % 4)] ?? 0;

const writeSplatRaw = (splat: Uint8Array, texel: number, layer: number, value: number): void => {
  splat[(layer < 4 ? 0 : SPLAT_MAP_SIZE * SPLAT_MAP_SIZE * 4) + texel * 4 + (layer % 4)] = value;
};

/**
 * Push one texel toward `layer` by `weight` (0–1) and renormalise the other
 * seven so the eight always sum to 255. Renormalising is not cosmetic: the
 * shader divides by the sum, so an unnormalised texel silently changes every
 * other layer's apparent strength.
 */
export const paintSplatTexel = (
  splat: Uint8Array,
  texel: number,
  layer: number,
  weight: number,
): void => {
  const current: number[] = [];
  for (let i = 0; i < SPLAT_LAYER_COUNT; i++) current.push(readSplat(splat, texel, i));
  const w = Math.max(0, Math.min(1, weight));
  const target = current[layer]! + (255 - current[layer]!) * w;
  const others = current.reduce((sum, v, i) => (i === layer ? sum : sum + v), 0);
  const room = 255 - target;
  for (let i = 0; i < SPLAT_LAYER_COUNT; i++) {
    if (i === layer) {
      writeSplatRaw(splat, texel, i, Math.round(target));
    } else {
      // Scale the rest into whatever the painted layer left them.
      writeSplatRaw(splat, texel, i, others > 0 ? Math.round((current[i]! / others) * room) : 0);
    }
  }
  // Rounding can leave the sum a point or two off; give the slack to the
  // painted layer so a full-strength dab really reads as 255.
  let sum = 0;
  for (let i = 0; i < SPLAT_LAYER_COUNT; i++) sum += readSplat(splat, texel, i);
  if (sum !== 255) {
    writeSplatRaw(
      splat,
      texel,
      layer,
      Math.max(0, Math.min(255, readSplat(splat, texel, layer) + (255 - sum))),
    );
  }
};

/**
 * Set a texel to EXACTLY one layer at full weight.
 *
 * Auto-splat and the "solo layer" tool want a hard assignment rather than a
 * blend, and doing it by hand means touching eight bytes with the sum-to-255
 * invariant in your head. Exposing this instead of the raw writer keeps the
 * invariant impossible to break from outside.
 */
export const setSplatTexel = (splat: Uint8Array, texel: number, layer: number): void => {
  for (let i = 0; i < SPLAT_LAYER_COUNT; i++) {
    writeSplatRaw(splat, texel, i, i === layer ? 255 : 0);
  }
};

/** A splat dab, optionally masked by the terrain it lands on. */
export interface SplatStroke {
  x: number;
  z: number;
  radius: number;
  /** 0–1 per dab. */
  strength: number;
  falloff: BrushFalloff;
  layer: number;
  dt: number;
  /** Only paint where the slope is inside this band (degrees). */
  slopeMin: number;
  slopeMax: number;
  /** Only paint where the height is inside this band (metres). */
  heightMin: number;
  heightMax: number;
}

/**
 * Apply a splat dab to one chunk. `probe` answers height+slope at a world point
 * so the mask bands ("only on cliffs", "only above the tree line") are evaluated
 * against the same terrain the shader will render.
 */
export const applySplatToChunk = (
  splat: Uint8Array,
  cx: number,
  cy: number,
  stroke: SplatStroke,
  probe: (x: number, z: number) => { height: number; slopeDeg: number } | null,
): number => {
  const r2 = stroke.radius * stroke.radius;
  let changed = 0;
  for (let iz = 0; iz < SPLAT_MAP_SIZE; iz++) {
    for (let ix = 0; ix < SPLAT_MAP_SIZE; ix++) {
      const { x, z } = splatTexelWorld(cx, cy, ix, iz);
      const dx = x - stroke.x;
      const dz = z - stroke.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > r2) continue;
      const w = falloffAt(Math.sqrt(distSq) / stroke.radius, stroke.falloff);
      if (w <= 0) continue;
      const ground = probe(x, z);
      if (!ground) continue;
      if (ground.slopeDeg < stroke.slopeMin || ground.slopeDeg > stroke.slopeMax) continue;
      if (ground.height < stroke.heightMin || ground.height > stroke.heightMax) continue;
      paintSplatTexel(
        splat,
        iz * SPLAT_MAP_SIZE + ix,
        stroke.layer,
        w * stroke.strength * stroke.dt * 4,
      );
      changed++;
    }
  }
  return changed;
};

/** A fresh chunk's splat: layer 0 at full weight, everything else empty. */
export const baseSplat = (layer = 0): Uint8Array => {
  const splat = new Uint8Array(2 * SPLAT_MAP_SIZE * SPLAT_MAP_SIZE * 4);
  for (let texel = 0; texel < SPLAT_MAP_SIZE * SPLAT_MAP_SIZE; texel++) {
    writeSplatRaw(splat, texel, layer, 255);
  }
  return splat;
};
