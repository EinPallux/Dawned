/**
 * Enemy telegraph decals (COMBAT.md §8): the EXACT server shape drawn on the
 * ground, filling toward impact. Colorblind-safe by construction — the fill
 * carries a diagonal hatch pattern, never color alone.
 */

import * as THREE from 'three';
import { TelegraphShape, type TelegraphMessage, type TerrainSampler } from '@dawned/shared';

interface ActiveTelegraph {
  group: THREE.Group;
  fill: THREE.Mesh;
  startedAt: number;
  impactAt: number;
}

/** Diagonal-hatch texture so shape reads without color vision. */
const makeHatchTexture = (): THREE.CanvasTexture => {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(220, 60, 40, 0.35)';
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = 'rgba(255, 235, 220, 0.5)';
  ctx.lineWidth = 5;
  for (let i = -64; i < 128; i += 16) {
    ctx.beginPath();
    ctx.moveTo(i, 64);
    ctx.lineTo(i + 64, 0);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
};

const coneGeometry = (reach: number, spreadRad: number): THREE.BufferGeometry => {
  const geometry = new THREE.CircleGeometry(reach, 24, Math.PI / 2 - spreadRad / 2, spreadRad);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
};

const circleGeometry = (radius: number): THREE.BufferGeometry => {
  const geometry = new THREE.CircleGeometry(radius, 32);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
};

const rectGeometry = (length: number, width: number): THREE.BufferGeometry => {
  const geometry = new THREE.PlaneGeometry(width, length);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, 0, length / 2);
  return geometry;
};

export class TelegraphManager {
  private readonly active: ActiveTelegraph[] = [];
  private readonly hatch = makeHatchTexture();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly terrain: TerrainSampler,
  ) {}

  show(message: TelegraphMessage): void {
    const geometry =
      message.shape === (TelegraphShape.Circle as number)
        ? circleGeometry(message.size)
        : message.shape === (TelegraphShape.Rect as number)
          ? rectGeometry(message.size, message.spread)
          : coneGeometry(message.size, message.spread);

    const group = new THREE.Group();
    // Border: the full shape outline at constant opacity.
    const border = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: '#e0402a',
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    // Fill: the same shape, hatched, scaled up from 0 as impact approaches.
    const fill = new THREE.Mesh(
      geometry.clone(),
      new THREE.MeshBasicMaterial({
        map: this.hatch,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    fill.scale.setScalar(0.001);
    group.add(border, fill);

    const y = this.terrain.heightAt(message.x, message.z) + 0.06;
    group.position.set(message.x, y, message.z);
    group.rotation.y = message.yaw;
    this.scene.add(group);

    const now = performance.now();
    this.active.push({ group, fill, startedAt: now, impactAt: now + message.impactInMs });
  }

  update(): void {
    const now = performance.now();
    for (let i = this.active.length - 1; i >= 0; i--) {
      const telegraph = this.active[i]!;
      const span = telegraph.impactAt - telegraph.startedAt;
      const progress = span > 0 ? (now - telegraph.startedAt) / span : 1;
      if (progress >= 1) {
        // Impact: a brief bright pop, then gone (the hit itself follows).
        if (now - telegraph.impactAt > 120) {
          this.scene.remove(telegraph.group);
          telegraph.group.traverse((child: THREE.Object3D) => {
            if (child instanceof THREE.Mesh) {
              (child.geometry as THREE.BufferGeometry).dispose();
              (child.material as THREE.Material).dispose();
            }
          });
          this.active.splice(i, 1);
        } else {
          telegraph.fill.scale.setScalar(1);
          (telegraph.fill.material as THREE.MeshBasicMaterial).opacity = 0.9;
        }
        continue;
      }
      // Fill grows from the caster outward = time to impact (COMBAT.md §8).
      telegraph.fill.scale.setScalar(Math.max(0.001, progress));
    }
  }

  /** Telegraphs on screen (smoke-test observability). */
  get count(): number {
    return this.active.length;
  }
}
