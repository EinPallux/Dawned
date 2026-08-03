/**
 * Ability VFX v1 (P5-D, COMBAT.md §9): pooled particle bursts, expanding
 * ground rings and swing trail fans — enough visual weight that every kit
 * press reads at a glance, cheap enough for the 60 FPS budget (one Points
 * cloud + a handful of pooled meshes; zero per-frame allocation).
 *
 * Sprites are canvas-generated (soft dot / shard) — no runtime asset fetch,
 * nothing new for the license ledger. Colors follow the damage schools:
 * physical = ember/steel, magic = arcane blue; class accents per def id.
 */

import * as THREE from 'three';
import { coneGeometry } from './telegraphs.js';

const MAX_PARTICLES = 512;
/** Live trail/ring meshes beyond this are recycled oldest-first. */
const MAX_SHAPES = 24;

interface Particle {
  alive: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  r: number;
  g: number;
  b: number;
}

interface ActiveShape {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  /** Ring: end radius. Flash: end scale. Trail: unused. */
  grow: number;
  kind: 'ring' | 'trail' | 'flash';
}

/** Soft radial sprite for the particle cloud. */
const makeDotTexture = (): THREE.Texture => {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.45, 'rgba(255,255,255,0.6)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

export class AbilityVfxManager {
  private readonly particles: Particle[] = [];
  private readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private readonly shapes: ActiveShape[] = [];
  private readonly ringGeometry: THREE.RingGeometry;
  private readonly trailGeometry: THREE.BufferGeometry;
  private cursor = 0;

  constructor(private readonly scene: THREE.Scene) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({
        alive: false,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        life: 0,
        maxLife: 1,
        size: 1,
        r: 1,
        g: 1,
        b: 1,
      });
    }
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.sizes = new Float32Array(MAX_PARTICLES);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    // Cull manually — the cloud's bounds change every frame.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10000);
    const material = new THREE.PointsMaterial({
      size: 0.22,
      map: makeDotTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    scene.add(this.points);

    // Flat sector for trails (a ~103° fan, scaled/rotated per swing) and a
    // ring. The fan MUST come from telegraphs' coneGeometry — its orientation
    // contract (sector extends +Z = the caster's facing) is unit-tested there,
    // and hand-rolling the sector here is exactly how the fan shipped mirrored
    // 180° behind the swing twice (owner playtest rounds 6 and 8).
    this.ringGeometry = new THREE.RingGeometry(0.9, 1, 40);
    this.ringGeometry.rotateX(-Math.PI / 2);
    this.trailGeometry = coneGeometry(1, 1.8);
  }

  /** Radial burst at a point (impacts, blink smoke, dash kick-off). */
  burst(
    x: number,
    y: number,
    z: number,
    color: THREE.ColorRepresentation,
    count = 14,
    speed = 3,
    life = 0.45,
  ): void {
    const c = new THREE.Color(color);
    for (let i = 0; i < count; i++) {
      const particle = this.particles[this.cursor]!;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      const theta = Math.random() * Math.PI * 2;
      const up = Math.random() * 0.9 + 0.25;
      const v = speed * (0.5 + Math.random() * 0.8);
      particle.alive = true;
      particle.x = x;
      particle.y = y;
      particle.z = z;
      particle.vx = Math.sin(theta) * v;
      particle.vy = up * v * 0.8;
      particle.vz = Math.cos(theta) * v;
      particle.life = 0;
      particle.maxLife = life * (0.7 + Math.random() * 0.6);
      particle.size = 1;
      particle.r = c.r;
      particle.g = c.g;
      particle.b = c.b;
    }
  }

  /** Directed spray (dash wake, cone sweeps): particles fan around `yaw`. */
  spray(
    x: number,
    y: number,
    z: number,
    yaw: number,
    spreadRad: number,
    color: THREE.ColorRepresentation,
    count = 10,
    speed = 5,
    life = 0.35,
  ): void {
    const c = new THREE.Color(color);
    for (let i = 0; i < count; i++) {
      const particle = this.particles[this.cursor]!;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      const theta = yaw + (Math.random() - 0.5) * spreadRad;
      const v = speed * (0.6 + Math.random() * 0.8);
      particle.alive = true;
      particle.x = x;
      particle.y = y;
      particle.z = z;
      particle.vx = Math.sin(theta) * v;
      particle.vy = 0.6 + Math.random() * 1.2;
      particle.vz = Math.cos(theta) * v;
      particle.life = 0;
      particle.maxLife = life * (0.7 + Math.random() * 0.6);
      particle.size = 1;
      particle.r = c.r;
      particle.g = c.g;
      particle.b = c.b;
    }
  }

  /**
   * Camera-facing impact flash: a bright sprite that pops and dies in ~150 ms.
   * THE contact read — bursts alone were too subtle on a real monitor.
   */
  flash(x: number, y: number, z: number, color: THREE.ColorRepresentation, size = 1.4): void {
    const material = new THREE.SpriteMaterial({
      map: (this.points.material as THREE.PointsMaterial).map,
      color,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(x, y, z);
    sprite.scale.setScalar(size * 0.5);
    this.addShape({
      mesh: sprite as unknown as THREE.Mesh,
      life: 0,
      maxLife: 0.16,
      grow: size,
      kind: 'flash',
    });
  }

  /** Expanding ground ring (PBAoE pulses, perfect-block ping). */
  ring(x: number, y: number, z: number, radius: number, color: THREE.ColorRepresentation): void {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(this.ringGeometry, material);
    mesh.position.set(x, y + 0.08, z);
    mesh.scale.setScalar(0.2);
    this.addShape({ mesh, life: 0, maxLife: 0.4, grow: radius, kind: 'ring' });
  }

  /** Swing trail fan in front of an attacker (melee arcs, cone sweeps). */
  trail(
    x: number,
    y: number,
    z: number,
    yaw: number,
    reach: number,
    color: THREE.ColorRepresentation,
  ): void {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(this.trailGeometry, material);
    mesh.position.set(x, y + 1.0, z);
    // YXZ: yaw the fan onto the heading, THEN tip it about its own lateral
    // axis — default XYZ tips about world X, which twists the fan sideways
    // whenever the caster faces east/west.
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = yaw;
    mesh.rotation.x = -0.25;
    mesh.scale.setScalar(reach * 0.85);
    this.addShape({ mesh, life: 0, maxLife: 0.22, grow: 0, kind: 'trail' });
  }

  private addShape(shape: ActiveShape): void {
    while (this.shapes.length >= MAX_SHAPES) this.retire(0);
    this.scene.add(shape.mesh);
    this.shapes.push(shape);
  }

  private retire(index: number): void {
    const shape = this.shapes[index]!;
    this.scene.remove(shape.mesh);
    (shape.mesh.material as THREE.Material).dispose(); // geometry is shared/pooled
    this.shapes.splice(index, 1);
  }

  update(dt: number): void {
    // Particles: integrate, gravity, fade by life.
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const particle = this.particles[i]!;
      const base = i * 3;
      if (!particle.alive) {
        this.sizes[i] = 0;
        this.positions[base + 1] = -10000; // parked far below the world
        continue;
      }
      particle.life += dt;
      if (particle.life >= particle.maxLife) {
        particle.alive = false;
        this.positions[base + 1] = -10000;
        continue;
      }
      particle.vy -= 6.5 * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.z += particle.vz * dt;
      const fade = 1 - particle.life / particle.maxLife;
      this.positions[base] = particle.x;
      this.positions[base + 1] = particle.y;
      this.positions[base + 2] = particle.z;
      this.colors[base] = particle.r * fade;
      this.colors[base + 1] = particle.g * fade;
      this.colors[base + 2] = particle.b * fade;
    }
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;

    // Shapes: rings grow + fade; trails just fade fast.
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const shape = this.shapes[i]!;
      shape.life += dt;
      const t = shape.life / shape.maxLife;
      if (t >= 1) {
        this.retire(i);
        continue;
      }
      const material = shape.mesh.material as THREE.MeshBasicMaterial;
      if (shape.kind === 'ring') {
        const eased = 1 - (1 - t) * (1 - t);
        shape.mesh.scale.setScalar(Math.max(0.2, shape.grow * eased));
        material.opacity = 0.85 * (1 - t);
      } else if (shape.kind === 'flash') {
        const eased = 1 - (1 - t) * (1 - t);
        shape.mesh.scale.setScalar(Math.max(0.2, shape.grow * (0.4 + 0.6 * eased)));
        material.opacity = 0.95 * (1 - t);
      } else {
        material.opacity = 0.5 * (1 - t);
        shape.mesh.scale.multiplyScalar(1 + dt * 1.6);
      }
    }
  }

  dispose(): void {
    this.scene.remove(this.points);
    this.geometry.dispose();
    (this.points.material as THREE.PointsMaterial).map?.dispose();
    (this.points.material as THREE.Material).dispose();
    while (this.shapes.length > 0) this.retire(0);
    this.ringGeometry.dispose();
    this.trailGeometry.dispose();
  }
}

/** School/class palette for ability VFX (physical ember vs magic arcane). */
export const abilityVfxColor = (classId: string, school: 'physical' | 'magic'): number => {
  if (school === 'magic') return 0x7ea8ff;
  return classId === 'rogue' ? 0xb9f06a : 0xffc76a;
};
