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

/** Logical → actual clip names per baked model (verified against the bakes). */
const MODEL_CLIPS: Record<
  string,
  { idle: string; move: string; hit: string; death: string; alert: string }
> = {
  enemies_glub: {
    idle: 'CharacterArmature|Flying_Idle',
    move: 'CharacterArmature|Fast_Flying',
    hit: 'CharacterArmature|HitReact',
    death: 'CharacterArmature|Death',
    alert: 'CharacterArmature|No',
  },
  enemies_mushnub: {
    idle: 'CharacterArmature|Idle',
    move: 'CharacterArmature|Walk',
    hit: 'CharacterArmature|HitRecieve', // (sic — the pack misspells it)
    death: 'CharacterArmature|Death',
    alert: 'CharacterArmature|No',
  },
  // skeleton_minion is baked but unmapped until P9 places it — an unmapped
  // model renders statically rather than guessing clip names unverified.
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

  /** Ability ordinal → content clip name (AbilityStart events carry ordinals). */
  clipForAbility(ordinal: number): string {
    const ability = this.def?.abilities[ordinal];
    return ability ? `CharacterArmature|${ability.clip}` : '';
  }

  private buildPlates(): void {
    const height = 0.55;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 56;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.font = 'bold 26px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(21,26,38,0.92)';
      const text = `${this.meta.name}  ·  ${this.meta.level}`;
      ctx.strokeText(text, 128, 28);
      ctx.fillStyle = '#f0b7a8'; // hostile tint, Cut Facets palette adjacent
      ctx.fillText(text, 128, 28);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.label = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true }),
    );
    this.label.scale.set((256 / 56) * height * 0.6, height * 0.6, 1);
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

  /** Ability wind-up from AbilityStart: scale the clip to the wind-up time. */
  playAbility(ordinal: number, durationMs: number): void {
    const name = this.clipForAbility(ordinal);
    const action = this.actions.get(name);
    if (!action) return;
    const native = action.getClip().duration;
    this.playOnce(name, native / Math.max(durationMs / 1000, 0.15));
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
    if (!action || this.current === name) return;
    const previous = this.actions.get(this.current);
    action.reset();
    action.setLoop(options.once ? THREE.LoopOnce : THREE.LoopRepeat, options.once ? 1 : Infinity);
    action.clampWhenFinished = options.once ?? false;
    action.timeScale = options.timeScale ?? 1;
    if (options.randomizePhase) action.time = Math.random() * action.getClip().duration;
    action.play();
    if (previous) previous.crossFadeTo(action, 0.15, false);
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
  }
}
