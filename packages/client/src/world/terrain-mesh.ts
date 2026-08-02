/**
 * Terrain chunk geometry — the visual half of the splat format.
 *
 * The vibrant low-poly look shades terrain with FLAT COLORS: each vertex blends
 * the 8 splat-layer colors by baked weight (plus a deterministic ±4% value
 * jitter so fields aren't billiard felt), and the Lambert material's
 * flatShading gives the faceted look without any normal data. A skirt ring
 * drops 4 m from every edge so the seam against not-yet-loaded neighbours
 * (open ocean) never shows as a crack.
 *
 * Water is a per-chunk plane at the chunk's own level with a depth-driven
 * shore blend: transparent glassy shallows → opaque deep color.
 */

import * as THREE from 'three';
import {
  CHUNK_SIZE_M,
  CHUNK_VERTS,
  SPLAT_LAYERS,
  SPLAT_MAP_SIZE,
  WORLD_ORIGIN_M,
  type MapChunk,
} from '@dawned/shared';

const SKIRT_DEPTH = 4;

const LAYER_COLORS = SPLAT_LAYERS.map((layer) => new THREE.Color(layer.color));

/** Deterministic per-vertex jitter in [-1, 1] from world grid coordinates. */
const jitter = (ix: number, iz: number): number => {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1;
};

/** Bilinear splat weight lookup for one layer at local metre coordinates. */
const splatWeightAt = (chunk: MapChunk, layer: number, lx: number, lz: number): number => {
  const texel = CHUNK_SIZE_M / SPLAT_MAP_SIZE; // 2 m
  const sx = Math.min(Math.max(lx / texel - 0.5, 0), SPLAT_MAP_SIZE - 1.001);
  const sz = Math.min(Math.max(lz / texel - 0.5, 0), SPLAT_MAP_SIZE - 1.001);
  const ix = Math.floor(sx);
  const iz = Math.floor(sz);
  const fx = sx - ix;
  const fz = sz - iz;
  const mapOffset = layer >= 4 ? SPLAT_MAP_SIZE * SPLAT_MAP_SIZE * 4 : 0;
  const channel = layer & 3;
  const at = (x: number, z: number): number =>
    chunk.splat[mapOffset + (z * SPLAT_MAP_SIZE + Math.min(x, SPLAT_MAP_SIZE - 1)) * 4 + channel]!;
  const top = at(ix, iz) + (at(ix + 1, iz) - at(ix, iz)) * fx;
  const bottom = at(ix, iz + 1) + (at(ix + 1, iz + 1) - at(ix, iz + 1)) * fx;
  return top + (bottom - top) * fz;
};

const sharedTerrainMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
  flatShading: true,
});

/** Build the render mesh for one chunk. Position it at the chunk's min corner. */
export const buildChunkMesh = (chunk: MapChunk): THREE.Mesh => {
  const verts = CHUNK_VERTS;
  const gridCount = verts * verts;
  // Grid vertices + one skirt ring (same count as the border: 4 edges).
  const skirtCount = verts * 4;
  const positions = new Float32Array((gridCount + skirtCount) * 3);
  const colors = new Float32Array((gridCount + skirtCount) * 3);

  const baseIx = (WORLD_ORIGIN_M + chunk.cx * CHUNK_SIZE_M) | 0;
  const baseIz = (WORLD_ORIGIN_M + chunk.cy * CHUNK_SIZE_M) | 0;
  const color = new THREE.Color();

  for (let iz = 0; iz < verts; iz++) {
    for (let ix = 0; ix < verts; ix++) {
      const i = iz * verts + ix;
      positions[i * 3] = ix;
      positions[i * 3 + 1] = chunk.heights[i]!;
      positions[i * 3 + 2] = iz;

      color.setRGB(0, 0, 0);
      let total = 0;
      for (let layer = 0; layer < 8; layer++) {
        const weight = splatWeightAt(chunk, layer, ix, iz);
        if (weight <= 0) continue;
        total += weight;
        color.r += LAYER_COLORS[layer]!.r * weight;
        color.g += LAYER_COLORS[layer]!.g * weight;
        color.b += LAYER_COLORS[layer]!.b * weight;
      }
      const scale = (total > 0 ? 1 / total : 0) * (1 + jitter(baseIx + ix, baseIz + iz) * 0.04);
      colors[i * 3] = color.r * scale;
      colors[i * 3 + 1] = color.g * scale;
      colors[i * 3 + 2] = color.b * scale;
    }
  }

  // Grid triangles.
  const cells = verts - 1;
  const indices = new Uint32Array((cells * cells + cells * 4) * 6);
  let at = 0;
  for (let iz = 0; iz < cells; iz++) {
    for (let ix = 0; ix < cells; ix++) {
      const a = iz * verts + ix;
      const b = a + 1;
      const c = a + verts;
      const d = c + 1;
      indices[at++] = a;
      indices[at++] = c;
      indices[at++] = b;
      indices[at++] = b;
      indices[at++] = c;
      indices[at++] = d;
    }
  }

  // Skirts: copy each border vertex, drop it, stitch a quad strip per edge.
  const edges: [number, (i: number) => number][] = [
    [0, (i) => i], // north row (iz = 0), left→right
    [1, (i) => (verts - 1) * verts + (verts - 1 - i)], // south row, right→left
    [2, (i) => (verts - 1 - i) * verts], // west column, bottom→top
    [3, (i) => i * verts + (verts - 1)], // east column, top→bottom
  ];
  for (const [edge, gridIndex] of edges) {
    const skirtBase = gridCount + edge * verts;
    for (let i = 0; i < verts; i++) {
      const src = gridIndex(i);
      const dst = skirtBase + i;
      positions[dst * 3] = positions[src * 3]!;
      positions[dst * 3 + 1] = positions[src * 3 + 1]! - SKIRT_DEPTH;
      positions[dst * 3 + 2] = positions[src * 3 + 2]!;
      colors[dst * 3] = colors[src * 3]!;
      colors[dst * 3 + 1] = colors[src * 3 + 1]!;
      colors[dst * 3 + 2] = colors[src * 3 + 2]!;
      if (i > 0) {
        const prevSrc = gridIndex(i - 1);
        indices[at++] = prevSrc;
        indices[at++] = dst - 1;
        indices[at++] = src;
        indices[at++] = src;
        indices[at++] = dst - 1;
        indices[at++] = dst;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices.subarray(0, at), 1));

  const mesh = new THREE.Mesh(geometry, sharedTerrainMaterial);
  mesh.position.set(baseIx, 0, baseIz);
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
};

// --- water ------------------------------------------------------------------

const WATER_SEGMENTS = 8;

const waterMaterial = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: {
    shallowColor: { value: new THREE.Color('#6fc0d8') },
    deepColor: { value: new THREE.Color('#2e6e9e') },
    time: { value: 0 },
  },
  vertexShader: /* glsl */ `
    attribute float depth;
    varying float vDepth;
    uniform float time;
    void main() {
      vDepth = depth;
      vec3 p = position;
      p.y += sin(time * 1.1 + position.x * 0.21 + position.z * 0.17) * 0.06;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 shallowColor;
    uniform vec3 deepColor;
    varying float vDepth;
    void main() {
      float t = clamp(vDepth / 4.0, 0.0, 1.0);
      float alpha = mix(0.28, 0.86, t);
      gl_FragColor = vec4(mix(shallowColor, deepColor, t), alpha);
    }
  `,
});

/** Advance the shared water animation (one uniform for every chunk's plane). */
export const updateWaterTime = (elapsedSeconds: number): void => {
  waterMaterial.uniforms.time!.value = elapsedSeconds;
};

/**
 * Water plane for a chunk, with per-vertex depth (water level − ground) driving
 * the shore blend. Returns null for dry chunks.
 */
export const buildWaterMesh = (
  chunk: MapChunk,
  groundAt: (x: number, z: number) => number,
): THREE.Mesh | null => {
  if (chunk.waterLevel === null) return null;
  const level = chunk.waterLevel;
  const minX = WORLD_ORIGIN_M + chunk.cx * CHUNK_SIZE_M;
  const minZ = WORLD_ORIGIN_M + chunk.cy * CHUNK_SIZE_M;

  const geometry = new THREE.PlaneGeometry(
    CHUNK_SIZE_M,
    CHUNK_SIZE_M,
    WATER_SEGMENTS,
    WATER_SEGMENTS,
  );
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(CHUNK_SIZE_M / 2, 0, CHUNK_SIZE_M / 2);

  const position = geometry.attributes.position as THREE.BufferAttribute;
  const depth = new Float32Array(position.count);
  let wet = 0;
  for (let i = 0; i < position.count; i++) {
    const d = level - groundAt(minX + position.getX(i), minZ + position.getZ(i));
    depth[i] = Math.max(0, d);
    if (d > 0.02) wet++;
  }
  if (wet === 0) {
    geometry.dispose();
    return null; // water level exists but this chunk's surface is entirely dry
  }
  geometry.setAttribute('depth', new THREE.BufferAttribute(depth, 1));

  const mesh = new THREE.Mesh(geometry, waterMaterial);
  mesh.position.set(minX, level, minZ);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
};

/** Open-ocean backdrop far past the loaded rings (a single big plane at sea level). */
export const buildOceanMesh = (seaLevel: number): THREE.Mesh => {
  const geometry = new THREE.PlaneGeometry(6000, 6000);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ color: '#2e6e9e', transparent: true, opacity: 0.92 }),
  );
  mesh.position.y = seaLevel - 0.12; // just under chunk water so they never z-fight
  return mesh;
};
