/**
 * World map geometry — the fixed frame every terrain system agrees on
 * (docs/tech/ASSET_PIPELINE.md §6, docs/design/WORLD.md §1).
 *
 * The world is a 2048 m × 2048 m square centred on the origin (movement already
 * clamps to ±WORLD_BOUNDS = ±1024), divided into 32×32 chunks of 64 m. Heightmaps
 * sample at 1 m: 65×65 vertices per chunk, edge rows duplicated between
 * neighbours so meshes and bilinear sampling are seamless by construction.
 */

export const CHUNK_SIZE_M = 64;
/** Vertices per chunk edge (1 m spacing, shared border row with the neighbour). */
export const CHUNK_VERTS = 65;
/** Chunks per world axis. */
export const WORLD_CHUNKS = 32;
export const WORLD_SIZE_M = CHUNK_SIZE_M * WORLD_CHUNKS;
/** World-space coordinate of chunk (0,0)'s min corner. */
export const WORLD_ORIGIN_M = -WORLD_SIZE_M / 2;

/**
 * Ground height reported outside any loaded chunk. Deep enough that nothing
 * walks there (the movement clamp + walkgrid stop players first) and the client
 * renders open ocean.
 */
export const OCEAN_FLOOR_Y = -8;

/** Compact numeric key for chunk maps (cy-major). */
export const chunkKey = (cx: number, cy: number): number => cy * WORLD_CHUNKS + cx;

/** Chunk index containing a world coordinate (unclamped — may be off-world). */
export const chunkIndexOf = (worldCoord: number): number =>
  Math.floor((worldCoord - WORLD_ORIGIN_M) / CHUNK_SIZE_M);

export const isChunkInWorld = (cx: number, cy: number): boolean =>
  cx >= 0 && cy >= 0 && cx < WORLD_CHUNKS && cy < WORLD_CHUNKS;

/** World-space min corner of a chunk. */
export const chunkMinCorner = (cx: number, cy: number): { x: number; z: number } => ({
  x: WORLD_ORIGIN_M + cx * CHUNK_SIZE_M,
  z: WORLD_ORIGIN_M + cy * CHUNK_SIZE_M,
});
