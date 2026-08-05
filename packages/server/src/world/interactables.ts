/**
 * Interactable runtime (P11, WORLD.md §4.2–4.3).
 *
 * The `F` verb for everything that is not a resource node: chests, shrines,
 * campfires, signposts, portals, quest props, and the NPCs and boards that hand
 * quests out. Like nodes, none of these are entities — they never move and
 * there are hundreds, so they live in the bake and only their STATE travels.
 *
 * The rule that shapes this module: **a chest's state is per character.**
 * A one-shot chest (`respawnMs: 0`) is opened once by everyone rather than
 * raced for, which is the P8 loot-bag lesson applied to furniture — shared
 * world state turns a discovery into a competition, and a cache you find after
 * your friend has "already looted" it is a worse experience than the chest
 * being there for both of you. Timed chests (`respawnMs > 0`) are also
 * per-character; the timer is a personal cooldown, not a shared spawn.
 */

import {
  INTERACT_REFUSALS,
  fastTravelCost,
  type Interactable,
  type InteractRefusal,
  type NpcDef,
  type NpcPlacement,
  type Poi,
} from '@dawned/shared';
import type { ServerPlayer } from './player.js';

/** How close you have to be to press F on something, metres. */
export const INTERACT_RANGE_M = 3.5;

/** A placed NPC, resolved against its definition once at load. */
export interface ServerNpc {
  /** Placement id — how the wire addresses this instance. */
  id: string;
  /** Content id (`npc_marla`) — several instances may share one. */
  npcId: string;
  def: NpcDef;
  x: number;
  y: number;
  z: number;
  rotation: number;
}

/** What one character has done to one object. */
export interface InteractionRecord {
  /** Opened chests → when they may be opened again (0 = never). */
  openedUntilMs: number;
  /** Attuned shrines. */
  attuned: boolean;
  /** How many times a quest prop has been used (an interact step's counter). */
  uses: number;
}

export type InteractionLog = Map<string, InteractionRecord>;

export const emptyRecord = (): InteractionRecord => ({
  openedUntilMs: 0,
  attuned: false,
  uses: 0,
});

const distance2 = (ax: number, az: number, bx: number, bz: number): number =>
  (ax - bx) * (ax - bx) + (az - bz) * (az - bz);

/**
 * Build the NPC set from the bake.
 *
 * A placement whose definition is gone is DROPPED with a count, exactly as
 * orphaned resource nodes are: publish cross-checks the refs, so reaching here
 * means map and content drifted between two publishes, and refusing to boot
 * over one missing villager would take the world down for a content mistake.
 */
export const buildNpcs = (
  placements: readonly NpcPlacement[],
  defs: ReadonlyMap<string, NpcDef>,
  heightAt: (x: number, z: number) => number,
): { npcs: Map<string, ServerNpc>; orphans: string[] } => {
  const npcs = new Map<string, ServerNpc>();
  const orphans: string[] = [];
  for (const placement of placements) {
    const def = defs.get(placement.npcId);
    if (!def) {
      orphans.push(placement.npcId);
      continue;
    }
    npcs.set(placement.id, {
      id: placement.id,
      npcId: placement.npcId,
      def,
      x: placement.x,
      y: heightAt(placement.x, placement.z) + placement.yOffset,
      z: placement.z,
      rotation: placement.rotation,
    });
  }
  return { npcs, orphans };
};

/** Index the bake's interactables by id, resolving their ground height once. */
export const buildInteractables = (
  rows: readonly Interactable[],
  heightAt: (x: number, z: number) => number,
): Map<string, PlacedInteractable> => {
  const placed = new Map<string, PlacedInteractable>();
  for (const row of rows) {
    placed.set(row.id, { row, y: heightAt(row.x, row.z) + row.yOffset });
  }
  return placed;
};

export interface PlacedInteractable {
  row: Interactable;
  y: number;
}

/** Whatever the player is closest to and could press F on — object or NPC. */
export type InteractTarget =
  { kind: 'object'; object: PlacedInteractable } | { kind: 'npc'; npc: ServerNpc };

export const targetInReach = (
  objects: ReadonlyMap<string, PlacedInteractable>,
  npcs: ReadonlyMap<string, ServerNpc>,
  player: ServerPlayer,
): InteractTarget | null => {
  let best: InteractTarget | null = null;
  let bestDist = INTERACT_RANGE_M * INTERACT_RANGE_M;
  for (const object of objects.values()) {
    const dist = distance2(object.row.x, object.row.z, player.movement.x, player.movement.z);
    if (dist <= bestDist) {
      best = { kind: 'object', object };
      bestDist = dist;
    }
  }
  for (const npc of npcs.values()) {
    const dist = distance2(npc.x, npc.z, player.movement.x, player.movement.z);
    if (dist <= bestDist) {
      best = { kind: 'npc', npc };
      bestDist = dist;
    }
  }
  return best;
};

/** Is this object close enough to be used right now? */
export const withinInteractRange = (
  object: { x: number; z: number },
  player: ServerPlayer,
): boolean =>
  distance2(object.x, object.z, player.movement.x, player.movement.z) <=
  INTERACT_RANGE_M * INTERACT_RANGE_M;

/** What using an object resolved to — the caller turns this into effects. */
export type InteractResult =
  | { kind: 'refused'; reason: InteractRefusal }
  /** Roll this loot table into the player's bag. */
  | { kind: 'loot'; lootTableId: string; objectId: string }
  /** Show a line of text (signposts, quest props). */
  | { kind: 'read'; text: string; objectId: string }
  /** Shrine newly attuned — respawn anchor + travel node unlocked. */
  | { kind: 'attuned'; objectId: string }
  /** Shrine already attuned: open the travel map instead. */
  | { kind: 'travel_menu'; objectId: string }
  /** Campfire: the Cozy buff. */
  | { kind: 'rest'; objectId: string }
  /** Portal: move the player. */
  | { kind: 'teleport'; x: number; z: number; objectId: string }
  /** Quest prop with no text — pure interact-step fodder. */
  | { kind: 'touch'; objectId: string };

/**
 * Decide what pressing `F` on an object means.
 *
 * The client never chooses the verb: it sends "use this id" and the server
 * reads the object's kind. That is what stops a client asking to `attune` a
 * chest, and it is why `InteractOp` has one `use` rather than one op per verb.
 */
export const useObject = (
  object: PlacedInteractable,
  record: InteractionRecord,
  nowMs: number,
): InteractResult => {
  const row = object.row;
  switch (row.kind) {
    case 'chest': {
      if (record.openedUntilMs !== 0 && nowMs < record.openedUntilMs) {
        return { kind: 'refused', reason: INTERACT_REFUSALS.Emptied };
      }
      // A one-shot chest records `-1`: opened, never coming back. Using a
      // sentinel rather than `Infinity` keeps the column an integer.
      if (record.openedUntilMs === -1) {
        return { kind: 'refused', reason: INTERACT_REFUSALS.Emptied };
      }
      if (!row.lootTableId) return { kind: 'refused', reason: INTERACT_REFUSALS.Unknown };
      return { kind: 'loot', lootTableId: row.lootTableId, objectId: row.id };
    }
    case 'shrine':
      if (!record.attuned) return { kind: 'attuned', objectId: row.id };
      return { kind: 'travel_menu', objectId: row.id };
    case 'campfire':
      return { kind: 'rest', objectId: row.id };
    case 'signpost':
      return { kind: 'read', text: row.text, objectId: row.id };
    case 'portal':
      if (row.destX === null || row.destZ === null) {
        return { kind: 'refused', reason: INTERACT_REFUSALS.Unknown };
      }
      return { kind: 'teleport', x: row.destX, z: row.destZ, objectId: row.id };
    case 'quest_prop':
      return row.text.trim()
        ? { kind: 'read', text: row.text, objectId: row.id }
        : { kind: 'touch', objectId: row.id };
    default:
      return { kind: 'refused', reason: INTERACT_REFUSALS.Unknown };
  }
};

/** When a chest this player just opened becomes available again. */
export const chestCooldownUntil = (row: Interactable, nowMs: number): number =>
  row.respawnMs === 0 ? -1 : nowMs + row.respawnMs;

/**
 * Price a shrine hop with the SHARED formula, so the map editor's Travel card
 * and the game charge the same gold. That is why `fastTravelCost` went into
 * shared at A3-c rather than being written twice.
 */
export const travelPrice = (from: PlacedInteractable, to: PlacedInteractable): number =>
  fastTravelCost(from.row.x, from.row.z, to.row.x, to.row.z);

export type TravelResult =
  | { kind: 'refused'; reason: InteractRefusal }
  | { kind: 'travel'; cost: number; x: number; z: number };

/**
 * Check a shrine hop. Both ends must be travel nodes, the destination must be
 * ATTUNED (the source only has to be in reach — you are standing at it), and
 * the player must be able to pay.
 */
export const planTravel = (
  from: PlacedInteractable | undefined,
  to: PlacedInteractable | undefined,
  log: InteractionLog,
  player: ServerPlayer,
  gold: number,
): TravelResult => {
  if (!from || !to) return { kind: 'refused', reason: INTERACT_REFUSALS.Unknown };
  if (!from.row.travelNode || !to.row.travelNode) {
    return { kind: 'refused', reason: INTERACT_REFUSALS.Unknown };
  }
  if (!withinInteractRange(from.row, player)) {
    return { kind: 'refused', reason: INTERACT_REFUSALS.TooFar };
  }
  if (!log.get(to.row.id)?.attuned) {
    return { kind: 'refused', reason: INTERACT_REFUSALS.NotAttuned };
  }
  if (from.row.id === to.row.id) return { kind: 'refused', reason: INTERACT_REFUSALS.Unknown };
  const cost = travelPrice(from, to);
  if (gold < cost) return { kind: 'refused', reason: INTERACT_REFUSALS.NoGold };
  return { kind: 'travel', cost, x: to.row.x, z: to.row.z };
};

/**
 * POIs whose ring the player is standing in and has not discovered yet.
 *
 * Checked on a cadence rather than every tick (the world calls this once a
 * second, as zone discovery already is) — a discovery ring is 12 m across and
 * nobody crosses one in 50 ms.
 */
export const poisEntered = (
  pois: readonly Poi[],
  player: ServerPlayer,
  found: ReadonlySet<string>,
): Poi[] => {
  const entered: Poi[] = [];
  for (const poi of pois) {
    if (found.has(poi.id)) continue;
    if (distance2(poi.x, poi.z, player.movement.x, player.movement.z) <= poi.radius * poi.radius) {
      entered.push(poi);
    }
  }
  return entered;
};

/** Interactables near a point — the AOI filter for `InteractState`. */
export const interactablesNear = (
  objects: ReadonlyMap<string, PlacedInteractable>,
  x: number,
  z: number,
  radius: number,
): PlacedInteractable[] => {
  const limit = radius * radius;
  const near: PlacedInteractable[] = [];
  for (const object of objects.values()) {
    if (distance2(object.row.x, object.row.z, x, z) <= limit) near.push(object);
  }
  return near;
};
