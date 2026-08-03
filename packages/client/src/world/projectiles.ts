/**
 * Projectile visuals (P4): the server owns flight truth and sends spawn + end;
 * the client integrates the straight line locally between them (identical
 * math), so bolts fly smoothly at any fps without per-tick position spam.
 */

import * as THREE from 'three';
import type { ProjectileEndMessage, ProjectileSpawnMessage } from '@dawned/shared';

/** Class bolt tints by the spawn's `visual` index (0 mage, 1 cleric, 2+ enemy). */
const VISUALS = [
  { core: '#7ea8ff', glow: '#2e4a9e' },
  { core: '#ffe9a8', glow: '#c9a34e' },
  { core: '#c47eff', glow: '#5e2e9e' },
];

interface ActiveBolt {
  id: number;
  group: THREE.Group;
  velocity: THREE.Vector3;
  /** Server flight ends via ProjectileEnd; this is the runaway fallback. */
  ttl: number;
}

export class ProjectileManager {
  private readonly active = new Map<number, ActiveBolt>();

  constructor(private readonly scene: THREE.Scene) {}

  spawn(message: ProjectileSpawnMessage): void {
    const visual = VISUALS[message.visual] ?? VISUALS[0]!;
    const group = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 10, 8),
      new THREE.MeshBasicMaterial({ color: visual.core }),
    );
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 10, 8),
      new THREE.MeshBasicMaterial({ color: visual.glow, transparent: true, opacity: 0.35 }),
    );
    group.add(core, glow);
    group.position.set(message.x, message.y, message.z);
    this.scene.add(group);
    this.active.set(message.projectileId, {
      id: message.projectileId,
      group,
      velocity: new THREE.Vector3(message.dirX, message.dirY, message.dirZ).multiplyScalar(
        message.speed,
      ),
      ttl: 3,
    });
  }

  end(message: ProjectileEndMessage): void {
    const bolt = this.active.get(message.projectileId);
    if (!bolt) return;
    // Snap to the authoritative end point; a tiny impact pop on hits.
    bolt.group.position.set(message.x, message.y, message.z);
    if (message.hit) {
      const pop = new THREE.Mesh(
        new THREE.SphereGeometry(0.35, 10, 8),
        new THREE.MeshBasicMaterial({ color: '#fff2d8', transparent: true, opacity: 0.8 }),
      );
      pop.position.copy(bolt.group.position);
      this.scene.add(pop);
      setTimeout(() => {
        this.scene.remove(pop);
        pop.geometry.dispose();
        (pop.material as THREE.Material).dispose();
      }, 90);
    }
    this.remove(bolt);
  }

  update(dt: number): void {
    for (const bolt of this.active.values()) {
      bolt.group.position.addScaledVector(bolt.velocity, dt);
      bolt.ttl -= dt;
      if (bolt.ttl <= 0) this.remove(bolt);
    }
  }

  private remove(bolt: ActiveBolt): void {
    this.active.delete(bolt.id);
    this.scene.remove(bolt.group);
    bolt.group.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh) {
        (child.geometry as THREE.BufferGeometry).dispose();
        (child.material as THREE.Material).dispose();
      }
    });
  }
}
