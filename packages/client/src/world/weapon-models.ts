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
 * Where a held model sits relative to the hand bone.
 *
 * The weapons are modelled standing on their grip, shaft along +Y. A fist
 * holds a shaft along one fixed axis of the hand bone, so pointing the model's
 * +Y down that axis puts the handle in the palm in every pose the rig can
 * reach. The axis below is that direction, measured off the rig itself: world
 * DOWN expressed in `hand_r`'s local frame while the arm hangs at rest — which
 * is exactly where a lowered weapon points.
 */
const GRIP_AXIS = new THREE.Vector3(-0.138, 0.833, -0.536).normalize();
const GRIP_ROTATION = new THREE.Quaternion().setFromUnitVectors(
  new THREE.Vector3(0, 1, 0),
  GRIP_AXIS,
);
/**
 * A shield is strapped to the arm rather than hung from a handle: same axis,
 * standing the other way up so its face is out and its rim is not in the dirt.
 */
const SHIELD_ROTATION = GRIP_ROTATION.clone().multiply(
  new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI),
);
const isShield = (ref: string): boolean => ref.includes('_shield_');
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
    //
    // The correction SHIFTS the node — the measured bounds already include
    // whatever offset the exporter baked into the root, so overwriting the
    // position instead of subtracting from it counts that offset twice and
    // hangs the weapon in the air beside the hand.
    const model = gltf.scene.clone(true);
    const bounds = new THREE.Box3().setFromObject(model);
    model.position.set(
      model.position.x - (bounds.min.x + bounds.max.x) / 2,
      // Weapons hang from their grip; a shield straps across the forearm, so
      // it rides on its middle instead of standing on its rim.
      model.position.y - (isShield(ref) ? (bounds.min.y + bounds.max.y) / 2 : bounds.min.y),
      model.position.z - (bounds.min.z + bounds.max.z) / 2,
    );
    const object = new THREE.Group();
    object.add(model);
    object.quaternion.copy(isShield(ref) ? SHIELD_ROTATION : GRIP_ROTATION);
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

  /** Where the gear really ended up — the grip is invisible until it is wrong. */
  get debug(): {
    hand: string;
    ref: string;
    bone: string;
    boneAt: [number, number, number];
    modelAt: [number, number, number];
  }[] {
    const rows = [];
    const at = new THREE.Vector3();
    for (const [hand, entry] of this.held) {
      const bone = this.bones[hand];
      bone?.getWorldPosition(at);
      const boneAt: [number, number, number] = [at.x, at.y, at.z];
      entry.object.getWorldPosition(at);
      rows.push({
        hand,
        ref: entry.ref,
        bone: bone?.name ?? '<none>',
        boneAt,
        modelAt: [at.x, at.y, at.z] as [number, number, number],
      });
    }
    return rows;
  }
}

const isSkinnedMesh = (object: THREE.Object3D): object is THREE.SkinnedMesh =>
  (object as Partial<THREE.SkinnedMesh>).isSkinnedMesh === true;

/**
 * Find the hand bones of a composed rig (UAL skeleton naming).
 *
 * Take them off the SKELETON that deforms the visible mesh, not off the node
 * tree: composition (characters.ts) rebinds every outfit and hair piece onto
 * the base rig's bones but leaves each piece's own armature in the tree, so a
 * rig carries several bones called `hand_r` and only one of them ever moves.
 * A name search over the tree can pick a bind-pose duplicate — which reads in
 * game as a weapon hanging in mid-air beside the character.
 */
export const handBones = (
  root: THREE.Object3D,
): { mainhand: THREE.Object3D | null; offhand: THREE.Object3D | null } => {
  const animated = new Map<string, THREE.Object3D>();
  root.traverse((node) => {
    if (!isSkinnedMesh(node)) return;
    for (const bone of node.skeleton.bones) {
      if (!animated.has(bone.name)) animated.set(bone.name, bone);
    }
  });
  if (animated.size === 0) {
    // No skinned mesh (silhouette or a stripped rig): fall back to the tree,
    // keeping the FIRST match — the base rig is added before its pieces.
    root.traverse((node) => {
      if (!animated.has(node.name)) animated.set(node.name, node);
    });
  }
  return { mainhand: animated.get('hand_r') ?? null, offhand: animated.get('hand_l') ?? null };
};
