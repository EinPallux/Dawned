/**
 * Merge a shared rig's animation clips into a character mesh that has none.
 *
 * KayKit ships its skeletons and adventurers the way our own player characters
 * are shipped: the mesh in one file and the animations in another, both bound to
 * the same named rig (`Rig_Medium`). Quaternius ships monsters with their clips
 * inside. The enemy pipeline bakes one model per file and the enemy renderer
 * expects the clips to be in it, so a KayKit character baked straight through
 * stands frozen and slides — which is what `pnpm assets:clips` reported for all
 * four skeletons (docs/design/NPCS_ENEMIES.md §4.1).
 *
 * This is a NAME-based rebind, not a retarget. Both documents carry the same 23
 * joints with the same names (`upperarm.r`, `wrist.l`, …), so every animation
 * channel can be pointed at the mesh document's node of the same name and the
 * sampler data is used unchanged. That is only sound because the rigs really
 * are identical; a channel whose joint has no counterpart is an error rather
 * than something to skip quietly, because skipping is how a limb ends up not
 * moving with nobody noticing. It would NOT work across packs — Quaternius rigs
 * name the same bone `UpperArm.R`, hang it off a different hierarchy and rest it
 * in a different pose, which is a retarget and a different job.
 *
 * Everything except the clips is then thrown away explicitly. An animation
 * library is a whole second character (its own skeleton, meshes, materials), and
 * relying on `prune()` to reclaim it does not work: the merged-in joints stay
 * alive because the merged-in skin still lists them, so they would ship.
 */

import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { mergeDocuments } from '@gltf-transform/functions';

/** Property lists that an animation library brings along and must not keep. */
const CARRIERS = ['listScenes', 'listNodes', 'listSkins', 'listMeshes', 'listMaterials'];

/**
 * @param meshPath  the character `.glb` (mesh + skin, no animations)
 * @param clipPaths one or more `.glb` files holding clips for the same rig
 * @returns the merged Document, and a report of what came across
 */
export const mergeClipsInto = async (meshPath, clipPaths) => {
  const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
  const target = await io.read(meshPath);
  const root = target.getRoot();

  if (root.listAnimations().length > 0) {
    throw new Error(`${meshPath} already has animations — merging would duplicate them`);
  }

  // Index the mesh's own nodes by name. Duplicates would make "the node called
  // wrist.l" ambiguous, and picking one silently is exactly the class of bug
  // this whole module exists to close.
  const byName = new Map();
  for (const node of root.listNodes()) {
    const name = node.getName();
    if (byName.has(name)) throw new Error(`${meshPath} has two nodes named "${name}"`);
    byName.set(name, node);
  }

  // What the character owns BEFORE anything is merged. Whatever is not in these
  // sets afterwards arrived with a clip library and has to go.
  const mine = {};
  for (const list of CARRIERS) mine[list] = new Set(root[list]());
  const keepBuffer = root.listBuffers()[0] ?? null;

  for (const clipPath of clipPaths) {
    const source = await io.read(clipPath);
    mergeDocuments(target, source);
  }

  // Rebind every arrived channel onto the character's own joint of the same
  // name, so the clip drives the mesh's skeleton rather than the copy that came
  // with it.
  const added = [];
  const skipped = [];
  const seen = new Set();
  for (const animation of root.listAnimations()) {
    const name = animation.getName();
    // Libraries split across files repeat their reference pose; the second copy
    // is not a second clip.
    if (seen.has(name)) {
      skipped.push(name);
      for (const channel of animation.listChannels()) channel.dispose();
      for (const sampler of animation.listSamplers()) sampler.dispose();
      animation.dispose();
      continue;
    }
    for (const channel of animation.listChannels()) {
      const node = channel.getTargetNode();
      if (!node) continue;
      const joint = byName.get(node.getName());
      if (!joint) {
        throw new Error(
          `${name}: channel targets joint "${node.getName()}", which ` +
            `${meshPath} does not have — these are not the same rig`,
        );
      }
      channel.setTargetNode(joint);
    }
    seen.add(name);
    added.push(name);
  }

  // Drop the library's own character. Skins first: a skin lists its joints, and
  // a listed joint survives `prune()` however orphaned the node itself is.
  for (const list of ['listSkins', 'listMeshes', 'listMaterials', 'listScenes', 'listNodes']) {
    for (const property of root[list]()) {
      if (!mine[list].has(property)) property.dispose();
    }
  }

  // A GLB may hold at most one buffer, and each merged document brought its
  // own. The clips' accessors are the reason this file exists, so they move to
  // the character's buffer rather than the extra buffers being dropped.
  if (keepBuffer) {
    for (const accessor of root.listAccessors()) accessor.setBuffer(keepBuffer);
    for (const buffer of root.listBuffers()) {
      if (buffer !== keepBuffer) buffer.dispose();
    }
  }

  return { document: target, added: added.sort(), skipped: skipped.sort() };
};
