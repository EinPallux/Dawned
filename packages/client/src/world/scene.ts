/**
 * The rendered world.
 *
 * P0 draws the dev island with the same terrain function the simulation walks on,
 * plus a stylized sky, water and simple character capsules. Real terrain streaming
 * lands in P2 and character models in P1 — the structure here (scene owner, per-entity
 * views, camera rig) is what those phases extend.
 */

import * as THREE from 'three';
import { DEV_TERRAIN_EXTENT, PLAYER_HEIGHT, PLAYER_RADIUS, devTerrain } from '@dawned/shared';

/** Vibrant, saturated palette (docs/design/GAME_DESIGN.md §6). */
const PALETTE = {
  sand: new THREE.Color('#e8d7a2'),
  grassLow: new THREE.Color('#5cb84b'),
  grassHigh: new THREE.Color('#3f9c46'),
  rock: new THREE.Color('#8d8a7a'),
  water: new THREE.Color('#2f8fd0'),
  skyTop: new THREE.Color('#3f7fd0'),
  skyHorizon: new THREE.Color('#ffd9a0'),
  fog: new THREE.Color('#bcd9f0'),
  localPlayer: new THREE.Color('#f0c46b'),
};

const REMOTE_COLORS = ['#d8663a', '#4fa3e8', '#8bc44a', '#efd26e', '#a44fe0', '#3fbf5a'];

export class PlayerView {
  readonly group = new THREE.Group();
  private readonly label: THREE.Sprite;

  constructor(name: string, color: THREE.ColorRepresentation, isLocal: boolean) {
    const material = new THREE.MeshLambertMaterial({ color, flatShading: true });
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT - PLAYER_RADIUS * 2, 4, 8),
      material,
    );
    body.position.y = PLAYER_HEIGHT / 2;
    body.castShadow = true;
    this.group.add(body);

    // A wedge so facing is readable at a glance (stand-in for real characters, P1).
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.42, 4),
      new THREE.MeshLambertMaterial({ color: isLocal ? '#ffffff' : '#1e2534', flatShading: true }),
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, PLAYER_HEIGHT * 0.62, PLAYER_RADIUS + 0.12);
    this.group.add(nose);

    this.label = makeLabelSprite(name);
    this.label.position.y = PLAYER_HEIGHT + 0.45;
    this.group.add(this.label);
  }

  setPose(x: number, y: number, z: number, yaw: number): void {
    this.group.position.set(x, y, z);
    this.group.rotation.y = yaw;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      // `instanceof Mesh` narrows to Mesh<any, any>; name the concrete shape so the
      // geometry/material accesses stay type-safe.
      const mesh = object as THREE.Mesh;
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        for (const entry of mesh.material) entry.dispose();
      } else {
        mesh.material.dispose();
      }
    });
    const labelTexture = this.label.material.map;
    if (labelTexture) labelTexture.dispose();
    this.label.material.dispose();
  }
}

export const remoteColorFor = (id: number): string =>
  REMOTE_COLORS[id % REMOTE_COLORS.length] ?? '#ffffff';

const makeLabelSprite = (text: string): THREE.Sprite => {
  const font = 'bold 30px system-ui, sans-serif';
  const padding = 16;

  // Measure first: a fixed-width canvas clips long names (16 chars are allowed).
  const measureCtx = document.createElement('canvas').getContext('2d');
  let textWidth = text.length * 17;
  if (measureCtx) {
    measureCtx.font = font;
    textWidth = measureCtx.measureText(text).width;
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(textWidth + padding * 2);
  canvas.height = 64;

  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(21,26,38,0.92)';
    ctx.strokeText(text, canvas.width / 2, 34);
    ctx.fillStyle = '#ede6d4';
    ctx.fillText(text, canvas.width / 2, 34);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true }),
  );
  // Keep world-space height constant; width follows the name's aspect ratio.
  const height = 0.55;
  sprite.scale.set((canvas.width / canvas.height) * height, height, 1);
  return sprite;
};

export class GameScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.1,
      2000,
    );

    this.scene.fog = new THREE.Fog(PALETTE.fog, 90, 320);
    this.buildSky();
    this.buildTerrain();
    this.buildWater();
    this.buildLights();

    window.addEventListener('resize', this.handleResize);
    this.handleResize();
  }

  private handleResize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  private buildSky(): void {
    const geometry = new THREE.SphereGeometry(900, 24, 16);
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: PALETTE.skyTop },
        horizonColor: { value: PALETTE.skyHorizon },
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
    this.scene.add(new THREE.Mesh(geometry, material));
  }

  private buildTerrain(): void {
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
    this.scene.add(mesh);
  }

  private buildWater(): void {
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
    this.scene.add(mesh);
  }

  /** Kept so the shadow frustum can follow the player (see updateCamera). */
  private sun!: THREE.DirectionalLight;

  private buildLights(): void {
    const sun = new THREE.DirectionalLight(0xfff2d0, 2.1);
    this.sun = sun;
    sun.position.set(60, 90, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 260;
    const size = 70;
    sun.shadow.camera.left = -size;
    sun.shadow.camera.right = size;
    sun.shadow.camera.top = size;
    sun.shadow.camera.bottom = -size;
    this.scene.add(sun);
    // The target must be in the scene graph for its matrix to update.
    this.scene.add(sun.target);

    this.scene.add(new THREE.HemisphereLight(0xbcd9f0, 0x5c8a3a, 1.15));
  }

  /** Third-person orbit camera behind the player (mouselook, Q1 decision). */
  updateCamera(target: { x: number; y: number; z: number }, yaw: number, pitch: number): void {
    // The shadow frustum is a ±70 m box — anchor it to the player, or shadows
    // silently vanish the moment they walk away from the world origin.
    this.sun.position.set(target.x + 60, target.y + 90, target.z + 40);
    this.sun.target.position.set(target.x, target.y, target.z);

    const distance = 6.5;
    const horizontal = Math.cos(pitch) * distance;
    this.camera.position.set(
      target.x - Math.sin(yaw) * horizontal,
      target.y + 1.6 + Math.sin(pitch) * distance,
      target.z - Math.cos(yaw) * horizontal,
    );
    this.camera.lookAt(target.x, target.y + 1.35, target.z);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  get localPlayerColor(): THREE.Color {
    return PALETTE.localPlayer;
  }
}
