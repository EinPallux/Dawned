/**
 * Server terrain mirror — loads the whole baked map into memory at boot
 * (docs/tech/ARCHITECTURE.md §3): ~7 MB of chunks + 1 MiB walkgrid for the
 * 2 km world, sampled through the same shared ChunkTerrain the client
 * predicts with. The server is authoritative for ground Y and walkability;
 * this is where that authority gets its data.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ChunkTerrain, Walkgrid, decodeChunk } from '@dawned/shared';

export interface MapMeta {
  mapVersion: string;
  spawn: { x: number; y: number; z: number; yaw: number };
  seaLevel: number;
  chunks: { emitted: number; ids: string[] };
}

export interface LoadedMap {
  terrain: ChunkTerrain;
  meta: MapMeta;
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

  return { terrain, meta };
};
