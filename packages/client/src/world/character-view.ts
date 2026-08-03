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

/**
 * Locomotion tuning.
 *
 * Gait selection follows the clips' NATURAL ground speeds — the speed at which
 * a cycle's feet would not slide, derived from the baked cycle durations
 * (walk 1.333 s · jog 0.933 s · sprint 0.667 s) and humanoid stride lengths.
 * timeScale = groundSpeed / naturalSpeed keeps feet planted; the run speed
 * (5.5 m/s) lands in the SPRINT gait's natural range, so plain running uses
 * Sprint_Loop at ~1.06 — the jog family covers strafes, backpedal and speed
 * transitions. (The first playtest played jog at 5.5 m/s ≈ half the leg speed
 * the ground demanded — the reported "skating".)
 */
const WALK_NAT_MPS = 1.2;
const JOG_NAT_MPS = 2.6;
const SPRINT_NAT_MPS = 5.2;
const SWIM_NAT_MPS = 2.2;
const IDLE_BELOW_MPS = 0.35;
const WALK_TO_JOG_MPS = 1.9;
/** Forward gait switches to the sprint cycle here (run 5.5 and sprint 7.4 both). */
const JOG_TO_RUN_MPS = 3.9;
const LAND_AFTER_AIR_SECONDS = 0.25;
const VELOCITY_SMOOTHING = 12; // 1/s — ~80 ms exponential window
/** Fast-turn lean (COMBAT.md §9 feel): bank into a turn, with hysteresis so the
 * clip doesn't strobe around the threshold. Enter above, exit below, rad/s. */
const LEAN_ENTER_RAD_PER_S = 1.4;
const LEAN_EXIT_RAD_PER_S = 0.7;
const YAW_RATE_SMOOTHING = 10; // 1/s
/** 8-way sector hysteresis: leave the current sector only past its edge + this. */
const SECTOR_STICKY_RAD = (8 * Math.PI) / 180;

/** Chat bubbles: visible seconds, and the fade-out tail within them. */
const BUBBLE_SECONDS = 6;
const BUBBLE_FADE_SECONDS = 0.8;

export interface CharacterPoseFlags {
  grounded: boolean;
  sprinting: boolean;
  swimming: boolean;
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
  private lastYaw = 0;
  private hasLastYaw = false;
  private yawRate = 0; // smoothed rad/s, drives the sprint lean
  private leanSide: -1 | 0 | 1 = 0;
  private headingSector = 0; // sticky 8-way sector (stickySector)

  private airborneSeconds = 0;
  private wasGrounded = true;
  private landingUntil = 0; // mixer-time lockout while Jump_Land plays
  private clock = 0;
  private currentClip = '';

  private bubble: THREE.Sprite | null = null;
  private bubbleExpiresAt = 0;

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

    // Yaw rate (same smoothing idea) — the sprint lean reads turn speed.
    if (this.hasLastYaw) {
      const alpha = 1 - Math.exp(-dtSeconds * YAW_RATE_SMOOTHING);
      this.yawRate += (wrapAngle(this.yaw - this.lastYaw) / dtSeconds - this.yawRate) * alpha;
    }
    this.lastYaw = this.yaw;
    this.hasLastYaw = true;

    if (this.composed) {
      this.selectClip(flags);
      this.composed.mixer.update(dtSeconds);
    }

    this.wasGrounded = flags.grounded;
    // Swimming is not airborne: without this reset, wading ashore after a long
    // swim would fire the hard-landing animation.
    this.airborneSeconds = flags.grounded || flags.swimming ? 0 : this.airborneSeconds + dtSeconds;

    this.updateBubble();
  }

  private selectClip(flags: CharacterPoseFlags): void {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);

    // Swimming replaces the whole grounded/airborne tree (movement pins the body
    // to the surface, so vertical state is meaningless while in water).
    if (flags.swimming) {
      if (speed < IDLE_BELOW_MPS) this.playClip('Swim_Idle_Loop');
      else
        this.playClip('Swim_Fwd_Loop', {
          timeScale: THREE.MathUtils.clamp(speed / SWIM_NAT_MPS, 0.8, 1.6),
        });
      return;
    }

    // Airborne: Jump_Start on takeoff, Jump_Loop while falling.
    if (!flags.grounded) {
      if (this.wasGrounded) this.playClip('Jump_Start', { once: true, fadeSeconds: 0.06 });
      else if (this.airborneSeconds > 0.3) this.playClip('Jump_Loop');
      return;
    }

    // Touch-down after real air time: brief landing animation, then carry on.
    if (!this.wasGrounded && this.airborneSeconds > LAND_AFTER_AIR_SECONDS) {
      if (speed < IDLE_BELOW_MPS) {
        this.playClip('Jump_Land', { once: true, fadeSeconds: 0.08 });
        this.landingUntil = this.clock + 0.45;
        return;
      }
    }
    if (this.clock < this.landingUntil && speed < IDLE_BELOW_MPS) return;

    if (speed < IDLE_BELOW_MPS) {
      this.leanSide = 0;
      this.headingSector = 0;
      this.playClip('Idle_Loop');
      return;
    }

    // Heading in character-local space (rig faces +Z under a Y-up yaw).
    const sin = Math.sin(-this.yaw);
    const cos = Math.cos(-this.yaw);
    const localX = this.velocity.x * cos - this.velocity.z * sin;
    const localZ = this.velocity.x * sin + this.velocity.z * cos;
    const heading = Math.atan2(localX, localZ); // 0 = fwd, ±π = bwd
    const sector = this.stickySector(heading);
    const forward = sector === 0;

    // Fast forward movement = the sprint gait (run and sprint both — see the
    // natural-speed table above), banking into hard turns.
    //
    // CLIP NAMING NOTE: the UAL pack's L/R suffixes are from the VIEWER'S side,
    // not the character's — established in playtesting (P1-D "looked right"
    // under the then-mirrored strafe input; with the input fixed, the raw names
    // read crossed). Character-left motion therefore plays the "R"-named clips
    // throughout, and a left turn banks with LeanR.
    if (forward && speed >= JOG_TO_RUN_MPS) {
      if (this.leanSide === 0) {
        if (Math.abs(this.yawRate) > LEAN_ENTER_RAD_PER_S)
          this.leanSide = this.yawRate > 0 ? 1 : -1;
      } else if (Math.abs(this.yawRate) < LEAN_EXIT_RAD_PER_S) {
        this.leanSide = 0;
      } else {
        this.leanSide = this.yawRate > 0 ? 1 : -1;
      }
      if (this.leanSide !== 0) {
        // leanSide +1 = turning character-left → viewer-named "R" clip.
        // Lean clips are jog-family — cap the scale, the moment is transient.
        this.playClip(this.leanSide > 0 ? 'Jog_Fwd_LeanR_Loop' : 'Jog_Fwd_LeanL_Loop', {
          timeScale: THREE.MathUtils.clamp(speed / JOG_NAT_MPS, 0.8, 1.6),
        });
        return;
      }
      this.playClip('Sprint_Loop', {
        timeScale: THREE.MathUtils.clamp(speed / SPRINT_NAT_MPS, 0.7, 1.5),
      });
      return;
    }
    this.leanSide = 0;

    // Walking band (spawns, decel tails, analog speeds): a real walk cycle
    // instead of a slow-motion jog.
    if (speed < WALK_TO_JOG_MPS) {
      this.playClip('Walk_Loop', {
        timeScale: THREE.MathUtils.clamp(speed / WALK_NAT_MPS, 0.7, 1.5),
      });
      return;
    }

    // 8-way jog: strafes, backpedal, diagonals and forward transition speeds.
    // Positive heading = character-LEFT motion → viewer-named "R" clips (see
    // the naming note above).
    const SECTOR_CLIPS = [
      'Jog_Fwd_Loop', //      0: fwd
      'Jog_Fwd_R_Loop', //    1: fwd-left  (viewer-named R)
      'Jog_Right_Loop', //    2: left      (viewer-named Right)
      'Jog_Bwd_R_Loop', //    3: bwd-left
      'Jog_Bwd_Loop', //      4: bwd
      'Jog_Bwd_L_Loop', //    5: bwd-right
      'Jog_Left_Loop', //     6: right     (viewer-named Left)
      'Jog_Fwd_L_Loop', //    7: fwd-right
    ] as const;
    this.playClip(SECTOR_CLIPS[sector]!, {
      timeScale: THREE.MathUtils.clamp(speed / JOG_NAT_MPS, 0.7, 1.6),
    });
  }

  /**
   * Quantize a local heading into one of 8 sectors, sticky at the borders:
   * the current sector holds until the heading leaves it by SECTOR_STICKY_RAD,
   * so a diagonal held near 45° never flickers between two clips.
   */
  private stickySector(heading: number): number {
    const currentCenter = (this.headingSector * Math.PI) / 4;
    const offset = wrapAngle(heading - currentCenter);
    if (Math.abs(offset) > Math.PI / 8 + SECTOR_STICKY_RAD) {
      this.headingSector = Math.round(heading / (Math.PI / 4)) & 7;
    }
    return this.headingSector;
  }

  /** Active animation clip — read by the smoke tests via window.__dawned. */
  get clipName(): string {
    return this.currentClip;
  }

  /** True while a chat bubble is on screen (smoke-test observability). */
  get hasBubble(): boolean {
    return this.bubble !== null;
  }

  /** Show a chat bubble above the head; replaces any current one. */
  showBubble(text: string): void {
    this.clearBubble();
    const sprite = makeBubbleSprite(text);
    sprite.position.y = PLAYER_HEIGHT + 1.0;
    this.group.add(sprite);
    this.bubble = sprite;
    this.bubbleExpiresAt = this.clock + BUBBLE_SECONDS;
  }

  private updateBubble(): void {
    if (!this.bubble) return;
    const remaining = this.bubbleExpiresAt - this.clock;
    if (remaining <= 0) {
      this.clearBubble();
      return;
    }
    this.bubble.material.opacity = Math.min(1, remaining / BUBBLE_FADE_SECONDS);
  }

  private clearBubble(): void {
    if (!this.bubble) return;
    this.group.remove(this.bubble);
    this.bubble.material.map?.dispose();
    this.bubble.material.dispose();
    this.bubble = null;
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
      // Gait → gait keeps the foot phase (a direction change mid-stride must
      // not restart the cycle — that pop read as "broken walking"). Idles
      // start at a random phase so crowds don't move in lockstep.
      carryPhase: GAIT_CLIPS.has(this.currentClip) && GAIT_CLIPS.has(name),
      randomizeStart: IDLE_CLIPS.has(name),
    });
    if (played) {
      this.currentClip = name;
      composed.setTimeScale(options.timeScale ?? 1);
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.clearBubble();
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

/** Locomotion cycles that share a two-step gait — phase carries across these. */
const GAIT_CLIPS = new Set([
  'Walk_Loop',
  'Jog_Fwd_Loop',
  'Jog_Bwd_Loop',
  'Jog_Left_Loop',
  'Jog_Right_Loop',
  'Jog_Fwd_L_Loop',
  'Jog_Fwd_R_Loop',
  'Jog_Bwd_L_Loop',
  'Jog_Bwd_R_Loop',
  'Jog_Fwd_LeanL_Loop',
  'Jog_Fwd_LeanR_Loop',
  'Sprint_Loop',
]);

/** Clips whose start phase is randomized (desynced crowds, no lockstep idling). */
const IDLE_CLIPS = new Set(['Idle_Loop', 'Swim_Idle_Loop']);

/** Shortest-path angle wrap into (−π, π] — yaw deltas must not jump at ±π. */
const wrapAngle = (angle: number): number => {
  let a = angle % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
};

/**
 * Canvas-drawn chat bubble in the "Cut Facets" language (UI_UX.md §2): dark
 * panel with cut corners and a bottom notch, never a rounded blob. Wraps to at
 * most three lines and ellipsizes the rest (full text stays in the chat log).
 */
const makeBubbleSprite = (text: string): THREE.Sprite => {
  const font = '500 26px system-ui, sans-serif';
  const padX = 22;
  const padY = 14;
  const lineHeight = 34;
  const maxLineWidth = 420;
  const maxLines = 3;
  const cut = 12; // corner facet size
  const notch = 12; // bottom center pointer

  const measure = document.createElement('canvas').getContext('2d');
  const widthOf = (value: string): number =>
    measure ? measure.measureText(value).width : value.length * 13;
  if (measure) measure.font = font;

  // Greedy word wrap; a single overlong word is hard-cut so it can't overflow.
  const lines: string[] = [];
  let current = '';
  let truncated = false;
  for (const word of text.split(/\s+/)) {
    if (lines.length === maxLines) {
      truncated = true;
      break;
    }
    let piece = word;
    while (widthOf(piece) > maxLineWidth) piece = piece.slice(0, -1);
    const joined = current === '' ? piece : `${current} ${piece}`;
    if (widthOf(joined) <= maxLineWidth) {
      current = joined;
    } else {
      lines.push(current);
      current = piece;
    }
  }
  if (current !== '' && lines.length < maxLines) lines.push(current);
  else if (current !== '' && lines.length === maxLines) truncated = true;
  if (truncated && lines.length > 0) {
    lines[lines.length - 1] = `${(lines[lines.length - 1] ?? '').replace(/.{0,2}$/, '')}…`;
  }

  const textWidth = Math.max(40, ...lines.map(widthOf));
  const width = Math.ceil(textWidth + padX * 2);
  const height = lines.length * lineHeight + padY * 2 + notch;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const bodyBottom = height - notch;
    ctx.beginPath();
    ctx.moveTo(cut, 0);
    ctx.lineTo(width - cut, 0);
    ctx.lineTo(width, cut);
    ctx.lineTo(width, bodyBottom - cut);
    ctx.lineTo(width - cut, bodyBottom);
    ctx.lineTo(width / 2 + notch, bodyBottom);
    ctx.lineTo(width / 2, height);
    ctx.lineTo(width / 2 - notch, bodyBottom);
    ctx.lineTo(cut, bodyBottom);
    ctx.lineTo(0, bodyBottom - cut);
    ctx.lineTo(0, cut);
    ctx.closePath();
    ctx.fillStyle = 'rgba(21, 26, 38, 0.9)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(237, 230, 212, 0.28)';
    ctx.stroke();

    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ede6d4';
    lines.forEach((line, index) => {
      ctx.fillText(line, width / 2, padY + lineHeight * (index + 0.5));
    });
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true }),
  );
  const worldHeight = (height / 96) * 0.55; // scale with line count, readable at range
  sprite.scale.set((width / height) * worldHeight, worldHeight, 1);
  sprite.center.set(0.5, 0); // anchor at the notch tip so it grows upward
  return sprite;
};

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
