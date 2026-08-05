/**
 * Resource nodes in the world (PROFESSIONS.md §1) — the trees, veins, herb
 * patches and fishing spots you actually walk up to.
 *
 * The split that makes this cheap: the client already knows WHERE every node
 * is (the bake's `placements.json`, downloaded once with the map) and WHAT it
 * is (the published definitions, fetched once), so the only thing the server
 * ever has to send is the EXCEPTION list — which nodes are currently taken. A
 * world of four hundred nodes with three chopped is a three-entry message.
 *
 * Two failure modes shaped the code:
 *
 *  - **Seating.** A node planted before its terrain chunk has streamed sits on
 *    `OCEAN_FLOOR_Y`, which is how the P8 market posts ended up eleven metres
 *    under the island while reporting themselves fine. Nodes ask `hasDataAt`
 *    and stay hidden until the ground is real, and they re-level rather than
 *    latching, so a chunk that reloads does not leave a floating tree.
 *  - **Depletion has to READ.** A node that simply vanishes is indistinguishable
 *    from one that never existed. Every kind plays its own beat — a tree
 *    topples and leaves a felled log, a vein crumbles to bare stone, a herb
 *    puffs and leaves the ground, a shoal ripples out — and the depleted state
 *    is a MODEL from the definition, not a hidden object.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { NodePlacement, ResourceNodeDef } from '@dawned/shared';

interface ManifestEntry {
  category?: string;
  file?: string;
}
interface Manifest {
  assets: Record<string, ManifestEntry>;
}

/**
 * How far the `F` prompt reaches, in metres.
 *
 * Deliberately a hair under the server's `GATHER_RANGE_M` (3.5): the server
 * judges range on ITS copy of your position, which trails the predicted one
 * while you run. A prompt that appears a step early answers "Too far away.",
 * which reads as a broken key rather than as a step too many.
 */
export const NODE_PROMPT_REACH_M = 3.1;

/** Depletion beats, in ms — long enough to read, short enough not to wait on. */
const TOPPLE_MS = 900;
const CRUMBLE_MS = 520;
const PUFF_MS = 420;

/** What each profession's depletion looks like. */
type Beat = 'topple' | 'crumble' | 'puff' | 'ripple';
const BEAT: Record<string, Beat> = {
  woodcutting: 'topple',
  mining: 'crumble',
  herbalism: 'puff',
  fishing: 'ripple',
};

/** The verb the prompt uses (§1.1: `F — Chop/Mine/Pick/Fish`). */
export const GATHER_VERB: Record<string, string> = {
  woodcutting: 'Chop',
  mining: 'Mine',
  herbalism: 'Pick',
  fishing: 'Fish',
};

// three.js discriminator flag, narrowed without `any` (characters.ts idiom).
const isMesh = (object: THREE.Object3D): object is THREE.Mesh =>
  (object as Partial<THREE.Mesh>).isMesh === true;

let modelsPromise: Promise<Map<string, GLTF>> | null = null;

/**
 * Load every baked nature model once (category `world/nature`).
 *
 * The whole category rather than only the ones nodes use: foliage scatter
 * draws from the same set, the models are a few hundred kB together after the
 * P10-E texture squeeze, and a node whose model was not preloaded would pop in
 * a second after you walked up to it.
 */
export const loadNodeModels = (): Promise<Map<string, GLTF>> => {
  modelsPromise ??= (async () => {
    const models = new Map<string, GLTF>();
    let manifest: Manifest;
    try {
      const response = await fetch('/assets/manifest.json');
      manifest = (await response.json()) as Manifest;
    } catch {
      console.warn('[nodes] no asset manifest — resource nodes render as markers');
      return models;
    }
    const loader = new GLTFLoader();
    await Promise.all(
      Object.entries(manifest.assets)
        .filter(([, entry]) => entry.category === 'world/nature' && entry.file)
        .map(async ([id, entry]) => {
          try {
            models.set(id, await loader.loadAsync(`/${entry.file!}`));
          } catch (error) {
            console.warn(`[nodes] failed to load ${id}:`, error);
          }
        }),
    );
    return models;
  })();
  return modelsPromise;
};

interface NodeProp {
  placement: NodePlacement;
  def: ResourceNodeDef;
  group: THREE.Group;
  /** The standing model, hidden while the node is taken. */
  standing: THREE.Object3D | null;
  /** The depleted model, if the definition has one. */
  spent: THREE.Object3D | null;
  depleted: boolean;
  /** Server time it comes back — drives nothing but the prompt's wording. */
  readyAtMs: number;
  /** Animation in flight, if any. */
  beat: { kind: Beat; startedAt: number } | null;
  seated: boolean;
}

export interface NodeInReach {
  placementId: string;
  def: ResourceNodeDef;
  distance: number;
  depleted: boolean;
  readyInSec: number;
}

export class ResourceNodeManager {
  private readonly props = new Map<string, NodeProp>();
  private readonly ripples: {
    mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
    startedAt: number;
  }[] = [];
  /** Server clock from the last NodeStates, for respawn countdowns. */
  private serverTimeMs = 0;
  private serverTimeAt = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly models: Map<string, GLTF>,
  ) {}

  /**
   * Build every node the bake placed. Placements whose definition is not
   * published are SKIPPED with a warning rather than drawn as a question mark:
   * the map publish refuses that combination, so seeing one here means the
   * client is holding an older content bundle than the map, and an invisible
   * node is better than a wrong one.
   */
  build(placements: readonly NodePlacement[], defs: ReadonlyMap<string, ResourceNodeDef>): void {
    let unknown = 0;
    for (const placement of placements) {
      const def = defs.get(placement.nodeId);
      if (!def) {
        unknown++;
        continue;
      }
      const group = new THREE.Group();
      group.position.set(placement.x, 0, placement.z);
      group.rotation.y = placement.rotation;
      group.visible = false;

      const standing = this.instance(def.modelRef, placement.scale);
      if (standing) group.add(standing);
      const spent = def.depletedModelRef
        ? this.instance(def.depletedModelRef, placement.scale)
        : null;
      if (spent) {
        spent.visible = false;
        group.add(spent);
      }
      this.scene.add(group);
      this.props.set(placement.id, {
        placement,
        def,
        group,
        standing,
        spent,
        depleted: false,
        readyAtMs: 0,
        beat: null,
        seated: false,
      });
    }
    if (unknown > 0) {
      console.warn(
        `[nodes] ${unknown} placement(s) reference definitions this client does not have`,
      );
    }
  }

  /** Clone a baked model, scaled. Null when the ref was never baked. */
  private instance(ref: string, scale: number): THREE.Object3D | null {
    const gltf = this.models.get(ref);
    if (!gltf) return null;
    const object = gltf.scene.clone(true);
    object.scale.setScalar(scale);
    object.traverse((child) => {
      if (!isMesh(child)) return;
      child.castShadow = true;
      child.receiveShadow = false;
    });
    return object;
  }

  /**
   * Adopt the server's exception list. Anything not named is standing — which
   * is also how a node comes BACK: it drops out of the list and the standing
   * model returns, with no "respawn" message needed.
   */
  setDepleted(depleted: readonly { id: string; readyAtMs: number }[], serverTimeMs: number): void {
    this.serverTimeMs = serverTimeMs;
    this.serverTimeAt = performance.now();
    const taken = new Map(depleted.map((entry) => [entry.id, entry.readyAtMs]));
    for (const [id, prop] of this.props) {
      const readyAtMs = taken.get(id);
      const nowDepleted = readyAtMs !== undefined;
      if (nowDepleted === prop.depleted) {
        if (readyAtMs !== undefined) prop.readyAtMs = readyAtMs;
        continue;
      }
      prop.depleted = nowDepleted;
      prop.readyAtMs = readyAtMs ?? 0;
      if (nowDepleted) {
        // Only play the beat for a node the player can actually see happening.
        prop.beat = { kind: BEAT[prop.def.profession] ?? 'puff', startedAt: performance.now() };
        if (prop.beat.kind === 'ripple') this.spawnRipple(prop);
      } else {
        prop.beat = null;
        this.restore(prop);
      }
    }
  }

  /** Put a respawned node back the way it started. */
  private restore(prop: NodeProp): void {
    if (prop.standing) {
      prop.standing.visible = true;
      prop.standing.rotation.set(0, 0, 0);
      prop.standing.position.set(0, 0, 0);
      prop.standing.scale.setScalar(prop.placement.scale);
    }
    if (prop.spent) prop.spent.visible = false;
  }

  /** A spreading ring on the water where a shoal was. */
  private spawnRipple(prop: NodeProp): void {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.42, 24),
      new THREE.MeshBasicMaterial({
        color: '#bfe6ff',
        transparent: true,
        opacity: 0.75,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(prop.group.position);
    mesh.position.y += 0.08;
    this.scene.add(mesh);
    this.ripples.push({ mesh, startedAt: performance.now() });
  }

  /**
   * Seat every node on its ground and advance the depletion beats.
   *
   * Seating is not latched, for the same reason the market posts are not: a
   * node that seats itself once against un-streamed terrain is a node buried
   * for the rest of the session.
   */
  update(
    terrain: {
      heightAt: (x: number, z: number) => number;
      hasDataAt?: (x: number, z: number) => boolean;
    },
    nowMs: number,
  ): void {
    for (const prop of this.props.values()) {
      const { x, z } = prop.placement;
      if (terrain.hasDataAt && !terrain.hasDataAt(x, z)) {
        prop.group.visible = false;
        prop.seated = false;
        continue;
      }
      prop.group.position.y = terrain.heightAt(x, z);
      prop.group.visible = true;
      prop.seated = true;
      this.advance(prop, nowMs);
    }
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const ripple = this.ripples[i]!;
      const t = (nowMs - ripple.startedAt) / 1400;
      if (t >= 1) {
        this.scene.remove(ripple.mesh);
        ripple.mesh.geometry.dispose();
        ripple.mesh.material.dispose();
        this.ripples.splice(i, 1);
        continue;
      }
      ripple.mesh.scale.setScalar(1 + t * 5);
      ripple.mesh.material.opacity = 0.75 * (1 - t);
    }
  }

  /** One node's depletion animation, or its resting state. */
  private advance(prop: NodeProp, nowMs: number): void {
    if (!prop.depleted) return;
    const standing = prop.standing;
    if (!prop.beat) {
      if (standing) standing.visible = false;
      if (prop.spent) prop.spent.visible = true;
      return;
    }
    const elapsed = nowMs - prop.beat.startedAt;
    switch (prop.beat.kind) {
      case 'topple': {
        // Falls about its base rather than fading: a tree that dissolves is a
        // tree nobody believes they cut down.
        const t = Math.min(1, elapsed / TOPPLE_MS);
        if (standing) {
          // Ease-in — gravity, not a hinge on a spring.
          standing.rotation.z = (t * t * Math.PI) / 2;
          standing.visible = t < 1;
        }
        if (t >= 1) {
          if (prop.spent) prop.spent.visible = true;
          prop.beat = null;
        }
        break;
      }
      case 'crumble': {
        const t = Math.min(1, elapsed / CRUMBLE_MS);
        if (standing) {
          standing.scale.setScalar(prop.placement.scale * (1 - t));
          standing.position.y = -0.35 * t;
          standing.visible = t < 1;
        }
        if (t >= 1) {
          if (prop.spent) prop.spent.visible = true;
          prop.beat = null;
        }
        break;
      }
      case 'puff': {
        const t = Math.min(1, elapsed / PUFF_MS);
        if (standing) {
          standing.scale.setScalar(prop.placement.scale * (1 - t * 0.6));
          standing.position.y = -0.2 * t;
          standing.visible = t < 1;
        }
        if (t >= 1) {
          if (prop.spent) prop.spent.visible = true;
          prop.beat = null;
        }
        break;
      }
      case 'ripple': {
        // The ring does the talking; the fish just leaves.
        if (standing) standing.visible = false;
        if (elapsed > 200) prop.beat = null;
        break;
      }
    }
  }

  /** Server time now, extrapolated from the last NodeStates. */
  private now(): number {
    return this.serverTimeMs + (performance.now() - this.serverTimeAt);
  }

  /**
   * The node the `F` prompt is about — nearest within reach, standing ones
   * preferred. A depleted node still answers so the prompt can say when it is
   * back rather than going blank in front of a stump.
   */
  inReach(x: number, z: number): NodeInReach | null {
    let best: NodeInReach | null = null;
    for (const [id, prop] of this.props) {
      if (!prop.seated) continue;
      const distance = Math.hypot(x - prop.placement.x, z - prop.placement.z);
      if (distance > NODE_PROMPT_REACH_M + prop.def.radius) continue;
      // A standing node always wins over a spent one at the same spot.
      if (best && best.depleted === prop.depleted && best.distance <= distance) continue;
      if (best && !best.depleted && prop.depleted) continue;
      best = {
        placementId: id,
        def: prop.def,
        distance,
        depleted: prop.depleted,
        readyInSec: prop.depleted
          ? Math.max(0, Math.ceil((prop.readyAtMs - this.now()) / 1000))
          : 0,
      };
    }
    return best;
  }

  /** Where a placement stands, for the gather-facing turn. Null if unknown. */
  positionOf(placementId: string): { x: number; y: number; z: number } | null {
    const prop = this.props.get(placementId);
    if (!prop) return null;
    return { x: prop.placement.x, y: prop.group.position.y, z: prop.placement.z };
  }

  /** Counts for the debug overlay and the smoke run. */
  get stats(): { total: number; seated: number; depleted: number; depletedIds: string[] } {
    let seated = 0;
    const depletedIds: string[] = [];
    for (const [placementId, prop] of this.props) {
      if (prop.seated) seated++;
      if (prop.depleted) depletedIds.push(placementId);
    }
    return { total: this.props.size, seated, depleted: depletedIds.length, depletedIds };
  }

  dispose(): void {
    for (const prop of this.props.values()) this.scene.remove(prop.group);
    for (const ripple of this.ripples) {
      this.scene.remove(ripple.mesh);
      ripple.mesh.geometry.dispose();
      ripple.mesh.material.dispose();
    }
    this.ripples.length = 0;
    this.props.clear();
  }
}
