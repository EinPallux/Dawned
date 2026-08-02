/**
 * The dev island — a ~1 km starter isle centred on the world origin
 * (ROADMAP P2: "dev island authored via a temporary in-repo script"; the admin
 * map editor replaces this at A2/A3, writing the same chunk format).
 *
 * Everything here is a pure function of (seed, x, z) in world metres:
 * south (+z) is beach-and-meadow Dawnshore, the north-west rises into wooded
 * hills, the north-east into a stark ridge, and a small lake sits inland.
 * Sea level is y = 0.
 */

import { fbm, ridged, smoothstep, lerp, valueNoise2 } from './noise.mjs';

export const SEA_LEVEL = 0;
export const ISLAND_RADIUS = 480;
const COAST_WARP = 85;
const OCEAN_FLOOR = -8;

export const LAKE = { x: -150, z: -70, radius: 52, depth: 3.2 };

/** Warped island radius for a given direction — the coastline shape. */
const coastRadiusAt = (seed, angle) =>
  ISLAND_RADIUS +
  (valueNoise2(seed + 11, Math.cos(angle) * 2.3 + 10, Math.sin(angle) * 2.3 + 10) * 2 - 1) *
    COAST_WARP;

/** Signed distance-ish factor: 1 deep inside the island → 0 at coast → <0 at sea. */
const islandMask = (seed, x, z) => {
  const r = Math.hypot(x, z);
  const angle = Math.atan2(z, x);
  const coast = coastRadiusAt(seed, angle);
  return 1 - r / coast;
};

/** Terrain height in metres at a world position (before walkgrid/splat concerns). */
export const heightAt = (seed, x, z) => {
  const mask = islandMask(seed, x, z);

  // Open sea: fall away to the ocean floor over ~90 m beyond the coast.
  if (mask <= 0) {
    return lerp(SEA_LEVEL - 1.2, OCEAN_FLOOR, smoothstep(0, 0.18, -mask));
  }

  // Interior shaping.
  const inland = smoothstep(0, 0.24, mask); // 0 at coast → 1 well inland
  const meadow = 2 + fbm(seed + 23, x / 190, z / 190, 4) * 4.2; // stays above the surf
  const northness = smoothstep(80, -260, z); // 0 in the south → 1 in the north
  const hills = ridged(seed + 47, x / 260, z / 260, 4) * 28 * northness;
  const centerHill = smoothstep(210, 40, Math.hypot(x, z + 40)) * 7;

  let h = SEA_LEVEL + 0.4 + inland * (2.4 + meadow + centerHill) + inland * hills;

  // Beach shelf: pull low coastal ground toward a flat sand band (coast-hugging).
  const beach = smoothstep(0.1, 0.015, mask);
  h = lerp(h, 0.55, beach * smoothstep(4.5, 0.8, h));

  // The lake: a smooth bowl carved into the north-west meadow.
  const lakeDist = Math.hypot(x - LAKE.x, z - LAKE.z);
  const bowl = smoothstep(LAKE.radius, LAKE.radius * 0.35, lakeDist);
  h -= bowl * LAKE.depth;

  return h;
};

/** Water surface at a position: the sea, or the lake's own level. */
export const waterLevelAt = (seed, x, z) => {
  const lakeDist = Math.hypot(x - LAKE.x, z - LAKE.z);
  if (lakeDist < LAKE.radius + 8) return lakeLevel(seed);
  return SEA_LEVEL;
};

/** Lake surface height — just under the carved rim, stable per seed. */
export const lakeLevel = (seed) => {
  // Rim height = terrain at the lake edge before carving dominates; sample the
  // uncarved height by evaluating at a rim point (bowl ≈ 0 there).
  const rim = heightAt(seed, LAKE.x + LAKE.radius + 10, LAKE.z);
  return rim - 0.55;
};

// --- masks the splat painter and zone tinting reuse -------------------------

export const forestMaskAt = (seed, x, z) => {
  const weald = smoothstep(60, -160, z) * smoothstep(120, -60, x); // north-west bias
  const patches = smoothstep(0.06, 0.3, fbm(seed + 61, x / 120, z / 120, 3));
  return weald * patches;
};

export const flowerMaskAt = (seed, x, z) => {
  const south = smoothstep(-60, 140, z);
  return south * smoothstep(0.42, 0.62, valueNoise2(seed + 83, x / 90 + 40, z / 90 + 40));
};

export const ashMaskAt = (seed, x, z) => {
  const northEast = smoothstep(20, 140, x) * smoothstep(-40, -200, z);
  return northEast * smoothstep(0.1, 0.4, fbm(seed + 97, x / 150, z / 150, 3) + 0.3);
};
