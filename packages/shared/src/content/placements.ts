/**
 * World population content (A3 map editor · game P12): the things that STAND on
 * the terrain rather than being part of it — props, foliage scatter, discovery
 * points and interactables.
 *
 * These rows are authored in the map editor, validated here, and baked into
 * `map/<version>/placements.json` for the client and the server to read. The
 * schema lives in shared for the usual reason: the editor writes it, the bake
 * validates it, and the game consumes it, so exactly one definition may exist.
 *
 * Coordinates are WORLD-SPACE metres. Y is NOT authored for ground-sitting
 * things: the bake re-samples terrain height so a placement can never drift
 * when the ground under it is sculpted (`yOffset` lifts a lantern off a post).
 */

import { z } from 'zod';
import { WORLD_SIZE_M } from '../world/map.js';
import { nodePlacementSchema } from './resource-nodes.js';

/** Slugs for editor-authored rows — same shape the content editors use. */
export const placementSlug = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9_]+$/, 'ids are snake_case slugs');

const worldX = z.number().min(-WORLD_SIZE_M).max(WORLD_SIZE_M);

/**
 * A single placed model. `modelRef` is a baked-asset manifest id, so a
 * placement can never name art that does not exist (publish checks it).
 */
export const propPlacementSchema = z
  .object({
    id: placementSlug,
    modelRef: z.string().min(1).max(64),
    x: worldX,
    z: worldX,
    /** Lift above the sampled ground, metres. 0 = sitting on it. */
    yOffset: z.number().min(-20).max(60).default(0),
    /** Yaw in radians; the editor's rotate gizmo and jitter both write this. */
    rotation: z.number().default(0),
    /** Uniform scale. Jitter stamping writes a rolled value, not a range. */
    scale: z.number().min(0.05).max(20).default(1),
    /**
     * Tilt to match the ground normal (cliff dressing, fallen logs). Stored as
     * the pitch/roll the editor computed, so the bake does not re-derive it and
     * disagree.
     */
    tiltX: z.number().min(-1.6).max(1.6).default(0),
    tiltZ: z.number().min(-1.6).max(1.6).default(0),
    /** Editor grouping — flattened at bake, kept so a set stays re-selectable. */
    collection: z.string().max(64).nullable().default(null),
    /** Blocks movement: the walkgrid bake stamps its footprint unwalkable. */
    solid: z.boolean().default(false),
    /** Footprint radius used by the walkgrid stamp when `solid`. */
    radius: z.number().min(0).max(20).default(0),
  })
  .strict();
export type PropPlacement = z.infer<typeof propPlacementSchema>;

/**
 * A weighted list of models painted as ground cover. Scatter is stored as
 * PARAMETERS per chunk cell rather than instances (MAP_EDITOR.md §2.2) — a
 * forest is a density map, not fifty thousand rows, so painting stays light and
 * the bake can re-scatter deterministically from the seed.
 */
export const scatterEntrySchema = z
  .object({
    modelRef: z.string().min(1).max(64),
    weight: z.number().min(0).max(100).default(1),
    scaleMin: z.number().min(0.05).max(20).default(0.9),
    scaleMax: z.number().min(0.05).max(20).default(1.1),
  })
  .strict()
  .refine((entry) => entry.scaleMax >= entry.scaleMin, {
    message: 'scaleMax must be ≥ scaleMin',
  });
export type ScatterEntry = z.infer<typeof scatterEntrySchema>;

export const scatterSetSchema = z
  .object({
    id: placementSlug,
    name: z.string().min(1).max(64),
    entries: z.array(scatterEntrySchema).min(1).max(12),
    /** Instances per 100 m² at full density — the brush paints 0..1 of this. */
    densityPer100m2: z.number().min(0.1).max(400).default(60),
    /** Refuse to place above this slope (degrees) — grass does not grow on cliffs. */
    maxSlopeDeg: z.number().min(0).max(90).default(35),
    /** Refuse below this height (metres) — keeps ground cover out of the sea. */
    minHeight: z.number().min(-64).max(256).default(0.2),
  })
  .strict();
export type ScatterSet = z.infer<typeof scatterSetSchema>;

/** Discovery point (PROGRESSION.md §4): walk into the ring, earn the XP once. */
export const poiSchema = z
  .object({
    id: placementSlug,
    name: z.string().min(1).max(64),
    kind: z.enum(['vista', 'landmark', 'ruin', 'cave', 'settlement', 'shrine']),
    x: worldX,
    z: worldX,
    /** Discovery radius, metres. */
    radius: z.number().min(2).max(80).default(12),
    /** XP basis points — the curve scales it by the finder's level. */
    xpBasis: z.number().int().min(0).max(10_000).default(250),
    /** Map icon id (baked icon atlas); empty = the kind's default glyph. */
    icon: z.string().max(64).default(''),
  })
  .strict();
export type Poi = z.infer<typeof poiSchema>;

/**
 * Interactables: the `F`-prompt furniture of the world. One row per placed
 * thing; the `kind` selects which of the optional fields matter, and
 * `validateInteractable` enforces that so a chest can never ship without a
 * loot table.
 */
export const interactableSchema = z
  .object({
    id: placementSlug,
    kind: z.enum(['chest', 'shrine', 'campfire', 'signpost', 'portal', 'quest_prop']),
    name: z.string().min(1).max(64),
    x: worldX,
    z: worldX,
    yOffset: z.number().min(-20).max(60).default(0),
    rotation: z.number().default(0),
    modelRef: z.string().min(1).max(64),
    /** `chest`: which loot table it rolls. */
    lootTableId: z.string().max(64).nullable().default(null),
    /** `chest`: how long before it refills, ms. 0 = one-shot per character. */
    respawnMs: z.number().int().min(0).max(86_400_000).default(600_000),
    /** `signpost` / `quest_prop`: the text the prompt shows. */
    text: z.string().max(300).default(''),
    /** `portal`: destination point. */
    destX: z.number().nullable().default(null),
    destZ: z.number().nullable().default(null),
    /** `shrine`: fast-travel graph membership + respawn anchor. */
    travelNode: z.boolean().default(false),
  })
  .strict();
export type Interactable = z.infer<typeof interactableSchema>;

/** Per-kind rules the flat schema cannot express. Returns problems, [] = ok. */
export const validateInteractable = (row: Interactable): string[] => {
  const problems: string[] = [];
  if (row.kind === 'chest' && !row.lootTableId) {
    problems.push(`${row.id}: a chest needs a lootTableId (an empty chest is a bug, not content)`);
  }
  if (row.kind === 'portal' && (row.destX === null || row.destZ === null)) {
    problems.push(`${row.id}: a portal needs destX/destZ`);
  }
  if (row.kind === 'signpost' && row.text.trim() === '') {
    problems.push(`${row.id}: a signpost with no text says nothing`);
  }
  if (row.kind !== 'shrine' && row.travelNode) {
    problems.push(`${row.id}: only shrines can be travel nodes`);
  }
  return problems;
};

/**
 * The baked population file: `map/<version>/placements.json`. One artifact for
 * everything that stands on the ground, so the client makes one request and the
 * server reads one file.
 */
export const placementsFileSchema = z
  .object({
    props: z.array(propPlacementSchema),
    /**
     * Scatter is per (chunk, set): a 16×16 density grid over the chunk, values
     * 0–255. Empty grids are omitted entirely rather than stored as zeros.
     */
    scatterSets: z.array(scatterSetSchema),
    scatter: z.array(
      z
        .object({
          cx: z.number().int().min(0),
          cy: z.number().int().min(0),
          setId: placementSlug,
          /** 16×16 row-major densities, 0–255. */
          density: z.array(z.number().int().min(0).max(255)).length(256),
        })
        .strict(),
    ),
    pois: z.array(poiSchema),
    interactables: z.array(interactableSchema),
    /**
     * Resource nodes (P10). Thin placements pointing at `content_resource_nodes`
     * definitions — see content/resource-nodes.ts for why the split. Defaulted
     * rather than required so a bake published before P10 still parses; the
     * server treats a missing array as "this world has no gathering yet".
     */
    nodes: z.array(nodePlacementSchema).default([]),
  })
  .strict();
export type PlacementsFile = z.infer<typeof placementsFileSchema>;

/** Density grid resolution per chunk (16×16 cells over 64 m = 4 m cells). */
export const SCATTER_GRID = 16;
export const SCATTER_CELL_M = 64 / SCATTER_GRID;

/**
 * Deterministic scatter resolution: turn a density grid into concrete
 * instances. The EDITOR previews with this and the BAKE emits with it, so what
 * the owner painted is exactly what ships — the seed makes it repeatable and
 * the caller supplies terrain so the same function serves both.
 */
export interface ScatterSample {
  x: number;
  z: number;
  modelRef: string;
  rotation: number;
  scale: number;
}

/** Cheap deterministic hash → [0,1). Same generator on both sides. */
const rand01 = (seed: number): number => {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const resolveScatter = (
  set: ScatterSet,
  cx: number,
  cy: number,
  density: readonly number[],
  originX: number,
  originZ: number,
  sample: (x: number, z: number) => { height: number; slopeDeg: number } | null,
): ScatterSample[] => {
  const out: ScatterSample[] = [];
  const totalWeight = set.entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) return out;
  const cellArea = SCATTER_CELL_M * SCATTER_CELL_M;
  const perCellAtFull = (set.densityPer100m2 * cellArea) / 100;
  for (let iz = 0; iz < SCATTER_GRID; iz++) {
    for (let ix = 0; ix < SCATTER_GRID; ix++) {
      const value = density[iz * SCATTER_GRID + ix] ?? 0;
      if (value === 0) continue;
      const wanted = perCellAtFull * (value / 255);
      const base = (((cy * 32 + cx) * SCATTER_GRID + iz) * SCATTER_GRID + ix) * 977;
      // Fractional counts still place sometimes — otherwise a light dusting of
      // 0.4 trees per cell paints nothing at all and the brush feels broken.
      const whole = Math.floor(wanted);
      const count = whole + (rand01(base) < wanted - whole ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const r = base + i * 31;
        const x = originX + (ix + rand01(r + 1)) * SCATTER_CELL_M;
        const z = originZ + (iz + rand01(r + 2)) * SCATTER_CELL_M;
        const ground = sample(x, z);
        if (!ground) continue;
        if (ground.slopeDeg > set.maxSlopeDeg) continue;
        if (ground.height < set.minHeight) continue;
        let pick = rand01(r + 3) * totalWeight;
        let entry = set.entries[0]!;
        for (const candidate of set.entries) {
          pick -= candidate.weight;
          if (pick <= 0) {
            entry = candidate;
            break;
          }
        }
        out.push({
          x,
          z,
          modelRef: entry.modelRef,
          rotation: rand01(r + 4) * Math.PI * 2,
          scale: entry.scaleMin + rand01(r + 5) * (entry.scaleMax - entry.scaleMin),
        });
      }
    }
  }
  return out;
};
