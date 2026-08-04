/**
 * Terrain chunk meshes — the three.js half of the splat format.
 *
 * The vertices, colors and index buffer come from `@dawned/shared`
 * (`buildChunkGeometryData`), because the map editor in Dawned-Admin renders
 * the same chunks with its own three.js: one implementation means the editor
 * cannot show a world that differs from the one players walk on. This file
 * owns only what is renderer-specific — materials, the skirt-carrying mesh, and
 * the water plane with its depth-driven shore blend.
 */

import * as THREE from 'three';
import {
  CHUNK_SIZE_M,
  SPLAT_LAYERS,
  WORLD_ORIGIN_M,
  buildChunkGeometryData,
  type MapChunk,
} from '@dawned/shared';

/** The palette as linear RGB triples, which is what the shared builder blends. */
const LAYER_RGB = SPLAT_LAYERS.map((layer) => {
  const color = new THREE.Color(layer.color);
  return [color.r, color.g, color.b] as const;
});

const sharedTerrainMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
  flatShading: true,
});

/** Build the render mesh for one chunk. Position it at the chunk's min corner. */
export const buildChunkMesh = (chunk: MapChunk): THREE.Mesh => {
  const baseIx = (WORLD_ORIGIN_M + chunk.cx * CHUNK_SIZE_M) | 0;
  const baseIz = (WORLD_ORIGIN_M + chunk.cy * CHUNK_SIZE_M) | 0;
  const data = buildChunkGeometryData(chunk, LAYER_RGB, baseIx, baseIz);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));

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
