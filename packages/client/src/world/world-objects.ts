/**
 * The people and the things you press `F` on (QUESTS_POI.md §3–§4) — villagers,
 * chests, notice boards, shrines and marked stumps.
 *
 * Built on the same split resource nodes use: the client already knows WHERE
 * everything stands (the bake's `placements.json`, downloaded with the map) and
 * WHAT it is (the published NPC definitions, fetched once), so the server only
 * ever sends the EXCEPTION list — which chests this character has emptied and
 * which shrines it has attuned.
 *
 * Two things here are deliberately not what you might expect:
 *
 *  - **An NPC has no model.** A character in this game is COMPOSED — base body
 *    plus outfit plus hair on one skeleton — so a villager reuses
 *    `composeCharacter`, exactly like a player. Pointing an NPC at a single
 *    baked mesh would stand a floating tunic in Dawnhaven, and would also throw
 *    away the whole UAL clip library, which is precisely what a quest giver
 *    needs (idle, talking, gestures).
 *  - **The glyph over their head is not our decision.** Whether Marla has
 *    something to offer, something in progress or something to hand in comes
 *    from the server's `QuestSync`, not from a client-side reading of the quest
 *    list — the same rule that keeps the client from deciding what `F` means.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Interactable, NpcDef, NpcPlacement, Poi } from '@dawned/shared';
import { composeCharacter, loadCharacterAssets, type ComposedCharacter } from './characters.js';

/**
 * How far the `F` prompt reaches, in metres.
 *
 * A hair under the server's `INTERACT_RANGE_M` (3.5), for the reason the node
 * prompt is: the server judges range on ITS copy of your position, which trails
 * the predicted one while you run, and a prompt that appears a step early
 * answers "Too far away." — which reads as a broken key.
 */
export const INTERACT_PROMPT_REACH_M = 3.1;

/** The UAL clip every composed rig has. Used when an authored one is missing. */
const FALLBACK_IDLE_CLIP = 'Idle_Loop';

/** What a quest giver is showing right now. Server-decided; we only draw it. */
export type QuestGlyph = 'none' | 'offer' | 'progress' | 'turnin';

/** Glyph → the mark and its colour. Drawn as canvas paths, never as font glyphs. */
const GLYPH_STYLE: Record<Exclude<QuestGlyph, 'none'>, { mark: string; color: string }> = {
  offer: { mark: '!', color: '#f2c14e' },
  progress: { mark: '?', color: '#6f7a8d' },
  turnin: { mark: '?', color: '#f2c14e' },
};

interface ManifestEntry {
  category?: string;
  file?: string;
}
interface Manifest {
  assets: Record<string, ManifestEntry>;
}

let propsPromise: Promise<Map<string, GLTF>> | null = null;

/**
 * Load every baked prop once (category `world/props`).
 *
 * The whole category rather than the refs in the current bake, because the
 * owner can place a chest in the map editor and republish without the client
 * shipping again — a prop that had to be fetched on sight would pop in a second
 * after you walked up to it, which is the one moment it needs to already exist.
 */
export const loadPropModels = (): Promise<Map<string, GLTF>> => {
  propsPromise ??= (async () => {
    const models = new Map<string, GLTF>();
    let manifest: Manifest;
    try {
      const response = await fetch('/assets/manifest.json');
      manifest = (await response.json()) as Manifest;
    } catch {
      console.warn('[objects] no asset manifest — interactables render as markers');
      return models;
    }
    const loader = new GLTFLoader();
    await Promise.all(
      Object.entries(manifest.assets)
        // `world/nature` too: a quest prop is legitimately a felled log, and the
        // node manager has already paid for those loads.
        .filter(
          ([, entry]) =>
            (entry.category === 'world/props' || entry.category === 'world/nature') && entry.file,
        )
        .map(async ([id, entry]) => {
          try {
            models.set(id, await loader.loadAsync(`/${entry.file!}`));
          } catch (error) {
            console.warn(`[objects] failed to load ${id}:`, error);
          }
        }),
    );
    return models;
  })();
  return propsPromise;
};

// three.js discriminator flag, narrowed without `any` (characters.ts idiom).
const isMesh = (object: THREE.Object3D): object is THREE.Mesh =>
  (object as Partial<THREE.Mesh>).isMesh === true;

interface NpcInstance {
  placement: NpcPlacement;
  def: NpcDef;
  group: THREE.Group;
  composed: ComposedCharacter | null;
  glyph: THREE.Sprite | null;
  glyphKind: QuestGlyph;
  seated: boolean;
  /** Next server time this NPC may bark at us, so walking past is not a wall. */
  nextBarkAt: number;
  bubble: THREE.Sprite | null;
  bubbleUntil: number;
}

interface PropInstance {
  row: Interactable;
  group: THREE.Group;
  model: THREE.Object3D | null;
  seated: boolean;
  /** Server time this becomes usable again; -1 = never (one-shot, emptied). */
  spentUntilMs: number;
  attuned: boolean;
}

/** What the `F` prompt is about. One shape for both kinds — the HUD reads it. */
export interface ObjectInReach {
  kind: 'npc' | 'object';
  id: string;
  /** Display name — "Marla", "Torv's Lost Crate". */
  name: string;
  distance: number;
  /** For an object: its `kind` (chest/shrine/board/...). For an NPC: its role. */
  flavour: string;
  /** True when the server has told us this one has nothing left to give. */
  spent: boolean;
  attuned: boolean;
}

export class WorldObjectManager {
  private readonly npcs = new Map<string, NpcInstance>();
  private readonly props = new Map<string, PropInstance>();
  private pois: readonly Poi[] = [];
  private serverTimeMs = 0;
  private serverTimeAt = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly models: Map<string, GLTF>,
  ) {}

  /**
   * Build everything the bake placed.
   *
   * A placement whose definition is missing is SKIPPED with a count, not drawn
   * as a question mark: publish refuses that combination, so reaching here means
   * this client is holding an older content bundle than the map — and an absent
   * villager is less confusing than a wrong one.
   */
  async build(
    npcPlacements: readonly NpcPlacement[],
    npcDefs: ReadonlyMap<string, NpcDef>,
    interactables: readonly Interactable[],
    pois: readonly Poi[],
  ): Promise<void> {
    this.pois = pois;

    const assets = await loadCharacterAssets();
    let unknownNpcs = 0;
    for (const placement of npcPlacements) {
      const def = npcDefs.get(placement.npcId);
      if (!def) {
        unknownNpcs++;
        continue;
      }
      const group = new THREE.Group();
      group.position.set(placement.x, 0, placement.z);
      group.rotation.y = placement.rotation;
      group.visible = false;

      const composed = assets.ok ? composeCharacter(assets, def.appearance) : null;
      if (composed) {
        composed.group.scale.setScalar(def.scale);
        // `randomizeStart` so a row of villagers does not breathe in lockstep,
        // which reads as a shop window rather than as a village.
        //
        // And FALL BACK when the authored clip does not exist. `play` answers
        // false for an unknown name and leaves the rig in its bind pose — a
        // T-pose, in the middle of the village, which is the single most
        // "this shipped broken" thing a game can show. An author's typo should
        // cost a breathing animation, not a person.
        if (!composed.play(def.idleClip, { randomizeStart: true })) {
          console.warn(
            `[objects] ${def.id}: no clip "${def.idleClip}" — falling back to Idle_Loop`,
          );
          composed.play(FALLBACK_IDLE_CLIP, { randomizeStart: true });
        }
        group.add(composed.group);
      }
      group.add(makeNameplate(def.name, def.title));
      this.scene.add(group);
      this.npcs.set(placement.id, {
        placement,
        def,
        group,
        composed,
        glyph: null,
        glyphKind: 'none',
        seated: false,
        nextBarkAt: 0,
        bubble: null,
        bubbleUntil: 0,
      });
    }
    if (unknownNpcs > 0) {
      console.warn(`[objects] ${unknownNpcs} npc placement(s) reference definitions we lack`);
    }

    for (const row of interactables) {
      const group = new THREE.Group();
      group.position.set(row.x, 0, row.z);
      group.rotation.y = row.rotation;
      group.visible = false;
      const model = this.instance(row.modelRef);
      if (model) group.add(model);
      group.add(makeNameplate(row.name, ''));
      this.scene.add(group);
      this.props.set(row.id, {
        row,
        group,
        model,
        seated: false,
        spentUntilMs: 0,
        attuned: false,
      });
    }
  }

  private instance(ref: string): THREE.Object3D | null {
    const gltf = this.models.get(ref);
    if (!gltf) return null;
    const object = gltf.scene.clone(true);
    object.traverse((child) => {
      if (!isMesh(child)) return;
      child.castShadow = true;
      child.receiveShadow = false;
    });
    return object;
  }

  /**
   * Adopt the server's exception list: what is spent, what we are attuned to.
   * Anything not named is usable, which is also how a chest comes BACK — it
   * drops out of the list, with no "respawn" message needed.
   */
  setInteractState(
    spent: readonly { objectId: string; untilMs: number }[],
    attuned: readonly string[],
    serverTimeMs: number,
  ): void {
    if (serverTimeMs > 0) {
      this.serverTimeMs = serverTimeMs;
      this.serverTimeAt = performance.now();
    }
    const taken = new Map(spent.map((entry) => [entry.objectId, entry.untilMs]));
    const isAttuned = new Set(attuned);
    for (const [id, prop] of this.props) {
      prop.spentUntilMs = taken.get(id) ?? 0;
      prop.attuned = isAttuned.has(id);
    }
  }

  /** Which glyph each NPC shows. Server-decided (QuestSync), never derived. */
  setQuestGlyphs(glyphs: ReadonlyMap<string, QuestGlyph>): void {
    for (const npc of this.npcs.values()) {
      const wanted = glyphs.get(npc.def.id) ?? 'none';
      if (wanted === npc.glyphKind) continue;
      npc.glyphKind = wanted;
      if (npc.glyph) {
        npc.group.remove(npc.glyph);
        npc.glyph.material.map?.dispose();
        npc.glyph.material.dispose();
        npc.glyph = null;
      }
      if (wanted !== 'none') {
        npc.glyph = makeGlyphSprite(wanted);
        npc.glyph.position.y = 2.5 * npc.def.scale;
        npc.group.add(npc.glyph);
      }
    }
  }

  /**
   * Seat everything on real ground, advance the idles, and bob the glyphs.
   *
   * `hasDataAt` before `heightAt` for the reason the P8 market posts taught: a
   * sampler with no chunk loaded answers `OCEAN_FLOOR_Y`, so a villager placed
   * before her terrain streamed would stand eleven metres under the island and
   * report herself perfectly fine.
   */
  update(
    dt: number,
    player: { x: number; z: number },
    ground: {
      hasDataAt: (x: number, z: number) => boolean;
      heightAt: (x: number, z: number) => number;
    },
  ): void {
    const now = performance.now();
    for (const npc of this.npcs.values()) {
      if (ground.hasDataAt(npc.placement.x, npc.placement.z)) {
        npc.group.position.y =
          ground.heightAt(npc.placement.x, npc.placement.z) + npc.placement.yOffset;
        npc.group.visible = true;
        npc.seated = true;
      } else {
        npc.group.visible = false;
        npc.seated = false;
      }
      npc.composed?.mixer.update(dt);
      if (npc.glyph) npc.glyph.position.y = 2.5 * npc.def.scale + Math.sin(now / 420) * 0.06;

      // Ambient barks (§3, "cheap life"): a line as you walk past, on the
      // definition's own cooldown. Deterministic per placement so two players
      // standing together hear the same villager say the same thing.
      if (npc.def.barks.length > 0 && npc.def.barkCooldownSec > 0 && npc.seated) {
        const distance = Math.hypot(player.x - npc.placement.x, player.z - npc.placement.z);
        if (distance < 9 && now >= npc.nextBarkAt) {
          const index = Math.floor(now / 1000 + npc.placement.x) % npc.def.barks.length;
          this.speak(npc, npc.def.barks[Math.abs(index)]?.text ?? '');
          npc.nextBarkAt = now + npc.def.barkCooldownSec * 1000;
        }
      }
      if (npc.bubble && now > npc.bubbleUntil) {
        npc.group.remove(npc.bubble);
        npc.bubble.material.map?.dispose();
        npc.bubble.material.dispose();
        npc.bubble = null;
      }
    }

    for (const prop of this.props.values()) {
      if (ground.hasDataAt(prop.row.x, prop.row.z)) {
        prop.group.position.y = ground.heightAt(prop.row.x, prop.row.z) + prop.row.yOffset;
        prop.group.visible = true;
        prop.seated = true;
      } else {
        prop.group.visible = false;
        prop.seated = false;
      }
    }
  }

  /** Put a one-liner over an NPC's head for a few seconds. */
  private speak(npc: NpcInstance, text: string): void {
    if (!text) return;
    if (npc.bubble) npc.group.remove(npc.bubble);
    npc.bubble = makeNameplate(text, '', '#cfd6e4');
    npc.bubble.position.y = 2.15 * npc.def.scale;
    npc.group.add(npc.bubble);
    npc.bubbleUntil = performance.now() + 4200;
  }

  /** Server time now, extrapolated from the last state we were sent. */
  private now(): number {
    return this.serverTimeMs + (performance.now() - this.serverTimeAt);
  }

  /**
   * What the `F` prompt is about: nearest thing in reach, NPCs winning ties.
   *
   * A person beats a prop at the same distance because a villager standing next
   * to their own notice board is the common case, and "talk to Marla" is almost
   * always what you meant.
   */
  inReach(x: number, z: number): ObjectInReach | null {
    let best: ObjectInReach | null = null;
    for (const [id, npc] of this.npcs) {
      if (!npc.seated) continue;
      const distance = Math.hypot(x - npc.placement.x, z - npc.placement.z);
      if (distance > INTERACT_PROMPT_REACH_M) continue;
      if (best && best.distance <= distance) continue;
      best = {
        kind: 'npc',
        id,
        name: npc.def.name,
        distance,
        flavour: npc.def.role,
        spent: false,
        attuned: false,
      };
    }
    for (const [id, prop] of this.props) {
      if (!prop.seated) continue;
      const distance = Math.hypot(x - prop.row.x, z - prop.row.z);
      if (distance > INTERACT_PROMPT_REACH_M) continue;
      if (best && (best.kind === 'npc' || best.distance <= distance)) continue;
      best = {
        kind: 'object',
        id,
        name: prop.row.name,
        distance,
        flavour: prop.row.kind,
        // `-1` is the one-shot sentinel: emptied and never coming back.
        spent: prop.spentUntilMs === -1 || prop.spentUntilMs > this.now(),
        attuned: prop.attuned,
      };
    }
    return best;
  }

  /** Where an NPC stands, so pressing `F` can turn the player to face them. */
  npcPosition(placementId: string): { x: number; z: number } | null {
    const npc = this.npcs.get(placementId);
    return npc ? { x: npc.placement.x, z: npc.placement.z } : null;
  }

  /** Every POI the bake carries — the world map draws these against the fog. */
  get poiList(): readonly Poi[] {
    return this.pois;
  }

  /** Shrine rows, for the travel map. */
  get shrines(): { id: string; name: string; x: number; z: number }[] {
    return [...this.props.values()]
      .filter((prop) => prop.row.travelNode)
      .map((prop) => ({ id: prop.row.id, name: prop.row.name, x: prop.row.x, z: prop.row.z }));
  }

  /**
   * Everything this client has actually SPAWNED, with where it stands.
   *
   * The P11-E DoD run navigates off this rather than off the map bake, and the
   * distinction is the whole point of the run: the bake is the docs, this is
   * what is on the player's screen. A stump the bake carries and the client
   * never seated is exactly the bug the DoD sentence — "using only in-game
   * affordances" — is written to catch.
   */
  get roster(): {
    kind: 'npc' | 'object';
    id: string;
    name: string;
    x: number;
    z: number;
    seated: boolean;
  }[] {
    const rows: {
      kind: 'npc' | 'object';
      id: string;
      name: string;
      x: number;
      z: number;
      seated: boolean;
    }[] = [];
    for (const [id, npc] of this.npcs) {
      rows.push({
        kind: 'npc',
        id,
        name: npc.def.name,
        x: npc.placement.x,
        z: npc.placement.z,
        seated: npc.seated,
      });
    }
    for (const [id, prop] of this.props) {
      rows.push({
        kind: 'object',
        id,
        name: prop.row.name,
        x: prop.row.x,
        z: prop.row.z,
        seated: prop.seated,
      });
    }
    return rows;
  }

  /** Counts for the debug overlay and the smoke run. */
  get stats(): { npcs: number; objects: number; pois: number; seated: number } {
    let seated = 0;
    for (const npc of this.npcs.values()) if (npc.seated) seated++;
    for (const prop of this.props.values()) if (prop.seated) seated++;
    return {
      npcs: this.npcs.size,
      objects: this.props.size,
      pois: this.pois.length,
      seated,
    };
  }

  dispose(): void {
    for (const npc of this.npcs.values()) this.scene.remove(npc.group);
    for (const prop of this.props.values()) this.scene.remove(prop.group);
    this.npcs.clear();
    this.props.clear();
  }
}

/**
 * Name (and title) over a head, as a canvas sprite.
 *
 * Measured rather than fixed-width — a 256 px canvas centre-aligned is what
 * clipped every enemy name past ~17 characters at P9, and "Dawnhaven Notice
 * Board" is longer than that.
 */
const makeNameplate = (name: string, title: string, color = '#ede6d4'): THREE.Sprite => {
  const nameFont = 'bold 30px system-ui, sans-serif';
  const titleFont = '20px system-ui, sans-serif';
  const padding = 18;

  const measure = document.createElement('canvas').getContext('2d');
  let width = name.length * 17;
  if (measure) {
    measure.font = nameFont;
    width = measure.measureText(name).width;
    if (title) {
      measure.font = titleFont;
      width = Math.max(width, measure.measureText(title).width);
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width + padding * 2);
  canvas.height = title ? 84 : 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(21,26,38,0.92)';
    ctx.font = nameFont;
    ctx.strokeText(name, canvas.width / 2, 28);
    ctx.fillStyle = color;
    ctx.fillText(name, canvas.width / 2, 28);
    if (title) {
      ctx.font = titleFont;
      ctx.lineWidth = 5;
      ctx.strokeText(title, canvas.width / 2, 62);
      ctx.fillStyle = '#9aa3b4';
      ctx.fillText(title, canvas.width / 2, 62);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true }),
  );
  const height = title ? 0.72 : 0.55;
  sprite.scale.set((canvas.width / canvas.height) * height, height, 1);
  sprite.position.y = 2.05;
  return sprite;
};

/**
 * The quest mark: a facetted diamond with the glyph cut into it.
 *
 * Drawn as canvas PATHS rather than as a text glyph for the reason the P9 rank
 * marks were — a font's `◆` is whatever the player's system decides it is, and
 * "Cut Facets" (UI_UX.md) is a shape language, not a character set.
 */
const makeGlyphSprite = (kind: Exclude<QuestGlyph, 'none'>): THREE.Sprite => {
  const style = GLYPH_STYLE[kind];
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.translate(48, 48);
    ctx.beginPath();
    ctx.moveTo(0, -40);
    ctx.lineTo(30, 0);
    ctx.lineTo(0, 40);
    ctx.lineTo(-30, 0);
    ctx.closePath();
    ctx.fillStyle = 'rgba(21,26,38,0.88)';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = style.color;
    ctx.stroke();
    ctx.font = 'bold 46px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = style.color;
    ctx.fillText(style.mark, 0, 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
  );
  sprite.scale.set(0.5, 0.5, 1);
  sprite.renderOrder = 10;
  return sprite;
};
