/**
 * Server terrain mirror — loads the whole baked map into memory at boot
 * (docs/tech/ARCHITECTURE.md §3): ~7 MB of chunks + 1 MiB walkgrid for the
 * 2 km world, sampled through the same shared ChunkTerrain the client
 * predicts with. The server is authoritative for ground Y and walkability;
 * this is where that authority gets its data.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  ChunkTerrain,
  MAP_VERSION,
  Walkgrid,
  decodeChunk,
  placementsFileSchema,
  zonesFileSchema,
  type NodePlacement,
  type NpcPlacement,
  type Interactable,
  type Poi,
  type Zone,
} from '@dawned/shared';

const currentPointerSchema = z.object({ version: z.string().min(1) });

/**
 * Which baked map is live.
 *
 * The admin publish pipeline (A2) writes `<MAP_DIR>/current.json` LAST, after a
 * bake has fully landed, so this file is the one place that says "this version
 * is finished and safe to load". A dev checkout that has only ever run
 * `pnpm world:generate` has no pointer, and falls back to the compiled-in
 * `MAP_VERSION` — which is what that constant is still for.
 */
export const resolveMapVersion = async (mapRoot: string): Promise<string> => {
  try {
    const raw: unknown = JSON.parse(await readFile(path.join(mapRoot, 'current.json'), 'utf8'));
    return currentPointerSchema.parse(raw).version;
  } catch {
    return MAP_VERSION;
  }
};

export interface MapMeta {
  mapVersion: string;
  spawn: { x: number; y: number; z: number; yaw: number };
  seaLevel: number;
  chunks: { emitted: number; ids: string[] };
}

export interface LoadedMap {
  terrain: ChunkTerrain;
  meta: MapMeta;
  /** Zone polygons (P7 zone-entry XP; the client blends ambience from the
   * same file). Empty when the map ships no zones.json. */
  zones: Zone[];
  /**
   * Resource-node placements (P10). The first thing the server reads out of
   * `placements.json` — props and scatter stay client-side decoration, but a
   * node is a thing you interact with, so the authority needs to know it is
   * there. Empty when the map predates P10 or has no gathering.
   */
  nodes: NodePlacement[];
  /**
   * NPCs, interactables and discovery points (P11) — read out of the same
   * `placements.json` for the same reason nodes are: props and scatter stay
   * client-side decoration, but anything you can press `F` on, or that pays XP
   * for standing near it, is the authority's business.
   */
  npcs: NpcPlacement[];
  interactables: Interactable[];
  pois: Poi[];
}

/**
 * Read every chunk + the walkgrid + meta from a baked map directory.
 * Throws with a clear message when artifacts are missing — a server without
 * ground would let everyone fall through the world.
 */
export const loadMapTerrain = async (mapDir: string): Promise<LoadedMap> => {
  let meta: MapMeta;
  try {
    meta = JSON.parse(await readFile(path.join(mapDir, 'meta.json'), 'utf8')) as MapMeta;
  } catch (error) {
    throw new Error(
      `Cannot read map meta at ${mapDir}/meta.json (${(error as Error).message}). ` +
        'Run `pnpm world:generate` (dev) or check MAP_DIR/MAP_VERSION.',
    );
  }

  const terrain = new ChunkTerrain();
  const files = await readdir(mapDir);
  for (const file of files) {
    if (!file.startsWith('chunk_') || !file.endsWith('.bin')) continue;
    terrain.addChunk(decodeChunk(new Uint8Array(await readFile(path.join(mapDir, file)))));
  }
  if (terrain.chunkCount !== meta.chunks.emitted) {
    throw new Error(
      `Map ${meta.mapVersion} is incomplete: ${terrain.chunkCount} chunks on disk, ` +
        `meta says ${meta.chunks.emitted}`,
    );
  }

  const walkgridBytes = new Uint8Array(await readFile(path.join(mapDir, 'walkgrid.bin')));
  terrain.attachWalkgrid(Walkgrid.decode(walkgridBytes));

  // Zones (P7): validated on load — a malformed polygon must not half-run.
  let zones: Zone[] = [];
  try {
    const raw: unknown = JSON.parse(await readFile(path.join(mapDir, 'zones.json'), 'utf8'));
    zones = zonesFileSchema.parse(raw).zones;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Cannot read map zones at ${mapDir}/zones.json: ${(error as Error).message}`);
    }
  }

  // Resource nodes (P10). A missing file is fine — every map baked before P10
  // has none — but a malformed one is not: half a forest is worse than a loud
  // refusal, and the same argument the zones block above makes.
  let nodes: NodePlacement[] = [];
  let npcs: NpcPlacement[] = [];
  let interactables: Interactable[] = [];
  let pois: Poi[] = [];
  try {
    const raw: unknown = JSON.parse(await readFile(path.join(mapDir, 'placements.json'), 'utf8'));
    const parsed = placementsFileSchema.parse(raw);
    nodes = parsed.nodes;
    npcs = parsed.npcs;
    interactables = parsed.interactables;
    pois = parsed.pois;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `Cannot read map placements at ${mapDir}/placements.json: ${(error as Error).message}`,
      );
    }
  }

  return { terrain, meta, zones, nodes, npcs, interactables, pois };
};
