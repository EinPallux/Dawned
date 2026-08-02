/**
 * The rendered world.
 *
 * P2 shape: the scene owns the camera rig, the sky dome, the sun/hemisphere
 * lights and linear fog — all mutable, because zone ambience blends them at
 * runtime (ambience.ts). Terrain, water and foliage are streamed in and out by
 * TerrainManager; nothing static is built here anymore.
 */

import * as THREE from 'three';
import { PALETTE, buildLights, buildSkyMesh } from './environment.js';
import type { AmbienceTargets } from './ambience.js';

export class GameScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  private readonly sun: THREE.DirectionalLight;
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly sky: THREE.Mesh;
  private readonly skyTop = PALETTE.skyTop.clone();
  private readonly skyHorizon = PALETTE.skyHorizon.clone();
  private readonly fog: THREE.Fog;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.1,
      2000,
    );

    this.fog = new THREE.Fog(PALETTE.fog, 90, 520);
    this.scene.fog = this.fog;

    // Sky dome shares the Color instances ambience mutates. It follows the
    // camera (updateCamera) so the world's 2 km extent never pokes through it.
    this.sky = buildSkyMesh(this.skyTop, this.skyHorizon);
    this.scene.add(this.sky);

    const { sun, hemisphere } = buildLights();
    this.sun = sun;
    this.hemisphere = hemisphere;
    this.scene.add(sun);
    // The target must be in the scene graph for its matrix to update.
    this.scene.add(sun.target);
    this.scene.add(hemisphere);

    window.addEventListener('resize', this.handleResize);
    this.handleResize();
  }

  /** Handles the ambience controller writes into (world/ambience.ts). */
  get ambienceTargets(): AmbienceTargets {
    return {
      fog: this.fog,
      skyTop: this.skyTop,
      skyHorizon: this.skyHorizon,
      sun: this.sun,
      hemisphere: this.hemisphere,
    };
  }

  private handleResize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

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
    this.sky.position.copy(this.camera.position);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
