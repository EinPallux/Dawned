/**
 * In-world player representation: the composed character rig with a nameplate
 * and a small locomotion state machine over the UAL clips (P1-D).
 *
 * Views start as a neutral silhouette and swap to the real rig the moment the
 * shared character assets finish loading — world entry never waits on them.
 * Animation picks from speed/heading/grounded only; the server stays the sole
 * authority on movement (docs/tech/SECURITY.md).
 */

import * as THREE from 'three';
import { PLAYER_HEIGHT, PLAYER_RADIUS, type Appearance } from '@dawned/shared';
import { composeCharacter, type CharacterAssets, type ComposedCharacter } from './characters.js';

/** Locomotion tuning — thresholds sit between the shared movement speeds. */
const IDLE_BELOW_MPS = 0.6;
const SPRINT_ABOVE_MPS = 6.2; // between MOVE_SPEED (5.5) and sprint speed (7.4)
const JOG_REFERENCE_MPS = 5.5; // clip authored around jog speed; timeScale follows
const LAND_AFTER_AIR_SECONDS = 0.25;
const VELOCITY_SMOOTHING = 12; // 1/s — ~80 ms exponential window

export interface CharacterPoseFlags {
  grounded: boolean;
  sprinting: boolean;
}

export class CharacterView {
  readonly group = new THREE.Group();
  private label: THREE.Sprite;
  private labelText: string;
  private silhouette: THREE.Mesh | null;
  private composed: ComposedCharacter | null = null;
  private appearanceKey = '';

  private readonly lastPosition = new THREE.Vector3();
  private hasLastPosition = false;
  private readonly velocity = new THREE.Vector3();
  private yaw = 0;

  private airborneSeconds = 0;
  private wasGrounded = true;
  private landingUntil = 0; // mixer-time lockout while Jump_Land plays
  private clock = 0;
  private currentClip = '';

  constructor(name: string) {
    this.silhouette = new THREE.Mesh(
      new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT - PLAYER_RADIUS * 2, 4, 8),
      new THREE.MeshLambertMaterial({ color: '#3a4356', flatShading: true }),
    );
    this.silhouette.position.y = PLAYER_HEIGHT / 2;
    this.silhouette.castShadow = true;
    this.group.add(this.silhouette);

    this.labelText = name;
    this.label = makeLabelSprite(name);
    this.label.position.y = PLAYER_HEIGHT + 0.45;
    this.group.add(this.label);
  }

  /** Redraw the nameplate — a remote can appear in a snapshot before the roster. */
  setName(name: string): void {
    if (name === this.labelText) return;
    this.labelText = name;
    this.group.remove(this.label);
    this.label.material.map?.dispose();
    this.label.material.dispose();
    this.label = makeLabelSprite(name);
    this.label.position.y = PLAYER_HEIGHT + 0.45;
    this.group.add(this.label);
  }

  /** Swap in (or re-compose) the real rig. Safe to call again with new looks. */
  applyAppearance(assets: CharacterAssets, appearance: Appearance): void {
    const key = JSON.stringify(appearance);
    if (key === this.appearanceKey && this.composed) return;

    const next = composeCharacter(assets, appearance);
    if (!next) return; // assets missing — silhouette stays

    if (this.composed) {
      this.group.remove(this.composed.group);
      this.composed.dispose();
    }
    if (this.silhouette) {
      this.group.remove(this.silhouette);
      this.silhouette.geometry.dispose();
      (this.silhouette.material as THREE.Material).dispose();
      this.silhouette = null;
    }

    this.appearanceKey = key;
    this.composed = next;
    this.group.add(next.group);
    this.currentClip = '';
    this.playClip('Idle_Loop');
  }

  setPose(x: number, y: number, z: number, yaw: number): void {
    this.group.position.set(x, y, z);
    this.group.rotation.y = yaw;
    this.yaw = yaw;
  }

  /** Advance animation: derive velocity from pose history, pick a clip, mix. */
  update(dtSeconds: number, flags: CharacterPoseFlags): void {
    if (dtSeconds <= 0) return;
    this.clock += dtSeconds;

    // Velocity from position deltas — identical for the predicted local player
    // and interpolated remotes, so everyone animates from what is on screen.
    if (this.hasLastPosition) {
      const alpha = 1 - Math.exp(-dtSeconds * VELOCITY_SMOOTHING);
      this.velocity.x +=
        ((this.group.position.x - this.lastPosition.x) / dtSeconds - this.velocity.x) * alpha;
      this.velocity.z +=
        ((this.group.position.z - this.lastPosition.z) / dtSeconds - this.velocity.z) * alpha;
    }
    this.lastPosition.copy(this.group.position);
    this.hasLastPosition = true;

    if (this.composed) {
      this.selectClip(flags);
      this.composed.mixer.update(dtSeconds);
    }

    this.wasGrounded = flags.grounded;
    this.airborneSeconds = flags.grounded ? 0 : this.airborneSeconds + dtSeconds;
  }

  private selectClip(flags: CharacterPoseFlags): void {
    // Airborne: Jump_Start on takeoff, Jump_Loop while falling.
    if (!flags.grounded) {
      if (this.wasGrounded) this.playClip('Jump_Start', { once: true, fadeSeconds: 0.06 });
      else if (this.airborneSeconds > 0.3) this.playClip('Jump_Loop');
      return;
    }

    // Touch-down after real air time: brief landing animation, then carry on.
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (!this.wasGrounded && this.airborneSeconds > LAND_AFTER_AIR_SECONDS) {
      if (speed < IDLE_BELOW_MPS) {
        this.playClip('Jump_Land', { once: true, fadeSeconds: 0.08 });
        this.landingUntil = this.clock + 0.45;
        return;
      }
    }
    if (this.clock < this.landingUntil && speed < IDLE_BELOW_MPS) return;

    if (speed < IDLE_BELOW_MPS) {
      this.playClip('Idle_Loop');
      return;
    }

    // Heading in character-local space (rig faces +Z under a Y-up yaw).
    const sin = Math.sin(-this.yaw);
    const cos = Math.cos(-this.yaw);
    const localX = this.velocity.x * cos - this.velocity.z * sin;
    const localZ = this.velocity.x * sin + this.velocity.z * cos;

    let clip: string;
    if (Math.abs(localZ) >= Math.abs(localX)) {
      clip =
        localZ >= 0
          ? flags.sprinting && speed > SPRINT_ABOVE_MPS
            ? 'Sprint_Loop'
            : 'Jog_Fwd_Loop'
          : 'Jog_Bwd_Loop';
    } else {
      clip = localX >= 0 ? 'Jog_Left_Loop' : 'Jog_Right_Loop';
    }
    this.playClip(clip, { timeScale: THREE.MathUtils.clamp(speed / JOG_REFERENCE_MPS, 0.7, 1.5) });
  }

  private playClip(
    name: string,
    options: { once?: boolean; fadeSeconds?: number; timeScale?: number } = {},
  ): void {
    const composed = this.composed;
    if (!composed) return;
    if (this.currentClip === name) {
      if (options.timeScale !== undefined) composed.setTimeScale(options.timeScale);
      return;
    }
    const played = composed.play(name, {
      fadeSeconds: options.fadeSeconds ?? 0.14,
      loopOnce: options.once ?? false,
      randomizeStart: !options.once,
    });
    if (played) {
      this.currentClip = name;
      composed.setTimeScale(options.timeScale ?? 1);
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.composed?.dispose();
    if (this.silhouette) {
      this.silhouette.geometry.dispose();
      (this.silhouette.material as THREE.Material).dispose();
    }
    const labelTexture = this.label.material.map;
    if (labelTexture) labelTexture.dispose();
    this.label.material.dispose();
  }
}

/** Canvas-drawn nameplate sprite (moved from the P0 capsule view). */
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
