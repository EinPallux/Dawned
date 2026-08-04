/**
 * Market posts (ITEMS_LOOT.md §6): until P12 stands real NPCs in real
 * settlements, each vendor with an anchor gets a post in the world — a stake,
 * a banner in its trade's colour, and the `F` prompt the HUD raises when you
 * are inside its radius. The server still owns every price; this is a signpost.
 */

import * as THREE from 'three';

export interface VendorAnchor {
  id: string;
  name: string;
  kind: string;
  anchor: { x: number; z: number; radius: number } | null;
}

/** Banner tint per trade — a glance tells you which post you are walking to. */
const KIND_COLORS: Record<string, string> = {
  general: '#c9a34e',
  weaponsmith: '#d8453a',
  armorer: '#3e8fe8',
  alchemist: '#57c77b',
  collector: '#a44fe0',
};

export const loadVendorAnchors = async (): Promise<VendorAnchor[]> => {
  try {
    const response = await fetch('/api/content/vendors');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as { vendors?: VendorAnchor[] };
    return (payload.vendors ?? []).filter((vendor) => vendor.anchor !== null);
  } catch (error) {
    // No posts is survivable: trading still works if you find one blind.
    console.warn('[content] vendor anchors unavailable:', error);
    return [];
  }
};

// three.js discriminator flag, narrowed without `any` (same idiom as characters.ts).
const isMesh = (object: THREE.Object3D): object is THREE.Mesh =>
  (object as Partial<THREE.Mesh>).isMesh === true;

export class VendorPostManager {
  private readonly posts: { vendor: VendorAnchor; group: THREE.Group }[] = [];

  constructor(private readonly scene: THREE.Scene) {}

  /** Stand the posts (ground height comes from the terrain sampler). */
  build(vendors: readonly VendorAnchor[], heightAt: (x: number, z: number) => number): void {
    for (const vendor of vendors) {
      if (!vendor.anchor) continue;
      const color = KIND_COLORS[vendor.kind] ?? KIND_COLORS.general!;
      const group = new THREE.Group();
      const stake = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.09, 2.1, 6),
        new THREE.MeshLambertMaterial({ color: '#5b4630', flatShading: true }),
      );
      stake.position.y = 1.05;
      stake.castShadow = true;
      const banner = new THREE.Mesh(
        new THREE.PlaneGeometry(0.55, 0.8),
        new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, flatShading: true }),
      );
      banner.position.set(0.3, 1.5, 0);
      const crate = new THREE.Mesh(
        new THREE.BoxGeometry(0.7, 0.45, 0.5),
        new THREE.MeshLambertMaterial({ color: '#6b5334', flatShading: true }),
      );
      crate.position.set(-0.35, 0.22, 0.1);
      crate.castShadow = true;
      group.add(stake, banner, crate);
      group.position.set(
        vendor.anchor.x,
        heightAt(vendor.anchor.x, vendor.anchor.z),
        vendor.anchor.z,
      );
      this.scene.add(group);
      this.posts.push({ vendor, group });
    }
  }

  /** The post the player is standing in, if any (the `F` prompt's subject). */
  inReach(x: number, z: number): VendorAnchor | null {
    for (const post of this.posts) {
      const anchor = post.vendor.anchor;
      if (!anchor) continue;
      if (Math.hypot(x - anchor.x, z - anchor.z) <= anchor.radius) return post.vendor;
    }
    return null;
  }

  dispose(): void {
    for (const post of this.posts) {
      this.scene.remove(post.group);
      post.group.traverse((node) => {
        if (!isMesh(node)) return;
        node.geometry.dispose();
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) material.dispose();
      });
    }
    this.posts.length = 0;
  }
}
