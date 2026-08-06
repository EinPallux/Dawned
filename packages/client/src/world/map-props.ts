/**
 * The authored world's STATIC layers: hand-placed props and painted scatter.
 *
 * These are the buildings, the town dressing, the bridge plank sections and
 * every forest the map editor painted — and **until 2026-08-06 the game client
 * drew none of them.** `world-objects.ts` renders NPCs, interactables and POIs;
 * `foliage.ts` scatters from splat weights and says in its own header that
 * "hand-placed props/trees arrive with the map editor's placements at A3/P12",
 * a promise nothing ever kept. So `placements.props` and `placements.scatter`
 * were baked, shipped, downloaded — and consumed by nobody.
 *
 * The symptom the owner reported is exactly what that produces: **a city you
 * cannot see and can walk into.** The bake stamps every `solid` prop's
 * footprint into the walkgrid (`map-bake.ts` `buildWalkgrid`), and the server
 * moves players against that grid, so all forty of Dawnhaven's buildings were
 * collision with no mesh. It also explains the editor "looking completely
 * different from the in-game map": the editor draws both layers, the game drew
 * neither.
 *
 * Everything here is INSTANCED. A town is hundreds of props sharing a dozen
 * models and a forest is thousands sharing three, on a one-core VPS budget —
 * one draw call per (model, submesh) is the difference between a world and a
 * slideshow.
 *
 * Both layers seat lazily, for the reason the P8 market posts taught: a sampler
 * with no chunk loaded answers `OCEAN_FLOOR_Y`, so anything placed before its
 * terrain streamed would sit eleven metres under the island and report itself
 * fine. Nothing is added to the scene until `hasDataAt` says the ground beneath
 * it is real.
 */

import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  CHUNK_SIZE_M,
  WORLD_ORIGIN_M,
  resolveScatter,
  type PropPlacement,
  type ScatterSet,
} from '@dawned/shared';

/** One scatter row as the bake stores it: a density grid for one (chunk, set). */
export interface ScatterRow {
  cx: number;
  cy: number;
  setId: string;
  density: readonly number[];
}

interface Ground {
  hasDataAt: (x: number, z: number) => boolean;
  heightAt: (x: number, z: number) => number;
}

/** A per-(model, submesh) instanced batch, grown as instances are seated. */
interface Batch {
  mesh: THREE.InstancedMesh;
  /** The submesh's own transform inside the glTF scene, baked into every instance. */
  local: THREE.Matrix4;
  used: number;
}

const isMesh = (object: THREE.Object3D): object is THREE.Mesh => (object as THREE.Mesh).isMesh;

/**
 * Collect a model's submeshes with their WORLD transforms inside the glTF.
 *
 * Reading geometry alone is confidently wrong for exactly the reason
 * `model-size.mjs` exists (ASSET_PIPELINE §2.2): a glTF node carries a
 * transform, and both KayKit and Quaternius put scale there. Ignoring it drew
 * the shrine at one centimetre.
 */
const submeshesOf = (
  gltf: GLTF,
): { geometry: THREE.BufferGeometry; material: THREE.Material; local: THREE.Matrix4 }[] => {
  const out: { geometry: THREE.BufferGeometry; material: THREE.Material; local: THREE.Matrix4 }[] =
    [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((child) => {
    if (!isMesh(child)) return;
    const material = Array.isArray(child.material) ? child.material[0] : child.material;
    if (!material) return;
    out.push({ geometry: child.geometry, material, local: child.matrixWorld.clone() });
  });
  return out;
};

export class MapPropsManager {
  private readonly batches = new Map<string, Batch[]>();
  private readonly pendingProps: PropPlacement[] = [];
  private readonly pendingScatter: { row: ScatterRow; set: ScatterSet }[] = [];
  private missingModels = new Set<string>();
  private placedProps = 0;
  private placedScatter = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly models: ReadonlyMap<string, GLTF>,
  ) {}

  /**
   * Take the bake's two static layers. Nothing renders yet — every instance
   * waits for the ground under it to stream in (see `update`).
   */
  build(
    props: readonly PropPlacement[],
    scatter: readonly ScatterRow[],
    sets: readonly ScatterSet[],
  ): void {
    this.pendingProps.push(...props);
    const bySetId = new Map(sets.map((set) => [set.id, set]));
    for (const row of scatter) {
      const set = bySetId.get(row.setId);
      // A row naming a set the bake did not write is skipped with a count, not
      // guessed at — the same rule world-objects applies to an unknown NPC def.
      if (!set) continue;
      this.pendingScatter.push({ row, set });
    }
  }

  /**
   * Seat everything whose ground has arrived. Called every frame; each item is
   * placed exactly once and then costs nothing.
   */
  update(ground: Ground): void {
    for (let i = this.pendingProps.length - 1; i >= 0; i--) {
      const prop = this.pendingProps[i]!;
      if (!ground.hasDataAt(prop.x, prop.z)) continue;
      this.addInstance(prop.modelRef, {
        x: prop.x,
        y: ground.heightAt(prop.x, prop.z) + prop.yOffset,
        z: prop.z,
        rotation: prop.rotation,
        scale: prop.scale,
        tiltX: prop.tiltX,
        tiltZ: prop.tiltZ,
      });
      this.pendingProps.splice(i, 1);
      this.placedProps++;
    }

    for (let i = this.pendingScatter.length - 1; i >= 0; i--) {
      const { row, set } = this.pendingScatter[i]!;
      // Resolve a chunk's scatter only once its terrain is real: `resolveScatter`
      // asks for a height and a slope per candidate and drops the ones that fail
      // the set's limits, so running it against an unloaded chunk would place a
      // forest at the bottom of the sea.
      const originX = row.cx * CHUNK_SIZE_M - WORLD_ORIGIN_M;
      const originZ = row.cy * CHUNK_SIZE_M - WORLD_ORIGIN_M;
      if (!ground.hasDataAt(originX + CHUNK_SIZE_M / 2, originZ + CHUNK_SIZE_M / 2)) continue;

      const samples = resolveScatter(set, row.cx, row.cy, row.density, originX, originZ, (x, z) => {
        if (!ground.hasDataAt(x, z)) return null;
        const height = ground.heightAt(x, z);
        // Slope from a small central difference — the same thing the bake's
        // sampler reports, derived here rather than shipped per instance.
        const step = 1;
        const dx = ground.heightAt(x + step, z) - ground.heightAt(x - step, z);
        const dz = ground.heightAt(x, z + step) - ground.heightAt(x, z - step);
        const slopeDeg = (Math.atan(Math.hypot(dx, dz) / (2 * step)) * 180) / Math.PI;
        return { height, slopeDeg };
      });
      for (const sample of samples) {
        this.addInstance(sample.modelRef, {
          x: sample.x,
          y: ground.heightAt(sample.x, sample.z),
          z: sample.z,
          rotation: sample.rotation,
          scale: sample.scale,
          tiltX: 0,
          tiltZ: 0,
        });
        this.placedScatter++;
      }
      this.pendingScatter.splice(i, 1);
    }
  }

  private addInstance(
    modelRef: string,
    at: {
      x: number;
      y: number;
      z: number;
      rotation: number;
      scale: number;
      tiltX: number;
      tiltZ: number;
    },
  ): void {
    const batches = this.batchesFor(modelRef);
    if (!batches) return;
    const world = new THREE.Matrix4().compose(
      new THREE.Vector3(at.x, at.y, at.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(at.tiltX, at.rotation, at.tiltZ, 'YXZ')),
      new THREE.Vector3(at.scale, at.scale, at.scale),
    );
    for (const batch of batches) {
      if (batch.used >= batch.mesh.instanceMatrix.count) this.grow(batch);
      batch.mesh.setMatrixAt(batch.used, world.clone().multiply(batch.local));
      batch.used++;
      batch.mesh.count = batch.used;
      batch.mesh.instanceMatrix.needsUpdate = true;
      batch.mesh.computeBoundingSphere();
    }
  }

  private batchesFor(modelRef: string): Batch[] | null {
    const existing = this.batches.get(modelRef);
    if (existing) return existing;
    const gltf = this.models.get(modelRef);
    if (!gltf) {
      this.missingModels.add(modelRef);
      return null;
    }
    const batches: Batch[] = [];
    for (const part of submeshesOf(gltf)) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, 64);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      // Instance count grows as things seat; start at zero so an empty batch
      // never draws 64 copies of a house at the origin.
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      batches.push({ mesh, local: part.local, used: 0 });
    }
    this.batches.set(modelRef, batches);
    return batches;
  }

  /** Double a full batch, copying what is already placed. */
  private grow(batch: Batch): void {
    const next = new THREE.InstancedMesh(
      batch.mesh.geometry,
      batch.mesh.material,
      Math.max(64, batch.mesh.instanceMatrix.count * 2),
    );
    next.castShadow = true;
    next.receiveShadow = false;
    next.frustumCulled = false;
    const carry = new THREE.Matrix4();
    for (let i = 0; i < batch.used; i++) {
      batch.mesh.getMatrixAt(i, carry);
      next.setMatrixAt(i, carry);
    }
    next.count = batch.used;
    next.instanceMatrix.needsUpdate = true;
    this.scene.remove(batch.mesh);
    batch.mesh.dispose();
    this.scene.add(next);
    batch.mesh = next;
  }

  /** What actually reached the world — the counterpart to `/ops/worldobjects`. */
  stats(): { props: number; scatter: number; pendingProps: number; missingModels: string[] } {
    return {
      props: this.placedProps,
      scatter: this.placedScatter,
      pendingProps: this.pendingProps.length,
      missingModels: [...this.missingModels],
    };
  }

  dispose(): void {
    for (const batches of this.batches.values()) {
      for (const batch of batches) {
        this.scene.remove(batch.mesh);
        batch.mesh.dispose();
      }
    }
    this.batches.clear();
    this.pendingProps.length = 0;
    this.pendingScatter.length = 0;
  }
}
