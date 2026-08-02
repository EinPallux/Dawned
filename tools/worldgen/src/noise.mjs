/**
 * Deterministic noise for worldgen — pure functions of (seed, coordinates).
 * No Math.random, no tables initialized at import time: identical inputs give
 * identical bytes on every machine, which is what makes the dev island a
 * committable, diffable artifact.
 */

/** 32-bit integer hash (xxhash-style avalanche) → [0, 1). */
export const hash2 = (seed, ix, iz) => {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ ix, 0x85ebca6b);
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h ^ iz, 0xc2b2ae35);
  h = (h ^ (h >>> 16)) | 0;
  return (h >>> 0) / 4294967296;
};

const smooth = (t) => t * t * (3 - 2 * t);

/** Value noise on a unit grid, bilinear with smoothstep fade. Output [0, 1). */
export const valueNoise2 = (seed, x, z) => {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fz = smooth(z - iz);
  const v00 = hash2(seed, ix, iz);
  const v10 = hash2(seed, ix + 1, iz);
  const v01 = hash2(seed, ix, iz + 1);
  const v11 = hash2(seed, ix + 1, iz + 1);
  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fz;
};

/** Fractal Brownian motion of `octaves` value-noise layers. Output ≈ [-1, 1]. */
export const fbm = (seed, x, z, octaves, lacunarity = 2, gain = 0.5) => {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += (valueNoise2(seed + i * 101, x * frequency, z * frequency) * 2 - 1) * amplitude;
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / norm;
};

/** Ridged fBm (sharp crests) — for the northern hills. Output [0, 1]. */
export const ridged = (seed, x, z, octaves) => {
  let amplitude = 0.5;
  let frequency = 1;
  let sum = 0;
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise2(seed + 977 + i * 131, x * frequency, z * frequency) * 2 - 1;
    sum += (1 - Math.abs(n)) * amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum;
};

export const smoothstep = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export const lerp = (a, b, t) => a + (b - a) * t;
