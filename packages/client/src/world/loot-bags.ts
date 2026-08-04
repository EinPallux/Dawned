/**
 * Loot bags in the world (ITEMS_LOOT.md §3): a satchel at the corpse under a
 * beam coloured by the best rarity inside, fading as the 60 s lifetime runs
 * out. The server owns the bag list — this only mirrors what it sent, so a
 * bag that expires or empties simply stops arriving.
 */

import * as THREE from 'three';
import { RARITY_COLORS, type WireLootBag } from '@dawned/shared';

/** How far the beam reaches — visible over the treeline, not into orbit. */
const BEAM_HEIGHT = 3.2;
const BEAM_RADIUS = 0.16;

interface BagProp {
  group: THREE.Group;
  beam: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  expiresAtMs: number;
}

const colorFor = (rarity: string): string =>
  rarity in RARITY_COLORS
    ? RARITY_COLORS[rarity as keyof typeof RARITY_COLORS]
    : RARITY_COLORS.common;

// three.js discriminator flag, narrowed without `any` (same idiom as characters.ts).
const isMesh = (object: THREE.Object3D): object is THREE.Mesh =>
  (object as Partial<THREE.Mesh>).isMesh === true;

export class LootBagManager {
  private readonly props = new Map<number, BagProp>();
  /** Server time of the last LootBags message, for the despawn fade. */
  private serverTimeMs = 0;

  constructor(private readonly scene: THREE.Scene) {}

  /** Adopt the server's bag list wholesale (adds, updates, removes). */
  sync(bags: readonly WireLootBag[], serverTimeMs: number): void {
    this.serverTimeMs = serverTimeMs;
    const seen = new Set<number>();
    for (const bag of bags) {
      seen.add(bag.id);
      const existing = this.props.get(bag.id);
      if (existing) {
        existing.expiresAtMs = bag.expiresAtMs;
        existing.beam.material.color.set(colorFor(bag.rarity));
        continue;
      }
      this.props.set(bag.id, this.build(bag));
    }
    for (const [id, prop] of this.props) {
      if (seen.has(id)) continue;
      this.scene.remove(prop.group);
      prop.group.traverse((node) => {
        if (!isMesh(node)) return;
        node.geometry.dispose();
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) material.dispose();
      });
      this.props.delete(id);
    }
  }

  private build(bag: WireLootBag): BagProp {
    const color = colorFor(bag.rarity);
    const group = new THREE.Group();
    const sack = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.28, 0),
      new THREE.MeshLambertMaterial({ color: '#6b5334', flatShading: true }),
    );
    sack.position.y = 0.28;
    sack.castShadow = true;
    const tie = new THREE.Mesh(
      new THREE.TorusGeometry(0.13, 0.04, 6, 10),
      new THREE.MeshLambertMaterial({ color, flatShading: true }),
    );
    tie.position.y = 0.52;
    tie.rotation.x = Math.PI / 2;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(BEAM_RADIUS, BEAM_RADIUS * 0.55, BEAM_HEIGHT, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    beam.position.y = BEAM_HEIGHT / 2;
    group.add(sack, tie, beam);
    group.position.set(bag.x, bag.y, bag.z);
    this.scene.add(group);
    return { group, beam, expiresAtMs: bag.expiresAtMs };
  }

  /** Bob the sacks and fade a beam out over the bag's last five seconds. */
  update(dtSeconds: number, elapsedSeconds: number): void {
    this.serverTimeMs += dtSeconds * 1000;
    for (const prop of this.props.values()) {
      prop.group.rotation.y += dtSeconds * 0.6;
      prop.group.children[0]!.position.y = 0.28 + Math.sin(elapsedSeconds * 2) * 0.04;
      const secondsLeft = (prop.expiresAtMs - this.serverTimeMs) / 1000;
      prop.beam.material.opacity = secondsLeft > 5 ? 0.28 : Math.max(0, secondsLeft / 5) * 0.28;
    }
  }

  dispose(): void {
    this.sync([], this.serverTimeMs);
  }
}
