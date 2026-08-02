/**
 * Dev-island worldgen — bakes the P2 map artifacts (docs/tech/ASSET_PIPELINE.md §6):
 *
 *   assets_baked/map/<version>/chunk_<cx>_<cy>.bin   (land + shore chunks only;
 *                                                     missing chunks read as ocean)
 *   assets_baked/map/<version>/walkgrid.bin
 *   assets_baked/map/<version>/zones.json
 *   assets_baked/map/<version>/meta.json              (spawn, sea level, bounds)
 *   assets_baked/map/<version>/worldmap.png           (1024², 2 m/px)
 *   assets_baked/map/<version>/minimap_tiles/0_0.png  (baseline single tile)
 *
 * Deterministic: identical (seed, version) → identical bytes. Replaced by the
 * admin map editor's publish pipeline at A2/A3 — same formats, hand-authored.
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  CHUNK_SIZE_M,
  CHUNK_VERTS,
  SPLAT_MAP_SIZE,
  SPLAT_LAYERS,
  WORLD_CHUNKS,
  WORLD_ORIGIN_M,
  WORLD_SIZE_M,
  WalkClass,
  Walkgrid,
  encodeChunk,
  zonesFileSchema,
} from '@dawned/shared';
import {
  SEA_LEVEL,
  LAKE,
  ashMaskAt,
  flowerMaskAt,
  forestMaskAt,
  heightAt,
  lakeLevel,
  waterLevelAt,
} from './island.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

/** Slope in degrees from 1 m finite differences of the analytic field. */
const slopeDegAt = (seed, x, z) => {
  const h = heightAt(seed, x, z);
  const dx = heightAt(seed, x + 1, z) - h;
  const dz = heightAt(seed, x, z + 1) - h;
  return (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
};

/**
 * Splat weights (8 layers, order = SPLAT_LAYERS) at a world position.
 * Also used by the worldmap render so paint and map always agree.
 */
const splatWeightsAt = (seed, x, z) => {
  const h = heightAt(seed, x, z);
  const slope = slopeDegAt(seed, x, z);
  const depth = waterLevelAt(seed, x, z) - h;
  const forest = forestMaskAt(seed, x, z);
  const flowers = flowerMaskAt(seed, x, z);
  const ash = ashMaskAt(seed, x, z);

  const s = (a, b, v) => Math.min(1, Math.max(0, (v - a) / (b - a)));
  const rock = s(38, 58, slope) + s(18, 30, h) * 0.35;
  const dirt = s(24, 42, slope) * (1 - Math.min(1, rock));
  const sand = s(1.5, 0.35, Math.abs(h - 0.55)) * s(26, 12, slope) * (1 - forest);
  const shallows = depth > 0.05 ? s(2.4, 0.3, depth) : 0;
  const land = h > waterLevelAt(seed, x, z) - 0.05 ? 1 : 0.25;

  // Order: grass, sand, rock, dirt, forest, flowers, ash, shallows.
  const weights = [
    0.9 * land * (1 - forest * 0.8) * (1 - ash * 0.85),
    sand * 2.2,
    rock * 1.6,
    dirt,
    forest * 1.8 * land,
    flowers * 1.1 * land * s(16, 6, slope),
    ash * 1.7,
    shallows * 2.5,
  ];
  return weights;
};

/** Quantize weights to RGBA bytes summing exactly 255 (largest takes the slack). */
const quantizeWeights = (weights) => {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const bytes = weights.map((w) => Math.round((w / sum) * 255));
  const byteSum = bytes.reduce((a, b) => a + b, 0);
  let largest = 0;
  for (let i = 1; i < bytes.length; i++) if (bytes[i] > bytes[largest]) largest = i;
  bytes[largest] += 255 - byteSum;
  return bytes;
};

const buildChunk = (seed, cx, cy) => {
  const minX = WORLD_ORIGIN_M + cx * CHUNK_SIZE_M;
  const minZ = WORLD_ORIGIN_M + cy * CHUNK_SIZE_M;

  const heights = new Float32Array(CHUNK_VERTS * CHUNK_VERTS);
  let maxHeight = -Infinity;
  for (let iz = 0; iz < CHUNK_VERTS; iz++) {
    for (let ix = 0; ix < CHUNK_VERTS; ix++) {
      const h = heightAt(seed, minX + ix, minZ + iz);
      heights[iz * CHUNK_VERTS + ix] = h;
      if (h > maxHeight) maxHeight = h;
    }
  }

  const splat = new Uint8Array(2 * SPLAT_MAP_SIZE * SPLAT_MAP_SIZE * 4);
  const texel = CHUNK_SIZE_M / SPLAT_MAP_SIZE;
  for (let tz = 0; tz < SPLAT_MAP_SIZE; tz++) {
    for (let tx = 0; tx < SPLAT_MAP_SIZE; tx++) {
      const bytes = quantizeWeights(
        splatWeightsAt(seed, minX + (tx + 0.5) * texel, minZ + (tz + 0.5) * texel),
      );
      const base = (tz * SPLAT_MAP_SIZE + tx) * 4;
      const second = SPLAT_MAP_SIZE * SPLAT_MAP_SIZE * 4 + base;
      for (let c = 0; c < 4; c++) {
        splat[base + c] = bytes[c];
        splat[second + c] = bytes[4 + c];
      }
    }
  }

  // Water level: the lake owns its chunks; anything touching the sea gets 0.
  const centerX = minX + CHUNK_SIZE_M / 2;
  const centerZ = minZ + CHUNK_SIZE_M / 2;
  const nearLake = Math.hypot(centerX - LAKE.x, centerZ - LAKE.z) < LAKE.radius + CHUNK_SIZE_M;
  let waterLevel = null;
  if (nearLake) waterLevel = lakeLevel(seed);
  else {
    let minH = Infinity;
    for (let i = 0; i < heights.length; i++) if (heights[i] < minH) minH = heights[i];
    if (minH < SEA_LEVEL + 0.4) waterLevel = SEA_LEVEL;
  }

  return { chunk: { cx, cy, waterLevel, heights, splat }, maxHeight };
};

const buildWalkgrid = (seed) => {
  const grid = Walkgrid.empty(WalkClass.Blocked);
  for (let iz = 0; iz < WORLD_SIZE_M; iz++) {
    for (let ix = 0; ix < WORLD_SIZE_M; ix++) {
      const x = WORLD_ORIGIN_M + ix + 0.5;
      const z = WORLD_ORIGIN_M + iz + 0.5;
      const h = heightAt(seed, x, z);
      if (h < -5) continue; // deep ocean stays Blocked — skip the expensive rest
      const depth = waterLevelAt(seed, x, z) - h;
      let walkClass;
      if (depth > 1.2) walkClass = WalkClass.Blocked;
      else if (depth > 0.05) walkClass = WalkClass.WaterWade;
      else if (slopeDegAt(seed, x, z) > 50) walkClass = WalkClass.Steep;
      else walkClass = WalkClass.Walkable;
      grid.setClassAtCell(ix, iz, walkClass);
    }
  }
  return grid;
};

/** Deterministic spawn: first flat, walkable meadow point scanning in from the south beach. */
const findSpawn = (seed, grid) => {
  for (let z = 400; z >= 60; z -= 3) {
    for (const x of [0, -9, 9, -18, 18, -27, 27, -36, 36, -45, 45]) {
      const h = heightAt(seed, x, z);
      if (h < 0.8 || h > 7) continue;
      if (slopeDegAt(seed, x, z) > 8) continue;
      if (!grid.walkableAt(x, z)) continue;
      return { x, y: h, z, yaw: Math.PI }; // facing north, into the island
    }
  }
  throw new Error('worldgen: no valid spawn found — island parameters broke the south beach');
};

const ZONE_AMBIENCE = {
  default: {
    fogColor: '#f4b98d',
    fogNear: 90,
    fogFar: 520,
    skyTop: '#5a6fc0',
    skyHorizon: '#ffb37a',
    sunColor: '#ffe3bb',
    sunIntensity: 2.2,
    hemiSky: '#dce8ff',
    hemiGround: '#3a4a3a',
    hemiIntensity: 0.8,
  },
  dawnshore: {
    fogColor: '#ffc99b',
    fogNear: 110,
    fogFar: 560,
    skyTop: '#6f87d8',
    skyHorizon: '#ffc9a0',
    sunColor: '#fff0d0',
    sunIntensity: 2.6,
    hemiSky: '#e6f0ff',
    hemiGround: '#4a5a40',
    hemiIntensity: 1.0,
  },
  verdant_weald: {
    fogColor: '#9fc79a',
    fogNear: 45,
    fogFar: 300,
    skyTop: '#4f6f9f',
    skyHorizon: '#cfe2b8',
    sunColor: '#f2ffd9',
    sunIntensity: 1.9,
    hemiSky: '#cfe6c8',
    hemiGround: '#324530',
    hemiIntensity: 0.9,
  },
  ashen_reach: {
    fogColor: '#8a8298',
    fogNear: 35,
    fogFar: 240,
    skyTop: '#3c3a52',
    skyHorizon: '#b9a8b0',
    sunColor: '#e8d8e0',
    sunIntensity: 1.6,
    hemiSky: '#b8b0c8',
    hemiGround: '#3a3540',
    hemiIntensity: 0.8,
  },
};

const buildZones = () => {
  const zones = {
    defaultAmbience: ZONE_AMBIENCE.default,
    zones: [
      {
        id: 'verdant_weald',
        name: 'The Verdant Weald',
        levelMin: 6,
        levelMax: 12,
        polygon: [
          [-620, -620],
          [0, -620],
          [0, -70],
          [-620, -70],
        ],
        ambience: ZONE_AMBIENCE.verdant_weald,
        safe: false,
        settlement: null,
      },
      {
        id: 'ashen_reach',
        name: 'The Ashen Reach',
        levelMin: 12,
        levelMax: 18,
        polygon: [
          [0, -620],
          [620, -620],
          [620, -70],
          [0, -70],
        ],
        ambience: ZONE_AMBIENCE.ashen_reach,
        safe: false,
        settlement: null,
      },
      {
        id: 'dawnshore',
        name: 'Dawnshore',
        levelMin: 1,
        levelMax: 6,
        polygon: [
          [-620, -70],
          [620, -70],
          [620, 620],
          [-620, 620],
        ],
        ambience: ZONE_AMBIENCE.dawnshore,
        safe: false,
        settlement: 'Dawnhaven (P12)',
      },
    ],
  };
  return zonesFileSchema.parse(zones); // worldgen must satisfy the shared contract
};

// --- map renders ------------------------------------------------------------

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const LAYER_COLORS = SPLAT_LAYERS.map((layer) => hexToRgb(layer.color));
const DEEP_WATER = hexToRgb('#2e5e8c');
const SHALLOW_WATER = hexToRgb('#7fb2c8');

const renderWorldmap = (seed) => {
  const size = 1024; // 2 m/px over the 2048 m world
  const pixels = Buffer.alloc(size * size * 3);
  const light = [-0.55, 0.65, -0.52]; // NW morning light
  const lightLen = Math.hypot(...light);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = WORLD_ORIGIN_M + (px + 0.5) * 2;
      const z = WORLD_ORIGIN_M + (py + 0.5) * 2;
      const h = heightAt(seed, x, z);
      const water = waterLevelAt(seed, x, z);
      let r;
      let g;
      let b;
      if (h < water - 0.05) {
        const t = Math.min(1, (water - h) / 6);
        r = SHALLOW_WATER[0] + (DEEP_WATER[0] - SHALLOW_WATER[0]) * t;
        g = SHALLOW_WATER[1] + (DEEP_WATER[1] - SHALLOW_WATER[1]) * t;
        b = SHALLOW_WATER[2] + (DEEP_WATER[2] - SHALLOW_WATER[2]) * t;
      } else {
        const weights = splatWeightsAt(seed, x, z);
        const sum = weights.reduce((a, c) => a + c, 0) || 1;
        r = 0;
        g = 0;
        b = 0;
        for (let i = 0; i < 8; i++) {
          const w = weights[i] / sum;
          r += LAYER_COLORS[i][0] * w;
          g += LAYER_COLORS[i][1] * w;
          b += LAYER_COLORS[i][2] * w;
        }
        // Hillshade from 2 m differences.
        const dx = heightAt(seed, x + 2, z) - h;
        const dz = heightAt(seed, x, z + 2) - h;
        const nLen = Math.hypot(dx, 2, dz);
        const shade = Math.max(
          0,
          (-dx * light[0] + 2 * light[1] - dz * light[2]) / (nLen * lightLen),
        );
        const factor = 0.62 + shade * 0.5;
        r *= factor;
        g *= factor;
        b *= factor;
      }
      const at = (py * size + px) * 3;
      pixels[at] = Math.min(255, r);
      pixels[at + 1] = Math.min(255, g);
      pixels[at + 2] = Math.min(255, b);
    }
  }
  return sharp(pixels, { raw: { width: size, height: size, channels: 3 } });
};

// --- entry ------------------------------------------------------------------

export const generate = async ({ seed = 7, version = 'dev-1' } = {}) => {
  const outDir = path.join(REPO_ROOT, 'assets_baked/map', version);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, 'minimap_tiles'), { recursive: true });

  console.log(`worldgen: seed ${seed} → assets_baked/map/${version}`);

  // 1. Chunks — emit only where there is land or shore (missing = open ocean).
  // The id list goes into meta.json so clients never have to probe for chunks
  // that were skipped.
  const chunkIds = [];
  const bounds = { minCx: Infinity, minCy: Infinity, maxCx: -Infinity, maxCy: -Infinity };
  for (let cy = 0; cy < WORLD_CHUNKS; cy++) {
    for (let cx = 0; cx < WORLD_CHUNKS; cx++) {
      const { chunk, maxHeight } = buildChunk(seed, cx, cy);
      if (maxHeight < -6.5) continue; // pure deep ocean
      await writeFile(path.join(outDir, `chunk_${cx}_${cy}.bin`), encodeChunk(chunk));
      chunkIds.push(`${cx}_${cy}`);
      bounds.minCx = Math.min(bounds.minCx, cx);
      bounds.minCy = Math.min(bounds.minCy, cy);
      bounds.maxCx = Math.max(bounds.maxCx, cx);
      bounds.maxCy = Math.max(bounds.maxCy, cy);
    }
  }
  console.log(
    `  chunks: ${chunkIds.length} emitted (${WORLD_CHUNKS * WORLD_CHUNKS - chunkIds.length} ocean skipped)`,
  );

  // 2. Walkgrid.
  const grid = buildWalkgrid(seed);
  await writeFile(path.join(outDir, 'walkgrid.bin'), grid.encode());
  console.log('  walkgrid: baked');

  // 3. Zones.
  const zones = buildZones();
  await writeFile(path.join(outDir, 'zones.json'), `${JSON.stringify(zones, null, 2)}\n`);
  console.log(`  zones: ${zones.zones.length}`);

  // 4. Spawn + meta.
  const spawn = findSpawn(seed, grid);
  const meta = {
    mapVersion: version,
    seed,
    spawn,
    seaLevel: SEA_LEVEL,
    lake: { ...LAKE, level: lakeLevel(seed) },
    chunks: { emitted: chunkIds.length, ...bounds, ids: chunkIds },
  };
  await writeFile(path.join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`  spawn: (${spawn.x}, ${spawn.y.toFixed(2)}, ${spawn.z})`);

  // 5. Map renders.
  const worldmap = renderWorldmap(seed);
  await worldmap.clone().png({ compressionLevel: 9 }).toFile(path.join(outDir, 'worldmap.png'));
  await worldmap
    .clone()
    .resize(512, 512, { kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toFile(path.join(outDir, 'minimap_tiles', '0_0.png'));
  console.log('  renders: worldmap.png + minimap_tiles/0_0.png');

  return meta;
};
