/**
 * Character rig verification — runs inside the asset report gate.
 *
 * The runtime composes characters by name-based rebinding (packages/client/src/
 * world/characters.ts): outfit/hair skins rebind onto same-named base bones, and
 * UAL clips address base bones by track name. That only works while every baked
 * piece agrees on the 65-bone rig — this check fails the build the moment a
 * re-export or pipeline change breaks that contract.
 */

import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { REPO_ROOT, loadManifest } from './build.mjs';

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);

const BASE_IDS = ['characters_superhero_male_fullbody', 'characters_superhero_female_fullbody'];

/** Skinned pieces that must rebind onto the base rig. */
const PIECE_IDS = [
  'characters_male_ranger',
  'characters_female_ranger',
  'characters_male_peasant',
  'characters_female_peasant',
  'characters_hair_buzzed',
  'characters_hair_buzzedfemale',
  'characters_hair_buns',
  'characters_hair_long',
  'characters_hair_simpleparted',
  'characters_hair_beard',
];

const ANIMATION_IDS = ['characters_ual1'];

/**
 * Clips the client requires at runtime — class pose clips from
 * packages/shared/src/data/appearance.ts plus the locomotion set used in-world.
 * Keep in sync when either side changes.
 */
const REQUIRED_CLIPS = [
  'Idle_Loop',
  'Idle_LookAround_Loop',
  'Sword_Idle',
  'Spell_Simple_Idle_Loop',
  'Spell_Double_Idle_Loop',
  'Jog_Fwd_Loop',
  'Sprint_Loop',
  'Jump_Start',
  'Jump_Loop',
  'Jump_Land',
];

const readBaked = async (manifest, id, failures) => {
  const asset = manifest.assets[id];
  if (!asset) {
    failures.push(`characters: "${id}" missing from the manifest`);
    return null;
  }
  try {
    return await io.read(path.join(REPO_ROOT, asset.file));
  } catch (error) {
    failures.push(`characters: failed to read baked ${id}: ${error.message}`);
    return null;
  }
};

const jointNames = (document) => {
  const names = new Set();
  for (const skin of document.getRoot().listSkins()) {
    for (const joint of skin.listJoints()) names.add(joint.getName());
  }
  return names;
};

/**
 * Verify baked character assets. Returns { failures: string[] } — empty when no
 * character assets are baked yet (nothing to verify) or everything lines up.
 */
export const verifyCharacters = async () => {
  const manifest = await loadManifest();
  const failures = [];
  if (!manifest?.assets || !BASE_IDS.some((id) => manifest.assets[id])) {
    return { failures, skipped: true };
  }

  // 1. Both bases exist and share one bone set.
  const baseBones = new Set();
  for (const id of BASE_IDS) {
    const document = await readBaked(manifest, id, failures);
    if (!document) continue;
    const bones = jointNames(document);
    if (bones.size === 0) failures.push(`characters: ${id} has no skinned rig`);
    if (baseBones.size === 0) {
      for (const name of bones) baseBones.add(name);
    } else if (bones.size !== baseBones.size || [...bones].some((name) => !baseBones.has(name))) {
      failures.push(`characters: ${id} bone set differs from the other base rig`);
    }
  }
  if (baseBones.size === 0) return { failures };

  // 2. Every piece's skin joints must exist on the base rig (rebind contract).
  for (const id of PIECE_IDS) {
    const document = await readBaked(manifest, id, failures);
    if (!document) continue;
    const missing = [...jointNames(document)].filter((name) => !baseBones.has(name));
    if (missing.length > 0) {
      failures.push(`characters: ${id} binds unknown bones: ${missing.join(', ')}`);
    }
  }

  // 3. Animation libraries: required clips present, every track targets a base bone.
  const clips = new Set();
  for (const id of ANIMATION_IDS) {
    const document = await readBaked(manifest, id, failures);
    if (!document) continue;
    for (const animation of document.getRoot().listAnimations()) {
      clips.add(animation.getName());
      const offRig = new Set();
      for (const channel of animation.listChannels()) {
        const target = channel.getTargetNode();
        if (target && !baseBones.has(target.getName())) offRig.add(target.getName());
      }
      if (offRig.size > 0) {
        failures.push(
          `characters: clip "${animation.getName()}" targets non-rig nodes: ${[...offRig].join(', ')}`,
        );
      }
    }
  }
  for (const clip of REQUIRED_CLIPS) {
    if (!clips.has(clip)) failures.push(`characters: required clip "${clip}" is not baked`);
  }

  return { failures };
};
