/**
 * Character composition: base body + outfit + hair pieces, one skeleton, with the
 * Universal Animation Library clips playing on it.
 *
 * The Quaternius "Universal" packs share bone names/rest pose by design, so
 * composition is name-based rebinding at load time — no per-frame retarget cost
 * (deviation from the bake-time-merge idea is documented in
 * docs/tech/ASSET_PIPELINE.md §2). Everything loads via the pipeline manifest;
 * missing assets degrade to a neutral silhouette so screens never hard-fail.
 */

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { HAIR_COLORS, OUTFITS, SKIN_TONES, hairstyleById, type Appearance } from '@dawned/shared';

/** Manifest ids (deterministic from source filenames — see tools/asset-pipeline). */
const ASSET_IDS = {
  base: { m: 'characters_superhero_male_fullbody', f: 'characters_superhero_female_fullbody' },
  outfit: {
    ranger: { m: 'characters_male_ranger', f: 'characters_female_ranger' },
    peasant: { m: 'characters_male_peasant', f: 'characters_female_peasant' },
  },
  hairPrefix: 'characters_',
  beard: 'characters_hair_beard',
  animations: ['characters_ual1'],
} as const;

interface ManifestAsset {
  id: string;
  file: string;
}

interface Manifest {
  assets: Record<string, ManifestAsset>;
}

export interface CharacterAssets {
  /** id → loaded gltf (bodies, outfits, hair pieces). */
  models: Map<string, GLTF>;
  /** All UAL clips by name. */
  clips: Map<string, THREE.AnimationClip>;
  ok: boolean;
}

let assetsPromise: Promise<CharacterAssets> | null = null;

/** Load (once) everything character composition needs. Never rejects. */
export const loadCharacterAssets = (): Promise<CharacterAssets> => {
  assetsPromise ??= loadAll();
  return assetsPromise;
};

const loadAll = async (): Promise<CharacterAssets> => {
  const result: CharacterAssets = { models: new Map(), clips: new Map(), ok: false };
  let manifest: Manifest;
  try {
    const response = await fetch('/assets/manifest.json');
    manifest = (await response.json()) as Manifest;
  } catch {
    console.warn('[characters] no asset manifest — previews degrade to silhouettes');
    return result;
  }

  const loader = new GLTFLoader();
  const wanted = new Set<string>([
    ASSET_IDS.base.m,
    ASSET_IDS.base.f,
    ...Object.values(ASSET_IDS.outfit).flatMap((entry) => [entry.m, entry.f]),
    ASSET_IDS.beard,
    ...ASSET_IDS.animations,
  ]);
  for (const style of ['buzzed', 'buzzedfemale', 'buns', 'long', 'simpleparted']) {
    wanted.add(`${ASSET_IDS.hairPrefix}hair_${style}`);
  }

  const loads: Promise<void>[] = [];
  for (const id of wanted) {
    const entry = manifest.assets[id];
    if (!entry) continue; // absent piece: tolerated, checked at use sites
    loads.push(
      loader
        .loadAsync(`/${entry.file}`)
        .then((gltf) => {
          result.models.set(id, gltf);
          for (const clip of gltf.animations) {
            if (!result.clips.has(clip.name)) result.clips.set(clip.name, clip);
          }
        })
        .catch((error: unknown) => {
          console.warn(`[characters] failed to load ${id}:`, error);
        }),
    );
  }
  await Promise.all(loads);
  result.ok = result.models.has(ASSET_IDS.base.m) && result.models.has(ASSET_IDS.base.f);
  return result;
};

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface ComposedCharacter {
  /** Add this to the scene; origin at the feet, facing +Z. */
  group: THREE.Group;
  mixer: THREE.AnimationMixer;
  /** Play a UAL clip by name with crossfade; returns false when unknown. */
  play: (
    clipName: string,
    options?: {
      fadeSeconds?: number;
      loopOnce?: boolean;
      randomizeStart?: boolean;
      /** Start the new clip at the outgoing clip's normalized cycle phase. */
      carryPhase?: boolean;
    },
  ) => boolean;
  /** Playback speed of the active clip (foot-slide compensation). */
  setTimeScale: (scale: number) => void;
  dispose: () => void;
}

// three.js discriminator flags, narrowed without `any` (`isMesh` is a literal
// `true` on the class, so a plain cast-and-check trips no-unnecessary-condition).
const isMesh = (object: THREE.Object3D): object is THREE.Mesh =>
  (object as Partial<THREE.Mesh>).isMesh === true;
const isSkinnedMesh = (object: THREE.Object3D): object is THREE.SkinnedMesh =>
  (object as Partial<THREE.SkinnedMesh>).isSkinnedMesh === true;
const isBone = (object: THREE.Object3D): object is THREE.Bone =>
  (object as Partial<THREE.Bone>).isBone === true;

const findSkinned = (root: THREE.Object3D): THREE.SkinnedMesh[] => {
  const found: THREE.SkinnedMesh[] = [];
  root.traverse((object) => {
    if (isSkinnedMesh(object)) found.push(object);
  });
  return found;
};

/** Rebind a skinned mesh from its own skeleton onto same-named bones of the target rig. */
const rebindToSkeleton = (
  mesh: THREE.SkinnedMesh,
  bonesByName: Map<string, THREE.Bone>,
): boolean => {
  const sourceBones = mesh.skeleton.bones;
  const mapped: THREE.Bone[] = new Array<THREE.Bone>(sourceBones.length);
  for (let i = 0; i < sourceBones.length; i++) {
    const target = bonesByName.get(sourceBones[i]!.name);
    if (!target) return false; // rig mismatch — caller drops the piece
    mapped[i] = target;
  }
  // Same rest pose family → the source's inverse bind matrices stay valid.
  mesh.skeleton = new THREE.Skeleton(mapped, mesh.skeleton.boneInverses);
  return true;
};

/**
 * Tinting model (Q13): everything MULTIPLIES its baked basecolor. Skin/outfit
 * textures are baked from the packs' light variants (tints darken); hair, beard
 * and the built-in eyebrows are baked to brightness-normalized luminance maps
 * (tools/asset-pipeline packs.json), so the multiply lands on the exact picked
 * swatch with strand shading intact. The packs' stable MI_* material names say
 * which color applies where.
 */
type MaterialTint = (material: THREE.MeshStandardMaterial) => THREE.MeshStandardMaterial;

const multiplied =
  (hex: string): MaterialTint =>
  (material) => {
    if (hex === '#ffffff') return material;
    const clone = material.clone();
    clone.color.multiply(new THREE.Color(hex));
    return clone;
  };

const keep: MaterialTint = (material) => material;

/** Clone-and-replace materials under `root` according to a per-material rule. */
const retint = (root: THREE.Object3D, rule: (name: string) => MaterialTint): void => {
  const tinted = (material: THREE.Material): THREE.Material =>
    rule(material.name)(material as THREE.MeshStandardMaterial);
  root.traverse((object) => {
    if (!isMesh(object)) return;
    object.material = Array.isArray(object.material)
      ? object.material.map(tinted)
      : tinted(object.material);
  });
};

const enableShadows = (root: THREE.Object3D): void => {
  root.traverse((object) => {
    if (isMesh(object)) {
      object.castShadow = true;
      object.frustumCulled = false; // skinned bounds are unreliable
    }
  });
};

/**
 * Build a character from appearance. Returns null when the base rig is missing
 * (caller falls back to the capsule silhouette).
 */
export const composeCharacter = (
  assets: CharacterAssets,
  appearance: Appearance,
): ComposedCharacter | null => {
  const baseGltf = assets.models.get(ASSET_IDS.base[appearance.body]);
  if (!baseGltf) return null;

  const group = new THREE.Group();
  const base = cloneSkeleton(baseGltf.scene);
  group.add(base);

  // Index the base rig's bones once.
  const bonesByName = new Map<string, THREE.Bone>();
  base.traverse((object) => {
    if (isBone(object)) bonesByName.set(object.name, object);
  });

  const skinHex = SKIN_TONES[appearance.skin] ?? '#ffffff';
  const hairHex = HAIR_COLORS[appearance.hairColor] ?? '#ffffff';

  // Base head: skin multiplies; the built-in eyebrows (MI_Hair_*) follow the hair
  // color; eyes stay as textured.
  retint(base, (name) =>
    name.startsWith('MI_Hair')
      ? multiplied(hairHex)
      : name.startsWith('MI_Eyes')
        ? keep
        : multiplied(skinHex),
  );

  /** Clone a gltf's skinned meshes onto the base rig; returns the added root. */
  const attach = (
    gltf: GLTF | undefined,
    tint: (name: string) => MaterialTint,
  ): THREE.Object3D | null => {
    if (!gltf) return null;
    const piece = cloneSkeleton(gltf.scene);
    let bound = 0;
    for (const mesh of findSkinned(piece)) {
      if (rebindToSkeleton(mesh, bonesByName)) bound++;
    }
    if (bound === 0) return null;
    // Strip the piece's own armature duplicates: keep meshes, drop its bones.
    for (const child of [...piece.children]) {
      if (!findSkinned(child).length && isBone(child)) piece.remove(child);
    }
    retint(piece, tint);
    group.add(piece);
    return piece;
  };

  // Outfit: cloth multiplies with the picked tint; its exposed-skin parts
  // (MI_Regular_*) follow the skin tone instead.
  const outfitHex =
    OUTFITS.find((o) => o.id === appearance.outfit)?.tints[appearance.outfitTint] ?? '#ffffff';
  attach(assets.models.get(ASSET_IDS.outfit[appearance.outfit][appearance.body]), (name) =>
    name.startsWith('MI_Regular') ? multiplied(skinHex) : multiplied(outfitHex),
  );

  // Hair + beard: picked color over the baked luminance map.
  const style = hairstyleById(appearance.hair);
  if (style?.asset) {
    attach(assets.models.get(`${ASSET_IDS.hairPrefix}${style.asset}`), () => multiplied(hairHex));
  }
  if (appearance.beard) attach(assets.models.get(ASSET_IDS.beard), () => multiplied(hairHex));

  enableShadows(group);

  // Animation: one mixer on the composed root; clips address bones by name.
  const mixer = new THREE.AnimationMixer(base);
  let activeAction: THREE.AnimationAction | null = null;

  const play: ComposedCharacter['play'] = (clipName, options) => {
    const clip = assets.clips.get(clipName);
    if (!clip) return false;
    const next = mixer.clipAction(clip);
    if (options?.loopOnce) {
      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = true;
    } else {
      next.setLoop(THREE.LoopRepeat, Infinity);
    }
    // Carrying the gait phase into the next cycle keeps feet mid-stride through
    // direction/gait changes — measured before the fade replaces activeAction.
    let phase = -1;
    if (options?.carryPhase && activeAction && activeAction !== next) {
      const previousClip = activeAction.getClip();
      if (previousClip.duration > 0) {
        phase = (activeAction.time % previousClip.duration) / previousClip.duration;
      }
    }
    if (activeAction && activeAction !== next) {
      next
        .reset()
        .crossFadeFrom(activeAction, options?.fadeSeconds ?? 0.18, false)
        .play();
    } else {
      next.reset().play();
    }
    if (!options?.loopOnce) {
      if (phase >= 0) {
        next.time = phase * clip.duration;
      } else if (options?.randomizeStart) {
        // Desync loops across players so a crowd doesn't idle in lockstep.
        next.time = Math.random() * clip.duration;
      }
    }
    activeAction = next;
    return true;
  };

  const setTimeScale: ComposedCharacter['setTimeScale'] = (scale) => {
    if (activeAction) activeAction.timeScale = scale;
  };

  const dispose = (): void => {
    mixer.stopAllAction();
    group.traverse((object) => {
      if (!isMesh(object)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    });
  };

  return { group, mixer, play, setTimeScale, dispose };
};
