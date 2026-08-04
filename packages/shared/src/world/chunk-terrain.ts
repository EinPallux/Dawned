/**
 * Chunk-backed terrain sampler — the P2 ground, shared verbatim by server and
 * client (the anti-desync rule from dev-terrain.ts carries over: both sides
 * must sample identical heights from identical bytes).
 *
 * Heights live on a global 1 m vertex grid; chunks duplicate their border row so
 * any vertex can be read from whichever chunk floor() lands in. Bilinear
 * interpolation between the four cell corners; missing chunks read as ocean
 * floor. Walkability (when a grid is attached) answers the movement step's
 * walkableAt — see formulas/movement.ts.
 */

import type { TerrainSampler } from '../formulas/movement.js';
import type { MapChunk } from './chunk-codec.js';
import {
  CHUNK_SIZE_M,
  CHUNK_VERTS,
  OCEAN_FLOOR_Y,
  WORLD_CHUNKS,
  WORLD_ORIGIN_M,
  WORLD_SIZE_M,
  chunkKey,
} from './map.js';
import type { Walkgrid } from './walkgrid.js';

const MAX_VERTEX = WORLD_SIZE_M - 1; // last cell's min corner on the global grid

export class ChunkTerrain implements TerrainSampler {
  private readonly chunks = new Map<number, MapChunk>();
  private walkgrid: Walkgrid | null = null;

  addChunk(chunk: MapChunk): void {
    this.chunks.set(chunkKey(chunk.cx, chunk.cy), chunk);
  }

  removeChunk(cx: number, cy: number): void {
    this.chunks.delete(chunkKey(cx, cy));
  }

  getChunk(cx: number, cy: number): MapChunk | undefined {
    return this.chunks.get(chunkKey(cx, cy));
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  attachWalkgrid(walkgrid: Walkgrid | null): void {
    this.walkgrid = walkgrid;
  }

  /** Height of a global grid vertex (integer metre coordinates). */
  private vertexHeight(ix: number, iz: number): number {
    if (ix < 0 || iz < 0 || ix >= WORLD_SIZE_M || iz >= WORLD_SIZE_M) return OCEAN_FLOOR_Y;
    const cx = Math.min(Math.floor(ix / CHUNK_SIZE_M), WORLD_CHUNKS - 1);
    const cy = Math.min(Math.floor(iz / CHUNK_SIZE_M), WORLD_CHUNKS - 1);
    const chunk = this.chunks.get(chunkKey(cx, cy));
    if (!chunk) return OCEAN_FLOOR_Y;
    const lx = ix - cx * CHUNK_SIZE_M;
    const lz = iz - cy * CHUNK_SIZE_M;
    return chunk.heights[lz * CHUNK_VERTS + lx]!;
  }

  /**
   * True when the chunk covering this point has arrived. `heightAt` cannot say
   * so itself: a missing chunk and real sea floor both read `OCEAN_FLOOR_Y`.
   */
  hasDataAt(x: number, z: number): boolean {
    const gx = Math.min(Math.max(x - WORLD_ORIGIN_M, 0), MAX_VERTEX - 1e-6);
    const gz = Math.min(Math.max(z - WORLD_ORIGIN_M, 0), MAX_VERTEX - 1e-6);
    const cx = Math.min(Math.floor(gx / CHUNK_SIZE_M), WORLD_CHUNKS - 1);
    const cy = Math.min(Math.floor(gz / CHUNK_SIZE_M), WORLD_CHUNKS - 1);
    return this.chunks.has(chunkKey(cx, cy));
  }

  heightAt(x: number, z: number): number {
    // Clamp into the last cell so the world edge has stable heights.
    const gx = Math.min(Math.max(x - WORLD_ORIGIN_M, 0), MAX_VERTEX - 1e-6);
    const gz = Math.min(Math.max(z - WORLD_ORIGIN_M, 0), MAX_VERTEX - 1e-6);
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const h00 = this.vertexHeight(ix, iz);
    const h10 = this.vertexHeight(ix + 1, iz);
    const h01 = this.vertexHeight(ix, iz + 1);
    const h11 = this.vertexHeight(ix + 1, iz + 1);
    const top = h00 + (h10 - h00) * fx;
    const bottom = h01 + (h11 - h01) * fx;
    return top + (bottom - top) * fz;
  }

  /** Steepest incline of the cell containing (x, z), in degrees (1 m grid). */
  slopeDegAt(x: number, z: number): number {
    const gx = Math.min(Math.max(x - WORLD_ORIGIN_M, 0), MAX_VERTEX - 1e-6);
    const gz = Math.min(Math.max(z - WORLD_ORIGIN_M, 0), MAX_VERTEX - 1e-6);
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const h00 = this.vertexHeight(ix, iz);
    const h10 = this.vertexHeight(ix + 1, iz);
    const h01 = this.vertexHeight(ix, iz + 1);
    const h11 = this.vertexHeight(ix + 1, iz + 1);
    const dx = Math.max(Math.abs(h10 - h00), Math.abs(h11 - h01));
    const dz = Math.max(Math.abs(h01 - h00), Math.abs(h11 - h10));
    return (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
  }

  /** Movement gate (formulas/movement.ts). Permissive until a walkgrid attaches. */
  walkableAt(x: number, z: number): boolean {
    return this.walkgrid ? this.walkgrid.walkableAt(x, z) : true;
  }

  /** Water surface height for the chunk under (x, z); null on dry/unbaked chunks. */
  waterLevelAt(x: number, z: number): number | null {
    const gx = x - WORLD_ORIGIN_M;
    const gz = z - WORLD_ORIGIN_M;
    if (gx < 0 || gz < 0 || gx >= WORLD_SIZE_M || gz >= WORLD_SIZE_M) return null;
    const cx = Math.min(Math.floor(gx / CHUNK_SIZE_M), WORLD_CHUNKS - 1);
    const cy = Math.min(Math.floor(gz / CHUNK_SIZE_M), WORLD_CHUNKS - 1);
    return this.chunks.get(chunkKey(cx, cy))?.waterLevel ?? null;
  }
}
