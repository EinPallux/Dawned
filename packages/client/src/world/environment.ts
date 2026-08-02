/**
 * Shared world-building pieces: palette, sky, terrain, water, lights.
 * Used by the in-game scene AND the menu backdrops so the front door shows the
 * real world, not a JPG (docs/design/UI_UX.md §4 login vignette).
 */

import * as THREE from 'three';
import { DEV_TERRAIN_EXTENT, devTerrain } from '@dawned/shared';

/** Vibrant, saturated palette (docs/design/GAME_DESIGN.md §6). */
export const PALETTE = {
  sand: new THREE.Color('#e8d7a2'),
  grassLow: new THREE.Color('#5cb84b'),
  grassHigh: new THREE.Color('#3f9c46'),
  rock: new THREE.Color('#8d8a7a'),
  water: new THREE.Color('#2f8fd0'),
  skyTop: new THREE.Color('#3f7fd0'),
  skyHorizon: new THREE.Color('#ffd9a0'),
  /** Warmer sunrise grade for the menu vignette. */
  dawnSkyTop: new THREE.Color('#5a6fc0'),
  dawnSkyHorizon: new THREE.Color('#ffb37a'),
  fog: new THREE.Color('#bcd9f0'),
  localPlayer: new THREE.Color('#f0c46b'),
};

export const buildSkyMesh = (top: THREE.Color, horizon: THREE.Color): THREE.Mesh => {
  const geometry = new THREE.SphereGeometry(900, 24, 16);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: top },
      horizonColor: { value: horizon },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition).y;
        float t = clamp(pow(max(h, 0.0), 0.55), 0.0, 1.0);
        gl_FragColor = vec4(mix(horizonColor, topColor, t), 1.0);
      }
    `,
  });
  return new THREE.Mesh(geometry, material);
};

export const buildTerrainMesh = (): THREE.Mesh => {
  const extent = DEV_TERRAIN_EXTENT * 2;
  const segments = 160;
  const geometry = new THREE.PlaneGeometry(extent, extent, segments, segments);
  geometry.rotateX(-Math.PI / 2);

  const position = geometry.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(position.count * 3);
  const color = new THREE.Color();

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const height = devTerrain.heightAt(x, z);
    position.setY(i, height);

    if (height < 0.15) color.copy(PALETTE.sand);
    else if (height < 2.5) color.copy(PALETTE.grassLow).lerp(PALETTE.grassHigh, height / 2.5);
    else color.copy(PALETTE.grassHigh).lerp(PALETTE.rock, Math.min(1, (height - 2.5) / 3));

    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  );
  mesh.receiveShadow = true;
  return mesh;
};

export const buildWaterMesh = (): THREE.Mesh => {
  const geometry = new THREE.PlaneGeometry(DEV_TERRAIN_EXTENT * 6, DEV_TERRAIN_EXTENT * 6);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({
      color: PALETTE.water,
      transparent: true,
      opacity: 0.78,
      flatShading: true,
    }),
  );
  mesh.position.y = -0.35;
  return mesh;
};

export interface BuiltLights {
  sun: THREE.DirectionalLight;
  hemisphere: THREE.HemisphereLight;
}

export const buildLights = (options?: { warm?: boolean; shadows?: boolean }): BuiltLights => {
  const sun = new THREE.DirectionalLight(options?.warm ? 0xffd9a8 : 0xfff2d0, 2.1);
  sun.position.set(60, options?.warm ? 35 : 90, 40);
  if (options?.shadows !== false) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 260;
    const size = 70;
    sun.shadow.camera.left = -size;
    sun.shadow.camera.right = size;
    sun.shadow.camera.top = size;
    sun.shadow.camera.bottom = -size;
  }
  const hemisphere = new THREE.HemisphereLight(0xbcd9f0, 0x5c8a3a, options?.warm ? 0.9 : 1.15);
  return { sun, hemisphere };
};
