/**
 * Visible weapons (ITEMS_LOOT.md §1): the baked weapon models, loaded once and
 * cloned onto a character's hand bones. Armour never changes the silhouette —
 * only what a character HOLDS does, so this is the whole of "gear you can see".
 *
 * Model refs come from the roster (`mainhandModel`/`offhandModel`), which the
 * server fills from the equipped item's `modelRef`. An unknown ref just means
 * bare hands: content can name a model the client has not baked yet without
 * the character disappearing.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

interface ManifestEntry {
  category?: string;
  file?: string;
}
interface Manifest {
  assets: Record<string, ManifestEntry>;
}

/**
 * Where a held model sits relative to the hand bone. The KayKit weapons are
 * modelled with the grip at the origin pointing +Y; hands point down the bone,
 * so every piece takes the same quarter turn.
 */
const GRIP_ROTATION = new THREE.Euler(Math.PI / 2, 0, 0);
const GRIP_SCALE = 0.9;

// three.js discriminator flag, narrowed without `any` (characters.ts idiom).
const isMesh = (object: THREE.Object3D): object is THREE.Mesh =>
  (object as Partial<THREE.Mesh>).isMesh === true;

let modelsPromise: Promise<Map<string, GLTF>> | null = null;

/** Load every baked weapon once (category `items/weapons`). Never rejects. */
export const loadWeaponModels = (): Promise<Map<string, GLTF>> => {
  modelsPromise ??= (async () => {
    const models = new Map<string, GLTF>();
    let manifest: Manifest;
    try {
      const response = await fetch('/assets/manifest.json');
      manifest = (await response.json()) as Manifest;
    } catch {
      console.warn('[weapons] no asset manifest — characters go bare-handed');
      return models;
    }
    const loader = new GLTFLoader();
    await Promise.all(
      Object.entries(manifest.assets)
        .filter(([, entry]) => entry.category === 'items/weapons' && entry.file)
        .map(async ([id, entry]) => {
          try {
            models.set(id, await loader.loadAsync(`/${entry.file!}`));
          } catch (error) {
            console.warn(`[weapons] failed to load ${id}:`, error);
          }
        }),
    );
    return models;
  })();
  return modelsPromise;
};

/**
 * Hold the given models in a rig's hands. Idempotent per (bone, ref): calling
 * it every roster update is free, and swapping a weapon replaces exactly the
 * one hand that changed.
 */
export class HeldWeapons {
  private readonly held = new Map<
    'mainhand' | 'offhand',
    { ref: string; object: THREE.Object3D }
  >();

  constructor(
    private readonly models: Map<string, GLTF>,
    private readonly bones: { mainhand: THREE.Object3D | null; offhand: THREE.Object3D | null },
  ) {}

  set(hand: 'mainhand' | 'offhand', ref: string | null | undefined): void {
    const current = this.held.get(hand);
    if ((current?.ref ?? null) === (ref ?? null)) return;
    if (current) {
      current.object.parent?.remove(current.object);
      this.held.delete(hand);
    }
    const bone = this.bones[hand];
    if (!ref || !bone) return;
    const gltf = this.models.get(ref);
    if (!gltf) return;
    // Weapon models are modelled standing on their handle end, but their
    // ORIGIN varies by pack (centre for some, base for others). Re-seat each
    // one so the bottom of the shaft sits exactly at the bone: the grip lands
    // in the fist for every model without a per-item offset table.
    const model = gltf.scene.clone(true);
    const bounds = new THREE.Box3().setFromObject(model);
    model.position.set(
      -(bounds.min.x + bounds.max.x) / 2,
      -bounds.min.y,
      -(bounds.min.z + bounds.max.z) / 2,
    );
    const object = new THREE.Group();
    object.add(model);
    object.rotation.copy(GRIP_ROTATION);
    object.scale.setScalar(GRIP_SCALE);
    object.traverse((node) => {
      if (isMesh(node)) node.castShadow = true;
    });
    bone.add(object);
    this.held.set(hand, { ref, object });
  }

  dispose(): void {
    for (const entry of this.held.values()) entry.object.parent?.remove(entry.object);
    this.held.clear();
  }
}

/** Find the hand bones of a composed rig (UAL skeleton naming). */
export const handBones = (
  root: THREE.Object3D,
): { mainhand: THREE.Object3D | null; offhand: THREE.Object3D | null } => {
  let mainhand: THREE.Object3D | null = null;
  let offhand: THREE.Object3D | null = null;
  root.traverse((node) => {
    if (node.name === 'hand_r') mainhand = node;
    else if (node.name === 'hand_l') offhand = node;
  });
  return { mainhand, offhand };
};
