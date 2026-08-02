/**
 * Foliage instancing — grass, bushes and trees scattered per terrain chunk from
 * its splat weights (grass/forest/flowers/ash channels), with a vertex-shader
 * wind sway. Everything is deterministic per chunk, so two clients standing on
 * the same meadow see the same field.
 *
 * This is the P2 ambient layer only: hand-placed props/trees arrive with the
 * map editor's placements at A3/P12 and simply render on top of (or replace)
 * these scatter rules.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CHUNK_SIZE_M, SPLAT_MAP_SIZE, WORLD_ORIGIN_M, type MapChunk } from '@dawned/shared';

/** Wind clock shared by every foliage material (updated from the frame loop). */
const windUniform = { value: 0 };

export const updateFoliageWind = (elapsedSeconds: number): void => {
  windUniform.value = elapsedSeconds;
};

/** Inject a cheap sway into a Lambert material — strength scales with height. */
const withWind = (material: THREE.Material, strength: number): THREE.Material => {
  const clone = material.clone();
  clone.onBeforeCompile = (shader) => {
    shader.uniforms.uWind = windUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uWind;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec4 wp = instanceMatrix * vec4(transformed, 1.0);
          float sway = sin(uWind * 1.7 + wp.x * 0.35 + wp.z * 0.28) * ${strength.toFixed(3)};
          transformed.x += sway * max(transformed.y, 0.0);
        }`,
      );
  };
  return clone;
};

interface FoliageKind {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  castShadow: boolean;
}

export interface FoliageAssets {
  grass: FoliageKind[];
  bush: FoliageKind[];
  tree: FoliageKind[];
  bareTree: FoliageKind[];
}

const KIND_IDS = {
  // The lightest grass variants (14-44 tris) — grass dominates instance counts,
  // so its per-model cost decides the triangle budget (TECH_STACK ≤500k in view).
  grass: [
    'world_nature_grass_1_a_color1',
    'world_nature_grass_1_a_singlesided_color1',
    'world_nature_grass_1_b_singlesided_color1',
  ],
  bush: [
    'world_nature_bush_1_a_color1',
    'world_nature_bush_1_b_color1',
    'world_nature_bush_1_c_color1',
  ],
  // Light-variant trees only (330-640 tris) — the 1.4k-tri showpieces wait for
  // hand-placed placements (A3/P12) where counts are curated, not scattered.
  tree: [
    'world_nature_tree_1_a_color1',
    'world_nature_tree_1_b_color1',
    'world_nature_tree_2_a_color1',
  ],
  bareTree: ['world_nature_tree_bare_1_a_color1', 'world_nature_tree_bare_1_b_color1'],
} as const;

interface ManifestShape {
  assets: Record<string, { id: string; file: string }>;
}

// `instanceof THREE.Mesh` narrows to Mesh<any, any>; the discriminator guard
// keeps geometry/material fully typed (same pattern as characters.ts).
const isMesh = (object: THREE.Object3D): object is THREE.Mesh =>
  (object as Partial<THREE.Mesh>).isMesh === true;

/** First mesh in a gltf scene, with the pack's node transforms baked in. */
const extractKind = (
  root: THREE.Object3D,
  wind: number,
  castShadow: boolean,
): FoliageKind | null => {
  root.updateMatrixWorld(true);
  let found: FoliageKind | null = null;
  root.traverse((object) => {
    if (found !== null || !isMesh(object)) return;
    const geometry = object.geometry.clone();
    geometry.applyMatrix4(object.matrixWorld);
    const source = Array.isArray(object.material) ? object.material[0]! : object.material;
    found = { geometry, material: withWind(source, wind), castShadow };
  });
  return found;
};

let assetsPromise: Promise<FoliageAssets | null> | null = null;

/** Load (once) the foliage model set from the asset manifest. Never rejects. */
export const loadFoliageAssets = (): Promise<FoliageAssets | null> => {
  assetsPromise ??= loadAll();
  return assetsPromise;
};

const loadAll = async (): Promise<FoliageAssets | null> => {
  let manifest: ManifestShape;
  try {
    manifest = (await (await fetch('/assets/manifest.json')).json()) as ManifestShape;
  } catch {
    console.warn('[foliage] no asset manifest — terrain stays bare');
    return null;
  }
  const loader = new GLTFLoader();

  const loadKind = async (ids: readonly string[], wind: number, castShadow: boolean) => {
    const kinds: FoliageKind[] = [];
    for (const id of ids) {
      const entry = manifest.assets[id];
      if (!entry) continue;
      try {
        const gltf = await loader.loadAsync(`/${entry.file}`);
        const kind = extractKind(gltf.scene, wind, castShadow);
        if (kind) kinds.push(kind);
      } catch (error) {
        console.warn(`[foliage] failed to load ${id}:`, error);
      }
    }
    return kinds;
  };

  const [grass, bush, tree, bareTree] = await Promise.all([
    loadKind(KIND_IDS.grass, 0.08, false),
    loadKind(KIND_IDS.bush, 0.03, false),
    loadKind(KIND_IDS.tree, 0.012, true),
    loadKind(KIND_IDS.bareTree, 0.008, true),
  ]);
  if (grass.length + bush.length + tree.length + bareTree.length === 0) return null;
  return { grass, bush, tree, bareTree };
};

// --- per-chunk scatter ------------------------------------------------------

/** Deterministic hash → [0, 1) from chunk-local scatter coordinates. */
const rand = (seed: number, n: number): number => {
  let h = (seed ^ (n * 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

interface Placement {
  x: number;
  z: number;
  scale: number;
  rotation: number;
}

const SPLAT_TEXEL = CHUNK_SIZE_M / SPLAT_MAP_SIZE;

/** Read a splat channel (0–7) at a texel. */
const weightAt = (chunk: MapChunk, layer: number, tx: number, tz: number): number => {
  const mapOffset = layer >= 4 ? SPLAT_MAP_SIZE * SPLAT_MAP_SIZE * 4 : 0;
  return chunk.splat[mapOffset + (tz * SPLAT_MAP_SIZE + tx) * 4 + (layer & 3)]! / 255;
};

const buildInstanced = (
  kinds: FoliageKind[],
  placements: Placement[],
  groundAt: (x: number, z: number) => number,
  seed: number,
  chunkCenter: { x: number; z: number },
): THREE.InstancedMesh[] => {
  if (kinds.length === 0 || placements.length === 0) return [];
  // Split placements across the model variants deterministically.
  const buckets: Placement[][] = kinds.map(() => []);
  placements.forEach((placement, index) => {
    buckets[Math.floor(rand(seed, index * 7 + 3) * kinds.length)]!.push(placement);
  });

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const scaleVector = new THREE.Vector3();

  return buckets.flatMap((bucket, kindIndex) => {
    if (bucket.length === 0) return [];
    const kind = kinds[kindIndex]!;
    const mesh = new THREE.InstancedMesh(kind.geometry, kind.material, bucket.length);
    bucket.forEach((placement, i) => {
      quaternion.setFromAxisAngle(up, placement.rotation);
      scaleVector.setScalar(placement.scale);
      matrix.compose(
        new THREE.Vector3(placement.x, groundAt(placement.x, placement.z), placement.z),
        quaternion,
        scaleVector,
      );
      mesh.setMatrixAt(i, matrix);
    });
    mesh.castShadow = kind.castShadow;
    mesh.instanceMatrix.needsUpdate = true;
    // Instanced bounds cover only the base geometry — set a chunk-sized sphere
    // so frustum culling works per chunk instead of culling everything.
    mesh.geometry.boundingSphere ??= new THREE.Sphere();
    mesh.frustumCulled = true;
    mesh.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(chunkCenter.x, 0, chunkCenter.z),
      CHUNK_SIZE_M * 1.2,
    );
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return [mesh];
  });
};

/**
 * Scatter foliage over one chunk from its splat weights. Returns null when the
 * chunk gets nothing (deep ocean, bare rock).
 */
export const buildChunkFoliage = (
  chunk: MapChunk,
  assets: FoliageAssets,
  groundAt: (x: number, z: number) => number,
): THREE.Group | null => {
  const seed = (chunk.cx * 73856093) ^ (chunk.cy * 19349663);
  const minX = WORLD_ORIGIN_M + chunk.cx * CHUNK_SIZE_M;
  const minZ = WORLD_ORIGIN_M + chunk.cy * CHUNK_SIZE_M;

  const grass: Placement[] = [];
  const bushes: Placement[] = [];
  const trees: Placement[] = [];
  const bareTrees: Placement[] = [];

  let n = 0;
  for (let tz = 0; tz < SPLAT_MAP_SIZE; tz++) {
    for (let tx = 0; tx < SPLAT_MAP_SIZE; tx++) {
      const wGrass = weightAt(chunk, 0, tx, tz);
      const wForest = weightAt(chunk, 4, tx, tz);
      const wFlowers = weightAt(chunk, 5, tx, tz);
      const wAsh = weightAt(chunk, 6, tx, tz);

      const place = (list: Placement[], scaleMin: number, scaleMax: number): void => {
        const x = minX + (tx + rand(seed, n++)) * SPLAT_TEXEL;
        const z = minZ + (tz + rand(seed, n++)) * SPLAT_TEXEL;
        list.push({
          x,
          z,
          scale: scaleMin + rand(seed, n++) * (scaleMax - scaleMin),
          rotation: rand(seed, n++) * Math.PI * 2,
        });
      };

      // Ground gates: nothing sprouts underwater or on steep faces — approximate
      // via the height of the texel center (cheap; walkgrid isn't needed here).
      const centerHeight = groundAt(
        minX + (tx + 0.5) * SPLAT_TEXEL,
        minZ + (tz + 0.5) * SPLAT_TEXEL,
      );
      if (centerHeight < 0.35) {
        n += 8; // keep the deterministic stream aligned
        continue;
      }

      if (rand(seed, n++) < (wGrass + wFlowers) * 0.28) place(grass, 0.75, 1.25);
      if (rand(seed, n++) < wForest * 0.06) place(trees, 0.85, 1.35);
      if (rand(seed, n++) < wForest * 0.05 + wGrass * 0.012) place(bushes, 0.8, 1.3);
      if (rand(seed, n++) < wAsh * 0.035) place(bareTrees, 0.9, 1.4);
    }
  }

  const center = { x: minX + CHUNK_SIZE_M / 2, z: minZ + CHUNK_SIZE_M / 2 };
  const meshes = [
    ...buildInstanced(assets.grass, grass, groundAt, seed ^ 0x1111, center),
    ...buildInstanced(assets.bush, bushes, groundAt, seed ^ 0x2222, center),
    ...buildInstanced(assets.tree, trees, groundAt, seed ^ 0x3333, center),
    ...buildInstanced(assets.bareTree, bareTrees, groundAt, seed ^ 0x4444, center),
  ];
  if (meshes.length === 0) return null;
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  for (const mesh of meshes) group.add(mesh);
  return group;
};
