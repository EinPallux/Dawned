/**
 * The rendered world.
 *
 * P0 drew the dev island with the same terrain function the simulation walks on,
 * plus a stylized sky and water. P1 moved player rendering to composed character
 * rigs (see character-view.ts); real terrain streaming lands in P2 — the structure
 * here (scene owner, camera rig) is what those phases extend.
 */

import * as THREE from 'three';
import {
  PALETTE,
  buildLights,
  buildSkyMesh,
  buildTerrainMesh,
  buildWaterMesh,
} from './environment.js';

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
    this.scene.add(buildSkyMesh(PALETTE.skyTop, PALETTE.skyHorizon));
  }

  private buildTerrain(): void {
    this.scene.add(buildTerrainMesh());
  }

  private buildWater(): void {
    this.scene.add(buildWaterMesh());
  }

  /** Kept so the shadow frustum can follow the player (see updateCamera). */
  private sun!: THREE.DirectionalLight;

  private buildLights(): void {
    const { sun, hemisphere } = buildLights();
    this.sun = sun;
    this.scene.add(sun);
    // The target must be in the scene graph for its matrix to update.
    this.scene.add(sun.target);
    this.scene.add(hemisphere);
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
}
