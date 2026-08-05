/**
 * Node prompt targeting (P10-F).
 *
 * `inReach` decides what the `F` key is about, and it is the one piece of the
 * gathering client that is a DECISION rather than geometry or presentation:
 * which of several overlapping nodes you meant, whether a stump still answers,
 * and whether a node whose ground has not streamed can be interacted with at
 * all. Getting it wrong is a key that does the wrong thing while looking
 * right, which no amount of playing catches quickly.
 *
 * Rendering is not tested here — that is what the browser run is for.
 */

import { describe, expect, it } from 'vitest';
import { validateResourceNodeDef, type NodePlacement, type ResourceNodeDef } from '@dawned/shared';
import * as THREE from 'three';
import { ResourceNodeManager } from './resource-nodes.js';

const BIRCH: ResourceNodeDef = validateResourceNodeDef({
  id: 'node_woodcutting_birch',
  name: 'Birch',
  profession: 'woodcutting',
  tier: 1,
  modelRef: 'world_nature_birchtree_2',
  yields: [{ itemId: 'item_material_birchwood_log', qtyMin: 1, qtyMax: 1, weight: 1 }],
  radius: 1.4,
});
const VEIN: ResourceNodeDef = validateResourceNodeDef({
  id: 'node_mining_copper',
  name: 'Copper Vein',
  profession: 'mining',
  tier: 1,
  modelRef: 'world_nature_rock_2_a_color1',
  yields: [{ itemId: 'item_material_copper_ore', qtyMin: 1, qtyMax: 1, weight: 1 }],
  radius: 1,
});
const DEFS = new Map([
  [BIRCH.id, BIRCH],
  [VEIN.id, VEIN],
]);

const place = (id: string, nodeId: string, x: number, z: number): NodePlacement => ({
  id,
  nodeId,
  x,
  z,
  rotation: 0,
  scale: 1,
});

/** Flat ground everywhere, unless the test says a spot has not streamed. */
const flatGround = (missing: (x: number, z: number) => boolean = () => false) => ({
  heightAt: () => 0,
  hasDataAt: (x: number, z: number) => !missing(x, z),
});

/** A manager with no models — geometry is irrelevant to the reach decision. */
const build = (placements: NodePlacement[]): ResourceNodeManager => {
  const manager = new ResourceNodeManager(new THREE.Scene(), new Map());
  manager.build(placements, DEFS);
  return manager;
};

describe('what F is about', () => {
  it('finds nothing before the ground under a node has streamed', () => {
    const manager = build([place('n1', BIRCH.id, 0, 0)]);
    manager.update(
      flatGround(() => true),
      0,
    );
    expect(manager.inReach(0, 0)).toBeNull();
    expect(manager.stats.seated).toBe(0);
  });

  it('finds the node you are standing at once its ground is real', () => {
    const manager = build([place('n1', BIRCH.id, 0, 0)]);
    manager.update(flatGround(), 0);
    expect(manager.inReach(1, 0)?.placementId).toBe('n1');
  });

  /**
   * The reach is the prompt's, plus the node's own radius: a big oak's trunk
   * starts further from its centre than a herb's does, and a prompt measured
   * to the centre would make the tree unreachable from where you are visibly
   * touching it.
   */
  it('reaches further for a wider node', () => {
    const manager = build([place('tree', BIRCH.id, 0, 0), place('rock', VEIN.id, 40, 0)]);
    manager.update(flatGround(), 0);
    expect(manager.inReach(4.4, 0)?.placementId).toBe('tree');
    expect(manager.inReach(4.4, 0)).not.toBeNull();
    // The rock's smaller radius runs out sooner at the same offset.
    expect(manager.inReach(44.4, 0)).toBeNull();
    expect(manager.inReach(44, 0)?.placementId).toBe('rock');
  });

  it('picks the nearer of two nodes in reach', () => {
    const manager = build([place('near', VEIN.id, 0, 0), place('far', VEIN.id, 2.5, 0)]);
    manager.update(flatGround(), 0);
    expect(manager.inReach(0.4, 0)?.placementId).toBe('near');
    expect(manager.inReach(2.2, 0)?.placementId).toBe('far');
  });

  /**
   * A standing node beats a spent one at the same distance, always. Otherwise
   * chopping one tree in a grove makes the stump steal the prompt from the
   * live tree beside it — which reads as the key breaking after one use.
   */
  it('prefers a standing node over a depleted one', () => {
    const manager = build([place('spent', BIRCH.id, 0, 0), place('whole', BIRCH.id, 1.5, 0)]);
    manager.setDepleted([{ id: 'spent', readyAtMs: 90_000 }], 0);
    manager.update(flatGround(), 0);
    expect(manager.inReach(0, 0)?.placementId).toBe('whole');
  });

  it('still answers for a depleted node, with its countdown', () => {
    const manager = build([place('spent', BIRCH.id, 0, 0)]);
    manager.setDepleted([{ id: 'spent', readyAtMs: 42_000 }], 10_000);
    manager.update(flatGround(), 0);
    const found = manager.inReach(0, 0);
    expect(found?.depleted).toBe(true);
    expect(found?.readyInSec).toBeGreaterThan(30);
    expect(found?.readyInSec).toBeLessThanOrEqual(32);
  });

  /**
   * A node comes BACK by dropping out of the exception list — there is no
   * respawn message. If this ever regressed, every gathered node would stay a
   * stump for the rest of the session while the server thought it was whole.
   */
  it('restores a node that leaves the depleted list', () => {
    const manager = build([place('n1', BIRCH.id, 0, 0)]);
    manager.setDepleted([{ id: 'n1', readyAtMs: 90_000 }], 0);
    manager.update(flatGround(), 0);
    expect(manager.stats.depleted).toBe(1);
    manager.setDepleted([], 95_000);
    manager.update(flatGround(), 0);
    expect(manager.stats.depleted).toBe(0);
    expect(manager.inReach(0, 0)?.depleted).toBe(false);
  });

  it('skips placements whose definition this client does not have', () => {
    const manager = build([place('n1', BIRCH.id, 0, 0), place('ghost', 'node_mining_ghost', 2, 0)]);
    manager.update(flatGround(), 0);
    expect(manager.stats.total).toBe(1);
  });

  it('knows where a placement stands, for the gather-facing turn', () => {
    const manager = build([place('n1', BIRCH.id, 12, -4)]);
    manager.update(flatGround(), 0);
    expect(manager.positionOf('n1')).toEqual({ x: 12, y: 0, z: -4 });
    expect(manager.positionOf('nope')).toBeNull();
  });
});
