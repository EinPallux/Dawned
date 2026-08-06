import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { mergeClipsInto } from './merge-clips.mjs';
import { REPO_ROOT } from './build.mjs';

/**
 * Runs against the REAL pack, not a fixture: the whole claim of this module is
 * "these two files describe the same rig", and a fixture I build myself would
 * be one I made true. If KayKit ever ships a different `Rig_Medium`, that is
 * exactly the day these should fail.
 */
const PACK = path.join(REPO_ROOT, 'assets/enemy_models/KayKit_Skeletons_1.1_FREE');
const MESH = path.join(PACK, 'characters/gltf/Skeleton_Warrior.glb');
const CLIPS = [
  path.join(PACK, 'Animations/gltf/Rig_Medium/Rig_Medium_General.glb'),
  path.join(PACK, 'Animations/gltf/Rig_Medium/Rig_Medium_MovementBasic.glb'),
];

describe('merging a shared rig library into a character', () => {
  it('brings every clip across, once', async () => {
    const { added, skipped } = await mergeClipsInto(MESH, CLIPS);
    expect(added).toContain('Idle_A');
    expect(added).toContain('Running_A');
    expect(added).toContain('Death_A');
    expect(new Set(added).size).toBe(added.length);
    // Both library files carry the reference pose; the second is not a clip.
    expect(skipped).toEqual(['T-Pose']);
  });

  it('leaves ONE skeleton behind, with every channel bound to it', async () => {
    const { document } = await mergeClipsInto(MESH, CLIPS);
    const root = document.getRoot();

    // The failure this guards is a stowaway: a library is a whole second
    // character, and its skin keeps its own joints alive through `prune()` —
    // so the model would ship two skeletons and animate the invisible one.
    expect(root.listSkins()).toHaveLength(1);
    const joints = new Set(root.listSkins()[0].listJoints());

    let channels = 0;
    for (const animation of root.listAnimations()) {
      for (const channel of animation.listChannels()) {
        channels++;
        expect(joints.has(channel.getTargetNode())).toBe(true);
      }
    }
    expect(channels).toBeGreaterThan(0);
  });

  it('does not touch the mesh it merged into', async () => {
    const { document } = await mergeClipsInto(MESH, CLIPS);
    const triangles = (doc) => {
      let total = 0;
      for (const mesh of doc.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
          const indices = primitive.getIndices();
          total += (indices ?? primitive.getAttribute('POSITION')).getCount() / 3;
        }
      }
      return Math.round(total);
    };
    // Read the untouched file through the same path to compare against.
    const { document: again } = await mergeClipsInto(MESH, []);
    expect(triangles(document)).toBe(triangles(again));
    expect(document.getRoot().listMeshes().length).toBe(again.getRoot().listMeshes().length);
  });

  it('animates: a walk cycle moves joints it targets', async () => {
    const { document } = await mergeClipsInto(MESH, CLIPS);
    const walk = document
      .getRoot()
      .listAnimations()
      .find((animation) => animation.getName() === 'Walking_A');

    // A cycle LOOPS, so its first and last keyframe are identical by design —
    // the range across every key is what says a track carries motion. Written
    // the other way first, it reported "0 of 69 tracks move" on good data.
    let moving = 0;
    for (const channel of walk.listChannels()) {
      const output = channel.getSampler().getOutput();
      const size = output.getElementSize();
      const low = new Array(size).fill(Infinity);
      const high = new Array(size).fill(-Infinity);
      for (let key = 0; key < output.getCount(); key++) {
        const element = output.getElement(key, new Array(size));
        for (let i = 0; i < size; i++) {
          low[i] = Math.min(low[i], element[i]);
          high[i] = Math.max(high[i], element[i]);
        }
      }
      if (high.some((value, i) => value - low[i] > 1e-4)) moving++;
    }
    expect(moving).toBeGreaterThan(10);
  });

  it('refuses a library rigged differently rather than skipping its channels', async () => {
    const foreign = path.join(REPO_ROOT, 'assets/enemy_models/Quaternius Monster Bundle/Orc.glb');
    // Quaternius names the same bone `UpperArm.R` where KayKit says
    // `upperarm.r`, hangs it off a different hierarchy and rests it in a
    // different pose. That is a retarget, and silently dropping the channels it
    // cannot match would produce a character that moves half its limbs.
    await expect(mergeClipsInto(MESH, [foreign])).rejects.toThrow(/not the same rig/);
  });
});
