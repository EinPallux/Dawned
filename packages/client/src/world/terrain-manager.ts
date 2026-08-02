/**
 * Terrain streaming — residency rings around the player, amortized so the
 * frame never hitches (ROADMAP P2 DoD: "streaming invisible").
 *
 * Pipeline per chunk: fetch (IndexedDB-cached, 2 in flight) → sampler data →
 * ONE mesh build per frame → water plane → foliage instancing when inside the
 * foliage ring. Unload disposes per-chunk geometry past the outer ring
 * (hysteresis so border-dancing doesn't thrash).
 *
 * The manager owns the shared ChunkTerrain sampler — the same object the
 * prediction step walks on, so the ground you see IS the ground you collide with.
 */

import * as THREE from 'three';
import {
  CHUNK_SIZE_M,
  ChunkTerrain,
  WORLD_CHUNKS,
  WORLD_ORIGIN_M,
  chunkIndexOf,
  chunkKey,
  type MapChunk,
} from '@dawned/shared';
import type { MapSource } from './map-source.js';
import { buildChunkMesh, buildWaterMesh } from './terrain-mesh.js';
import { buildChunkFoliage, type FoliageAssets } from './foliage.js';

const LOAD_RADIUS_M = 192;
const UNLOAD_RADIUS_M = 272;
const FOLIAGE_RADIUS_M = 136;
const MAX_CONCURRENT_FETCHES = 2;
/** Rescan cadence — chunk residency doesn't need per-frame work. */
const SCAN_INTERVAL_S = 0.4;

interface ResidentChunk {
  chunk: MapChunk;
  mesh: THREE.Mesh | null;
  water: THREE.Mesh | null;
  foliage: THREE.Group | null;
}

export class TerrainManager {
  readonly sampler = new ChunkTerrain();

  private readonly resident = new Map<number, ResidentChunk>();
  private readonly fetching = new Set<number>();
  private readonly meshQueue: MapChunk[] = [];
  private fetchQueue: { cx: number; cy: number; distSq: number }[] = [];
  private scanCooldown = 0;
  private foliageAssets: FoliageAssets | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly source: MapSource,
  ) {}

  attachFoliage(assets: FoliageAssets): void {
    this.foliageAssets = assets;
  }

  /** Number of chunks with visible meshes (perf HUD + smoke assertions). */
  get residentCount(): number {
    return this.resident.size;
  }

  get pendingCount(): number {
    return this.fetchQueue.length + this.fetching.size + this.meshQueue.length;
  }

  /** True when the chunk under a position is fully loaded (or is open ocean). */
  isGroundReadyAt(x: number, z: number): boolean {
    const cx = chunkIndexOf(x);
    const cy = chunkIndexOf(z);
    if (!this.source.hasChunk(cx, cy)) return true; // ocean — nothing to wait for
    return this.resident.get(chunkKey(cx, cy))?.mesh != null;
  }

  /** Advance streaming. Call once per frame with the camera/player position. */
  update(dt: number, x: number, z: number): void {
    this.scanCooldown -= dt;
    if (this.scanCooldown <= 0) {
      this.scanCooldown = SCAN_INTERVAL_S;
      this.scan(x, z);
    }
    this.pumpFetches();
    this.pumpMeshBuilds(x, z);
  }

  private scan(x: number, z: number): void {
    // Enqueue wanted chunks by distance.
    const ring = Math.ceil(LOAD_RADIUS_M / CHUNK_SIZE_M);
    const ccx = chunkIndexOf(x);
    const ccy = chunkIndexOf(z);
    const wanted: { cx: number; cy: number; distSq: number }[] = [];
    for (let cy = ccy - ring; cy <= ccy + ring; cy++) {
      for (let cx = ccx - ring; cx <= ccx + ring; cx++) {
        if (cx < 0 || cy < 0 || cx >= WORLD_CHUNKS || cy >= WORLD_CHUNKS) continue;
        if (!this.source.hasChunk(cx, cy)) continue;
        const key = chunkKey(cx, cy);
        if (this.resident.has(key) || this.fetching.has(key)) continue;
        const centerX = WORLD_ORIGIN_M + (cx + 0.5) * CHUNK_SIZE_M;
        const centerZ = WORLD_ORIGIN_M + (cy + 0.5) * CHUNK_SIZE_M;
        const distSq = (centerX - x) ** 2 + (centerZ - z) ** 2;
        if (distSq <= LOAD_RADIUS_M * LOAD_RADIUS_M) wanted.push({ cx, cy, distSq });
      }
    }
    wanted.sort((a, b) => a.distSq - b.distSq);
    this.fetchQueue = wanted;

    // Unload beyond the outer ring.
    for (const [key, entry] of this.resident) {
      const centerX = WORLD_ORIGIN_M + (entry.chunk.cx + 0.5) * CHUNK_SIZE_M;
      const centerZ = WORLD_ORIGIN_M + (entry.chunk.cy + 0.5) * CHUNK_SIZE_M;
      const distSq = (centerX - x) ** 2 + (centerZ - z) ** 2;
      if (distSq > UNLOAD_RADIUS_M * UNLOAD_RADIUS_M) {
        this.unload(key, entry);
      } else if (
        entry.foliage &&
        distSq > FOLIAGE_RADIUS_M * FOLIAGE_RADIUS_M * 2.25 // 1.5× hysteresis
      ) {
        this.disposeFoliage(entry);
      }
    }
  }

  private pumpFetches(): void {
    while (this.fetching.size < MAX_CONCURRENT_FETCHES && this.fetchQueue.length > 0) {
      const next = this.fetchQueue.shift()!;
      const key = chunkKey(next.cx, next.cy);
      if (this.resident.has(key) || this.fetching.has(key)) continue;
      this.fetching.add(key);
      void this.source
        .loadChunk(next.cx, next.cy)
        .then((chunk) => {
          if (!this.fetching.has(key)) return; // disposed mid-flight
          if (chunk) {
            this.sampler.addChunk(chunk);
            this.resident.set(key, { chunk, mesh: null, water: null, foliage: null });
            this.meshQueue.push(chunk);
          }
        })
        .catch((error: unknown) => {
          console.warn(`[terrain] chunk ${next.cx},${next.cy} failed to load:`, error);
        })
        .finally(() => {
          this.fetching.delete(key);
        });
    }
  }

  private pumpMeshBuilds(x: number, z: number): void {
    // One terrain mesh build per frame keeps worst-case frame cost bounded.
    const chunk = this.meshQueue.shift();
    if (chunk) {
      const entry = this.resident.get(chunkKey(chunk.cx, chunk.cy));
      if (entry && !entry.mesh) {
        entry.mesh = buildChunkMesh(chunk);
        this.scene.add(entry.mesh);
        entry.water = buildWaterMesh(chunk, (wx, wz) => this.sampler.heightAt(wx, wz));
        if (entry.water) this.scene.add(entry.water);
      }
      return; // foliage waits for a frame without terrain work
    }

    // Then at most one foliage build per frame, nearest first.
    if (!this.foliageAssets) return;
    let best: ResidentChunk | null = null;
    let bestDistSq = FOLIAGE_RADIUS_M * FOLIAGE_RADIUS_M;
    for (const entry of this.resident.values()) {
      if (entry.foliage || !entry.mesh) continue;
      const centerX = WORLD_ORIGIN_M + (entry.chunk.cx + 0.5) * CHUNK_SIZE_M;
      const centerZ = WORLD_ORIGIN_M + (entry.chunk.cy + 0.5) * CHUNK_SIZE_M;
      const distSq = (centerX - x) ** 2 + (centerZ - z) ** 2;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = entry;
      }
    }
    if (best) {
      best.foliage = buildChunkFoliage(best.chunk, this.foliageAssets, (wx, wz) =>
        this.sampler.heightAt(wx, wz),
      );
      if (best.foliage) this.scene.add(best.foliage);
      else best.foliage = new THREE.Group(); // nothing to place — mark done
    }
  }

  private disposeFoliage(entry: ResidentChunk): void {
    if (!entry.foliage) return;
    this.scene.remove(entry.foliage);
    entry.foliage.traverse((object) => {
      // Instanced meshes own their instance buffers; base geometry is shared.
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
    entry.foliage = null;
  }

  private unload(key: number, entry: ResidentChunk): void {
    this.disposeFoliage(entry);
    if (entry.mesh) {
      this.scene.remove(entry.mesh);
      entry.mesh.geometry.dispose(); // material is shared
    }
    if (entry.water) {
      this.scene.remove(entry.water);
      entry.water.geometry.dispose();
    }
    this.sampler.removeChunk(entry.chunk.cx, entry.chunk.cy);
    this.resident.delete(key);
  }

  dispose(): void {
    for (const [key, entry] of this.resident) this.unload(key, entry);
    this.fetchQueue = [];
    this.fetching.clear();
    this.meshQueue.length = 0;
  }
}
