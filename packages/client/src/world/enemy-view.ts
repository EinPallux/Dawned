/**
 * Enemy rendering (P4): baked Quaternius rigs driven by snapshot flags and
 * combat events. Enemies are pure puppets — every state they display arrived
 * from the server (NPCS_ENEMIES.md; the client simulates nothing).
 *
 * Clip names live in content rows (ability clips) and per-model logical maps
 * below (locomotion/reaction clips are model-intrinsic, not per-ability data).
 */

import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EntityFlag, type EnemyDef, type EnemyMetaEntry } from '@dawned/shared';

interface ClipSet {
  idle: string;
  move: string;
  hit: string;
  death: string;
  alert: string;
}

const armature = (name: string): string => `CharacterArmature|${name}`;

/**
 * The Quaternius monster bundle rigs its models in exactly three families, and
 * their clip names are NOT interchangeable — a walker has `Idle`/`Walk` where
 * a floater has `Flying_Idle`/`Fast_Flying`, and the two spell the hit react
 * differently (`HitRecieve` vs `HitReact` — the pack misspells one of them).
 * Naming the families once beats fifteen near-identical literals and makes the
 * mismatch impossible to introduce by copy-paste.
 *
 * Verified by reading the baked glTF animation lists, not by assumption.
 */
const WALKER: ClipSet = {
  idle: armature('Idle'),
  move: armature('Walk'),
  hit: armature('HitRecieve'), // (sic — the pack misspells it in this family)
  death: armature('Death'),
  alert: armature('No'),
};

/** Floaters (glub, bees, ghosts): no Idle and no Walk exist on these rigs. */
const FLOATER: ClipSet = {
  idle: armature('Flying_Idle'),
  move: armature('Fast_Flying'),
  hit: armature('HitReact'),
  death: armature('Death'),
  alert: armature('No'),
};

/** The richest family (frog, orc, mushroom king): real Run + Weapon clips. */
const HUMANOID: ClipSet = {
  idle: armature('Idle'),
  move: armature('Run'),
  hit: armature('HitReact'),
  death: armature('Death'),
  alert: armature('No'),
};

/** Logical → actual clip names per baked model (verified against the bakes). */
const MODEL_CLIPS: Record<string, ClipSet> = {
  // Dawnshore
  enemies_glub: FLOATER,
  enemies_mushnub: WALKER,
  enemies_green_blob: WALKER,
  enemies_pink_blob: WALKER,
  enemies_pigeon: WALKER,
  enemies_orc: HUMANOID,
  enemies_glub_evolved: FLOATER,
  // Verdant Weald
  enemies_frog: HUMANOID,
  enemies_mushnub_evolved: WALKER,
  enemies_armabee: FLOATER,
  enemies_armabee_evolved: FLOATER,
  enemies_ghost: FLOATER,
  enemies_cat: WALKER,
  enemies_wizard: WALKER,
  enemies_mushroom_king: HUMANOID,
  // skeleton_minion is baked but unmapped until something places it — an
  // unmapped model renders statically rather than guessing clip names
  // unverified.
};

interface ManifestAsset {
  id: string;
  file: string;
}
interface Manifest {
  assets: Record<string, ManifestAsset>;
}

export interface EnemyAssets {
  models: Map<string, GLTF>;
  ok: boolean;
}

let enemyAssetsPromise: Promise<EnemyAssets> | null = null;

/** Load (once) every baked enemy model the manifest carries. Never rejects. */
export const loadEnemyAssets = (): Promise<EnemyAssets> => {
  enemyAssetsPromise ??= loadAll();
  return enemyAssetsPromise;
};

const loadAll = async (): Promise<EnemyAssets> => {
  const result: EnemyAssets = { models: new Map(), ok: false };
  let manifest: Manifest;
  try {
    manifest = (await (await fetch('/assets/manifest.json')).json()) as Manifest;
  } catch {
    console.warn('[enemies] no asset manifest — enemies degrade to silhouettes');
    return result;
  }
  const loader = new GLTFLoader();
  const loads: Promise<void>[] = [];
  for (const [id, entry] of Object.entries(manifest.assets)) {
    if (!id.startsWith('enemies_')) continue;
    loads.push(
      loader
        .loadAsync(`/${entry.file}`)
        .then((gltf) => {
          result.models.set(id, gltf);
        })
        .catch((error: unknown) => {
          console.warn(`[enemies] failed to load ${id}:`, error);
        }),
    );
  }
  await Promise.all(loads);
  result.ok = result.models.size > 0;
  return result;
};

/**
 * Rank treatment on the nameplate (§1). An elite is 2.5× HP and a boss 8×, so
 * "is this the same thing I just killed" has to be answerable at a glance,
 * before committing. Size does half the job; the plate does the rest — a
 * tinted name plus one drawn mark per rank tier.
 */
const RANK_TINT: Record<string, string> = {
  normal: '#f0b7a8',
  elite: '#e8c979',
  zone_boss: '#f0a53a',
  world_boss: '#ff8a3a',
};

/** How many marks a rank draws beside its name (0 = plain trash mob). */
const RANK_MARKS: Record<string, number> = {
  normal: 0,
  elite: 1,
  zone_boss: 1,
  world_boss: 2,
};

/**
 * The rank mark is DRAWN, not typed. It started life as the characters ◆ and
 * ★, and in a headless Chromium with no font carrying them it rendered as
 * nothing at all — an elite whose only tell is its plate came up looking like
 * a trash mob. A canvas path cannot go missing on someone else's machine, and
 * it looks the same everywhere, which is the entire point of a tell.
 */
const drawRankMark = (
  ctx: CanvasRenderingContext2D,
  rank: string,
  x: number,
  y: number,
  r: number,
): void => {
  ctx.beginPath();
  if (rank === 'elite') {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r * 0.72, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r * 0.72, y);
  } else {
    // Five-point star: outer points every 72°, inner waist at 42% radius.
    for (let i = 0; i < 10; i++) {
      const radius = i % 2 === 0 ? r : r * 0.42;
      const angle = -Math.PI / 2 + (i * Math.PI) / 5;
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  }
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
};

/** Seconds the corpse plays death + desaturates before sinking away. */
const DEATH_SINK_AFTER_S = 3.5;
const DEATH_SINK_SPEED = 0.6; // m/s downward
const FLASH_SECONDS = 0.08;

export class EnemyView {
  readonly group = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current = '';
  private silhouette: THREE.Mesh | null = null;
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly baseColors: THREE.Color[] = [];

  private label: THREE.Sprite | null = null;
  private hpBar: THREE.Sprite | null = null;
  private hpBarCtx: CanvasRenderingContext2D | null = null;
  private hpShown = -1;
  /** Cast bar (P9 Casters) — built lazily; most enemies never cast. */
  private castBar: THREE.Sprite | null = null;
  private castBarCtx: CanvasRenderingContext2D | null = null;
  private castEndsAt = 0;
  private castTotal = 1;
  private castBrokenUntil = 0;
  /** Absorb bubble while a `self_shield` is live (null = none). */
  private shieldMesh: THREE.Mesh | null = null;

  private flashLeft = 0;
  private deadFor = -1; // <0 = alive; ≥0 = seconds since death started
  private oneShotUntil = 0;
  private clock = 0;
  private speedEma = 0;

  constructor(
    readonly id: number,
    private readonly meta: EnemyMetaEntry,
    private readonly def: EnemyDef | undefined,
    assets: EnemyAssets,
  ) {
    const source = assets.models.get(meta.modelRef);
    if (source) {
      const clone = skeletonClone(source.scene);
      clone.scale.setScalar(meta.scale);
      clone.traverse((child: THREE.Object3D) => {
        if (child instanceof THREE.Mesh) {
          child.castShadow = true;
          // Clone materials so flash/desaturate never leak across instances.
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          const cloned = materials.map((m) => (m as THREE.MeshStandardMaterial).clone());
          child.material = Array.isArray(child.material) ? cloned : cloned[0]!;
          for (const material of cloned) {
            this.materials.push(material);
            this.baseColors.push(material.color.clone());
          }
        }
      });
      this.group.add(clone);
      this.mixer = new THREE.AnimationMixer(clone);
      for (const clip of source.animations) {
        this.actions.set(clip.name, this.mixer.clipAction(clip));
      }
      this.play(this.clipFor('idle'), { randomizePhase: true });
    } else {
      this.silhouette = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.45, 0.6, 4, 8),
        new THREE.MeshLambertMaterial({ color: '#5a4356', flatShading: true }),
      );
      this.silhouette.position.y = 0.8;
      this.group.add(this.silhouette);
    }

    this.buildPlates();
  }

  private clipFor(kind: 'idle' | 'move' | 'hit' | 'death' | 'alert'): string {
    return MODEL_CLIPS[this.meta.modelRef]?.[kind] ?? '';
  }

  /** Active clip + mixer truth (smoke tests catch silently-missing clips). */
  get animDebug(): { clip: string; time: number; running: boolean; actions: number } {
    const action = this.actions.get(this.current);
    return {
      clip: this.current,
      time: action?.time ?? -1,
      running: action?.isRunning() ?? false,
      actions: this.actions.size,
    };
  }

  /** Ability ordinal → content clip name (AbilityStart events carry ordinals). */
  clipForAbility(ordinal: number): string {
    const ability = this.def?.abilities[ordinal];
    return ability ? `CharacterArmature|${ability.clip}` : '';
  }

  /**
   * Nameplate canvas. 384 and not 256: at 256 the plate silently CLIPPED every
   * name past ~17 characters, centre-aligned so it ate both ends — "Weald
   * Stalker · 11" rendered as "Weald Stalker · 1" and "★ Mushroom King · 12"
   * (344 px) lost its star and its level. Found by reading a P9 screenshot.
   */
  private static readonly PLATE_W = 384;
  private static readonly PLATE_H = 56;

  private buildPlates(): void {
    const height = 0.55;
    const canvas = document.createElement('canvas');
    canvas.width = EnemyView.PLATE_W;
    canvas.height = EnemyView.PLATE_H;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(21,26,38,0.92)';
      // Rank has to read BEFORE the fight starts — walking into an elite by
      // accident is the difference between a fight and a corpse run (§1: a
      // named plate is the elite's whole tell, along with its size).
      const marks = RANK_MARKS[this.meta.rank] ?? 0;
      const text = `${this.meta.name}  ·  ${this.meta.level}`;
      const tint = RANK_TINT[this.meta.rank] ?? '#f0b7a8';
      // Shrink-to-fit on top of the wider canvas, so a long content name can
      // never reintroduce the clip: the plate adapts, the text is never cut.
      const cx = EnemyView.PLATE_W / 2;
      const cy = EnemyView.PLATE_H / 2;
      const markSpan = marks * 22;
      const maxWidth = EnemyView.PLATE_W - 12 - markSpan * 2;
      let size = 26;
      ctx.font = `bold ${size}px system-ui, sans-serif`;
      while (size > 15 && ctx.measureText(text).width > maxWidth) {
        size -= 1;
        ctx.font = `bold ${size}px system-ui, sans-serif`;
      }
      // Marks sit LEFT of the name; shift the text right by half their span so
      // the whole plate stays optically centred over the enemy.
      const textX = cx + markSpan / 2;
      ctx.strokeText(text, textX, cy, maxWidth);
      ctx.fillStyle = tint;
      ctx.fillText(text, textX, cy, maxWidth);
      const textLeft = textX - ctx.measureText(text).width / 2;
      for (let i = 0; i < marks; i++) {
        drawRankMark(ctx, this.meta.rank, textLeft - 12 - i * 22, cy, 9);
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.label = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true }),
    );
    // Aspect must follow the canvas or the text stretches — widening the
    // canvas widens the plate in world space, it does not fatten the glyphs.
    this.label.scale.set((EnemyView.PLATE_W / EnemyView.PLATE_H) * height * 0.6, height * 0.6, 1);
    this.label.position.y = this.plateHeight() + 0.45;
    this.group.add(this.label);

    const barCanvas = document.createElement('canvas');
    barCanvas.width = 128;
    barCanvas.height = 14;
    this.hpBarCtx = barCanvas.getContext('2d');
    const barTexture = new THREE.CanvasTexture(barCanvas);
    this.hpBar = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: barTexture, transparent: true, depthTest: true }),
    );
    this.hpBar.scale.set(1.1, 0.12, 1);
    this.hpBar.position.y = this.plateHeight() + 0.22;
    this.group.add(this.hpBar);
    this.drawHp(1);
  }

  private plateHeight(): number {
    return (this.def?.hitHeight ?? 1.3) * this.meta.scale + 0.3;
  }

  private drawHp(fraction: number): void {
    const ctx = this.hpBarCtx;
    if (!ctx || !this.hpBar) return;
    const clamped = Math.max(0, Math.min(1, fraction));
    if (Math.abs(clamped - this.hpShown) < 0.004) return;
    this.hpShown = clamped;
    ctx.clearRect(0, 0, 128, 14);
    // Cut-facet slab: hairline border, hard corners, no rounded blobs.
    ctx.fillStyle = 'rgba(21,26,38,0.85)';
    ctx.fillRect(0, 0, 128, 14);
    ctx.strokeStyle = 'rgba(237,230,212,0.4)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, 126, 12);
    ctx.fillStyle = clamped > 0.35 ? '#b8433a' : '#e0763a';
    ctx.fillRect(3, 3, 122 * clamped, 8);
    (this.hpBar.material.map as THREE.CanvasTexture).needsUpdate = true;
  }

  /** Server said this enemy took a hit — flash tint (COMBAT.md §9). */
  flash(): void {
    this.flashLeft = FLASH_SECONDS;
  }

  /** Play the model's hit-react (stagger events; light flinches skip it). */
  playHitReact(): void {
    const clip = this.clipFor('hit');
    if (clip) this.playOnce(clip);
  }

  playAlert(): void {
    const clip = this.clipFor('alert');
    if (clip) this.playOnce(clip);
  }

  /**
   * Ability swing from AbilityStart. The clip is scaled across wind-up AND
   * recover (from the content def) so the motion flows through contact and
   * settles — scaled to the wind-up alone it clamps on its last frame and the
   * enemy freezes mid-lunge for the whole recover (first camp playtest).
   */
  playAbility(ordinal: number, durationMs: number, cast = false): void {
    // A CAST is the Caster archetype's counterplay made visible: a bar the
    // player can watch drain and decide to interrupt. Without it the wind-up
    // is just an animation and the interrupt window may as well not exist.
    if (cast) this.beginCast(durationMs);
    const name = this.clipForAbility(ordinal);
    const action = this.actions.get(name);
    if (!action) return;
    const spec = this.def?.abilities[ordinal];
    const totalMs = spec ? spec.windupMs + spec.recoverMs : durationMs;
    const native = action.getClip().duration;
    this.playOnce(name, native / Math.max(totalMs / 1000, 0.15));
  }

  /**
   * A cast bar is DRAWN over this enemy right now. Deliberately the sprite's
   * own visibility and not just the timer: the P9 probe asserts on this, and
   * "the timer is running" would still pass if the bar never rendered.
   */
  get isCasting(): boolean {
    return this.castEndsAt > this.clock && this.castBar?.visible === true;
  }

  /** Start the cast bar; `update` drains it and hides it when it empties. */
  private beginCast(durationMs: number): void {
    this.castEndsAt = this.clock + durationMs / 1000;
    this.castTotal = Math.max(0.1, durationMs / 1000);
    if (!this.castBar) this.buildCastBar();
    if (this.castBar) this.castBar.visible = true;
  }

  /**
   * A `self_shield` absorb is up (P9). Without this the fight lies: a shielded
   * elite eats a full burst and its HP bar simply stops, with nothing on
   * screen saying why. The bubble is the same read players get from Aegis.
   */
  setShielded(shielded: boolean): void {
    if (shielded === (this.shieldMesh !== null)) return;
    if (!shielded) {
      if (this.shieldMesh) {
        this.group.remove(this.shieldMesh);
        this.shieldMesh.geometry.dispose();
        (this.shieldMesh.material as THREE.Material).dispose();
        this.shieldMesh = null;
      }
      return;
    }
    const radius = Math.max(0.6, (this.def?.hitRadius ?? 0.5) * this.meta.scale * 1.5);
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(radius, 1),
      new THREE.MeshBasicMaterial({
        color: 0x9fd8c8,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    mesh.position.y = this.plateHeight() * 0.5;
    mesh.scale.y = 1.2;
    this.group.add(mesh);
    this.shieldMesh = mesh;
  }

  /** An interrupt landed: shatter the bar rather than letting it fade out. */
  breakCast(): void {
    if (this.castEndsAt <= 0) return;
    this.castEndsAt = 0;
    this.drawCast(0, true);
    // Leave the broken bar up for a beat — the player earned the feedback.
    this.castBrokenUntil = this.clock + 0.5;
  }

  private buildCastBar(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 12;
    this.castBarCtx = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    this.castBar = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true }),
    );
    this.castBar.scale.set(1.2, 0.11, 1);
    this.castBar.position.y = this.plateHeight() + 0.72;
    this.castBar.visible = false;
    this.group.add(this.castBar);
  }

  private drawCast(fraction: number, broken = false): void {
    const ctx = this.castBarCtx;
    if (!ctx || !this.castBar) return;
    ctx.clearRect(0, 0, 128, 12);
    ctx.fillStyle = 'rgba(21,26,38,0.85)';
    ctx.fillRect(0, 0, 128, 12);
    ctx.fillStyle = broken ? '#d8453a' : '#c9a34e';
    ctx.fillRect(1, 1, Math.max(0, Math.min(1, fraction)) * 126, 10);
    ctx.strokeStyle = 'rgba(240,242,246,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, 127, 11);
    const map = this.castBar.material.map;
    if (map) map.needsUpdate = true;
  }

  /** Advance the cast bar. Called from `update` so it rides the render clock. */
  private tickCast(): void {
    if (!this.castBar) return;
    if (this.castBrokenUntil > this.clock) return; // holding the shattered bar
    if (this.castEndsAt <= 0) {
      if (this.castBar.visible) this.castBar.visible = false;
      return;
    }
    const left = this.castEndsAt - this.clock;
    if (left <= 0) {
      this.castEndsAt = 0;
      this.castBar.visible = false;
      return;
    }
    this.drawCast(1 - left / this.castTotal);
  }

  beginDeath(): void {
    if (this.deadFor >= 0) return;
    this.deadFor = 0;
    const clip = this.clipFor('death');
    if (clip) this.play(clip, { once: true });
    // Desaturate toward ash (COMBAT.md §9 death treatment).
    for (let i = 0; i < this.materials.length; i++) {
      const grey = this.baseColors[i]!.clone();
      const l = 0.35 + 0.3 * ((grey.r + grey.g + grey.b) / 3);
      this.materials[i]!.color.setRGB(l, l, l * 0.95);
    }
    if (this.label) this.label.visible = false;
    if (this.hpBar) this.hpBar.visible = false;
    if (this.castBar) this.castBar.visible = false;
    this.castEndsAt = 0;
    this.setShielded(false); // a corpse holds no absorb
  }

  private playOnce(name: string, timeScale = 1): void {
    const action = this.actions.get(name);
    if (!action || !this.mixer) return;
    this.play(name, { once: true, timeScale });
    this.oneShotUntil = this.clock + action.getClip().duration / timeScale;
  }

  private play(
    name: string,
    options: { once?: boolean; timeScale?: number; randomizePhase?: boolean } = {},
  ): void {
    const action = this.actions.get(name);
    if (!action) return;
    // Loops dedupe; one-shots must re-trigger (repeat Headbutts with no idle
    // interleave held a finished action = a frozen glub).
    if (this.current === name && !options.once) return;
    const previous = this.current === name ? null : this.actions.get(this.current);
    action.reset();
    action.enabled = true;
    action.setEffectiveWeight(1);
    action.setLoop(options.once ? THREE.LoopOnce : THREE.LoopRepeat, options.once ? 1 : Infinity);
    action.clampWhenFinished = options.once ?? false;
    action.timeScale = options.timeScale ?? 1;
    if (options.randomizePhase) action.time = Math.random() * action.getClip().duration;
    if (previous && previous.isRunning()) {
      // Live source → real crossfade.
      action.play();
      previous.crossFadeTo(action, 0.15, false);
    } else {
      // Finished one-shots can't drive a fade (weight ramp never runs — the
      // rig freezes); cut them and fade the new clip in.
      previous?.stop();
      action.fadeIn(0.1).play();
    }
    this.current = name;
  }

  /** Per-frame: locomotion from render velocity, flash decay, death sink. */
  update(
    dt: number,
    render: { x: number; y: number; z: number; yaw: number; flags: number; hpFraction: number },
    lastPos: { x: number; z: number },
  ): void {
    this.clock += dt;
    this.group.position.set(render.x, render.y, render.z);
    this.group.rotation.y = render.yaw;
    this.tickCast();

    const dead = (render.flags & EntityFlag.Dead) !== 0;
    if (dead) this.beginDeath();

    if (this.deadFor >= 0) {
      this.deadFor += dt;
      if (this.deadFor > DEATH_SINK_AFTER_S) {
        this.group.position.y -= (this.deadFor - DEATH_SINK_AFTER_S) * DEATH_SINK_SPEED;
      }
      this.mixer?.update(dt);
      return;
    }

    this.drawHp(render.hpFraction);

    // Flash tint decay.
    if (this.flashLeft > 0) {
      this.flashLeft -= dt;
      const on = this.flashLeft > 0;
      for (let i = 0; i < this.materials.length; i++) {
        if (on) this.materials[i]!.color.setRGB(1, 1, 1);
        else this.materials[i]!.color.copy(this.baseColors[i]!);
      }
    }

    // Locomotion when no one-shot (ability/hit/alert) is playing.
    const speed = Math.hypot(render.x - lastPos.x, render.z - lastPos.z) / Math.max(dt, 1e-4);
    this.speedEma += (speed - this.speedEma) * Math.min(1, dt * 10);
    if (this.clock >= this.oneShotUntil) {
      const leashing = (render.flags & EntityFlag.Leashing) !== 0;
      const moveClip = this.clipFor('move');
      const idleClip = this.clipFor('idle');
      if (this.speedEma > 0.4 && moveClip) {
        this.play(moveClip);
        const action = this.actions.get(moveClip);
        if (action) action.timeScale = leashing ? 1.5 : 1;
      } else if (idleClip) {
        this.play(idleClip);
      }
    }

    this.mixer?.update(dt);
    lastPos.x = render.x;
    lastPos.z = render.z;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    for (const material of this.materials) material.dispose();
    if (this.silhouette) {
      this.silhouette.geometry.dispose();
      (this.silhouette.material as THREE.Material).dispose();
    }
    this.label?.material.map?.dispose();
    this.label?.material.dispose();
    this.hpBar?.material.map?.dispose();
    this.hpBar?.material.dispose();
    this.castBar?.material.map?.dispose();
    this.castBar?.material.dispose();
    if (this.shieldMesh) {
      this.shieldMesh.geometry.dispose();
      (this.shieldMesh.material as THREE.Material).dispose();
    }
  }
}
