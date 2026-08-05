/**
 * Resource-node runtime (P10, docs/design/PROFESSIONS.md §1).
 *
 * A node is not an entity: it never moves, never fights, and there are hundreds
 * of them, so it does not get a slot in the snapshot. What the server actually
 * owns per node is small — is it standing, when does it come back, and who is
 * currently holding it — and that is what this module is.
 *
 * The interesting rule is §1.1's **first tap**. Two players swinging at one
 * tree must not both get logs, and the fair answer is not "whoever's packet
 * arrives first" (that rewards latency) or "both" (that prints materials): the
 * node is CLAIMED by whoever starts the channel, and the claim holds for the
 * length of that channel. A second player is told `claimed` immediately rather
 * than being allowed to hold for three seconds and then losing — being refused
 * up front is information; being refused at the end is a waste of your time.
 */

import {
  GATHER_BREAK_RANGE_M,
  GATHER_RANGE_M,
  GatherRefusal,
  gatherChannelMs,
  gatherRefusalFor,
  professionGatherXp,
  procChance,
  rollGather,
  type GatherStack,
  type NodePlacement,
  type Profession,
  type ResourceNodeDef,
} from '@dawned/shared';
import type { ServerPlayer } from './player.js';

/** One placed node's live state. Positions come from the bake and never change. */
export interface ServerNode {
  /** Placement id — what the client and the wire address it by. */
  id: string;
  /** Content id (`node_woodcutting_birch`). */
  nodeId: string;
  x: number;
  /** Ground height, resolved once at load. */
  y: number;
  z: number;
  /** null = standing. Otherwise the server time it comes back. */
  readyAtMs: number | null;
  /** Player id currently channelling on it (§1.1 first tap); 0 = free. */
  claimedBy: number;
}

/** A gather in progress. One per player — you cannot chop two trees at once. */
export interface GatherChannel {
  placementId: string;
  nodeId: string;
  profession: Profession;
  tier: number;
  startedAtMs: number;
  endsAtMs: number;
  /** Where the player stood when they started — the leash for "walked off". */
  originX: number;
  originZ: number;
}

export interface NodeContent {
  /** Published node definitions by id. */
  defs: ReadonlyMap<string, ResourceNodeDef>;
}

const distance2 = (ax: number, az: number, bx: number, bz: number): number =>
  (ax - bx) * (ax - bx) + (az - bz) * (az - bz);

/**
 * Build the runtime set from the bake's placements.
 *
 * A placement whose definition was deleted or renamed is DROPPED with a count
 * rather than throwing: publish already cross-checks node refs, so reaching
 * here means the map and the content drifted apart between two publishes, and
 * refusing to boot over one orphaned rock would take the world down for a
 * content mistake the owner can fix in the panel.
 */
export const buildNodes = (
  placements: readonly NodePlacement[],
  content: NodeContent,
  heightAt: (x: number, z: number) => number,
): { nodes: Map<string, ServerNode>; orphans: string[] } => {
  const nodes = new Map<string, ServerNode>();
  const orphans: string[] = [];
  for (const placement of placements) {
    if (!content.defs.has(placement.nodeId)) {
      orphans.push(placement.nodeId);
      continue;
    }
    nodes.set(placement.id, {
      id: placement.id,
      nodeId: placement.nodeId,
      x: placement.x,
      y: heightAt(placement.x, placement.z),
      z: placement.z,
      readyAtMs: null,
      claimedBy: 0,
    });
  }
  return { nodes, orphans };
};

/** Nodes within `radius` of a point — the AOI filter for NodeStates. */
export const nodesNear = (
  nodes: ReadonlyMap<string, ServerNode>,
  x: number,
  z: number,
  radius: number,
): ServerNode[] => {
  const limit = radius * radius;
  const near: ServerNode[] = [];
  for (const node of nodes.values()) {
    if (distance2(node.x, node.z, x, z) <= limit) near.push(node);
  }
  return near;
};

/** The nearest node a player could interact with right now, or null. */
export const nodeInReach = (
  nodes: ReadonlyMap<string, ServerNode>,
  player: ServerPlayer,
): ServerNode | null => {
  let best: ServerNode | null = null;
  let bestDist = GATHER_RANGE_M * GATHER_RANGE_M;
  for (const node of nodes.values()) {
    const dist = distance2(node.x, node.z, player.movement.x, player.movement.z);
    if (dist <= bestDist) {
      best = node;
      bestDist = dist;
    }
  }
  return best;
};

/**
 * Bring back everything whose timer has run out.
 *
 * Returns the ids that changed so the gateway can re-sync only the players who
 * can see them — a respawn nobody is standing near is still a state change, but
 * it does not have to be a packet.
 */
export const respawnNodes = (nodes: Map<string, ServerNode>, nowMs: number): string[] => {
  const back: string[] = [];
  for (const node of nodes.values()) {
    if (node.readyAtMs !== null && nowMs >= node.readyAtMs) {
      node.readyAtMs = null;
      node.claimedBy = 0;
      back.push(node.id);
    }
  }
  return back;
};

export interface GatherStartResult {
  ok: boolean;
  refusal?: GatherRefusal;
  channel?: GatherChannel;
}

/**
 * Try to begin a hold. Every check the client made is made again here — the
 * client's copy is a prediction and this is the answer (SECURITY.md §2).
 */
export const startGather = (
  player: ServerPlayer,
  node: ServerNode | undefined,
  def: ResourceNodeDef | undefined,
  profLevel: number,
  nowMs: number,
  busy: boolean,
): GatherStartResult => {
  if (!node || !def) return { ok: false, refusal: GatherRefusal.Unknown };
  if (node.readyAtMs !== null) return { ok: false, refusal: GatherRefusal.Depleted };
  // Claimed by someone else, and that someone is still holding: refuse NOW
  // rather than letting this player spend three seconds losing a race.
  if (node.claimedBy !== 0 && node.claimedBy !== player.id) {
    return { ok: false, refusal: GatherRefusal.Claimed };
  }
  if (busy) return { ok: false, refusal: GatherRefusal.Busy };
  const distance = Math.sqrt(distance2(node.x, node.z, player.movement.x, player.movement.z));
  const refusal = gatherRefusalFor(def.tier, profLevel, distance);
  if (refusal) return { ok: false, refusal };

  const duration = gatherChannelMs(def.tier, profLevel, def.channelMs);
  node.claimedBy = player.id;
  return {
    ok: true,
    channel: {
      placementId: node.id,
      nodeId: def.id,
      profession: def.profession,
      tier: def.tier,
      startedAtMs: nowMs,
      endsAtMs: nowMs + duration,
      originX: player.movement.x,
      originZ: player.movement.z,
    },
  };
};

/** Why an in-flight channel ended early, or null while it is still fine. */
export const channelBreak = (
  channel: GatherChannel,
  player: ServerPlayer,
  node: ServerNode | undefined,
): GatherRefusal | null => {
  if (!node) return GatherRefusal.Unknown;
  if (player.dead) return GatherRefusal.Busy;
  // Damage taken during the hold breaks it (§1.1 step 3). `lastCombatAtMs` is
  // set by every damage path, so this catches a poison tick as well as a hit.
  if (player.lastCombatAtMs > channel.startedAtMs) return GatherRefusal.Busy;
  const drift = Math.sqrt(
    distance2(channel.originX, channel.originZ, player.movement.x, player.movement.z),
  );
  if (drift > GATHER_BREAK_RANGE_M) return GatherRefusal.TooFar;
  return null;
};

export interface GatherRolls {
  yieldPick: number;
  yieldQty: number;
  proc: number;
  procPick: number;
  procQty: number;
}

export interface GatherAward {
  yields: GatherStack[];
  proc: GatherStack | null;
  profXp: number;
  /** Server time the node returns. */
  readyAtMs: number;
}

/**
 * Resolve a completed hold: what came out, what it was worth, and when the
 * node comes back. Deliberately pure — the caller does the bag and XP writes,
 * so this is the piece a test can drive without a world.
 */
export const finishGather = (
  def: ResourceNodeDef,
  profLevel: number,
  rolls: GatherRolls,
  nowMs: number,
): GatherAward => {
  const rate = procChance(profLevel, def.bonusRolls);
  const rolled = rollGather(def, rolls, rate);
  return {
    yields: rolled.yields,
    proc: rolled.proc,
    profXp: professionGatherXp(def.tier, profLevel),
    readyAtMs: nowMs + def.respawnMs,
  };
};

/** Drop a claim without depleting — cancel, break, disconnect. */
export const releaseClaim = (node: ServerNode | undefined, playerId: number): void => {
  if (node && node.claimedBy === playerId) node.claimedBy = 0;
};
