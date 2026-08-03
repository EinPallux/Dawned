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

  /** Eased FOV widening while sprinting (COMBAT.md §9 "speed reads on screen"). */
  private fovBoost = 0;
  setSprintBoost(active: boolean, dtSeconds: number): void {
    const target = active ? 6 : 0;
    const eased = this.fovBoost + (target - this.fovBoost) * Math.min(1, dtSeconds * 9);
    if (Math.abs(eased - this.fovBoost) < 0.001) return;
    this.fovBoost = eased;
    this.camera.fov = 70 + this.fovBoost;
    this.camera.updateProjectionMatrix();
  }

  // --- combat camera juice (COMBAT.md §9): directional kick on dealing, ---
  // capped shake on receiving. Global intensity slider hook for settings.
  private kick = { x: 0, y: 0 };
  private shakeLeft = 0;
  private shakeStrength = 0;
  /** 0..1 — the "never nauseating" global slider (UI arrives with Settings). */
  juiceIntensity = 1;

  /** Small directional impulse when the player LANDS a heavy hit. */
  addKick(directionYaw: number, strength = 1): void {
    const s = 0.045 * strength * this.juiceIntensity;
    this.kick.x += Math.sin(directionYaw) * s;
    this.kick.y += 0.02 * strength * this.juiceIntensity;
  }

  /** Brief camera shake when the player TAKES a hit — hard-capped. */
  addShake(strength = 1): void {
    this.shakeLeft = 0.18;
    this.shakeStrength = Math.min(0.09, 0.05 * strength) * this.juiceIntensity;
  }

  /**
   * Third-person orbit camera behind the player (mouselook, Q1 decision),
   * offset over the RIGHT shoulder: the whole rig — eye and aim point — shifts
   * screen-right and up, so the center-screen reticle floats beside the head
   * instead of drilling into the character's back (owner playtest round 6).
   * Attacks aim by yaw (parallel to the camera axis); at combat ranges the
   * offset's angular error is inside the soft-target magnetism.
   */
  updateCamera(
    target: { x: number; y: number; z: number },
    yaw: number,
    pitch: number,
    dtSeconds = 0,
  ): void {
    // The shadow frustum is a ±70 m box — anchor it to the player, or shadows
    // silently vanish the moment they walk away from the world origin.
    this.sun.position.set(target.x + 60, target.y + 90, target.z + 40);
    this.sun.target.position.set(target.x, target.y, target.z);

    // Screen-right at this yaw is (−cos yaw, sin yaw) — see input.ts.
    const shoulder = 0.45;
    const aimX = target.x + -Math.cos(yaw) * shoulder;
    const aimZ = target.z + Math.sin(yaw) * shoulder;
    const aimY = target.y + 1.5;

    const distance = 6.5;
    const horizontal = Math.cos(pitch) * distance;
    this.camera.position.set(
      aimX - Math.sin(yaw) * horizontal,
      target.y + 1.6 + Math.sin(pitch) * distance,
      aimZ - Math.cos(yaw) * horizontal,
    );

    // Decay the kick fast; the shake is jittered noise inside its window.
    const decay = Math.exp(-dtSeconds * 14);
    this.kick.x *= decay;
    this.kick.y *= decay;
    let shakeX = 0;
    let shakeY = 0;
    if (this.shakeLeft > 0) {
      this.shakeLeft -= dtSeconds;
      const falloff = Math.max(0, this.shakeLeft / 0.18);
      shakeX = (Math.random() * 2 - 1) * this.shakeStrength * falloff;
      shakeY = (Math.random() * 2 - 1) * this.shakeStrength * falloff;
    }
    this.camera.position.x += this.kick.x + shakeX;
    this.camera.position.y += this.kick.y + shakeY;

    this.camera.lookAt(aimX, aimY, aimZ);
    this.sky.position.copy(this.camera.position);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
