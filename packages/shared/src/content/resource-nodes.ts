/**
 * Resource-node content — `content_resource_nodes` (PROFESSIONS.md §2–5,
 * DATABASE.md §3). The gathering half of P10.
 *
 * Split the same way enemies are: a **definition** says what a birch IS (which
 * profession, which tier, what it yields, how long it takes, what it looks
 * like) and a **placement** says where one stands. Two hundred birches share
 * one definition, so retuning birchwood is one row in the panel rather than two
 * hundred, and the map bake stays small — a placement is an id and a position.
 *
 * The map editor's `node` layer authors the placements; the Professions content
 * page authors the definitions. Publish resolves one against the other, the
 * same cross-check spawners get against the bestiary.
 */

import { z } from 'zod';
import { MAX_NODE_TIER, MIN_NODE_TIER, PROFESSIONS } from '../formulas/professions.js';
import { GATHER_CHANNEL_MS } from '../formulas/professions.js';

/** `node_<profession>_<name>` — readable in a spawn log and in the editor. */
export const nodeSlug = z
  .string()
  .min(3)
  .max(64)
  .regex(/^node_[a-z0-9_]+$/, 'resource node ids look like node_<profession>_<name>');

export const professionSchema = z.enum(PROFESSIONS);

/**
 * One thing a node can give. `qtyMin/qtyMax` is the roll for the ordinary
 * yield; `weight` picks between entries when there are several (a copper vein
 * that sometimes gives more stone than ore).
 */
export const nodeYieldSchema = z
  .object({
    itemId: z
      .string()
      .min(3)
      .max(64)
      .regex(/^item_[a-z0-9_]+$/, 'yields reference item ids'),
    qtyMin: z.number().int().min(1).max(99).default(1),
    qtyMax: z.number().int().min(1).max(99).default(1),
    weight: z.number().min(0.01).max(10_000).default(1),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.qtyMax < entry.qtyMin) {
      ctx.addIssue({
        code: 'custom',
        message: `${entry.itemId}: qtyMax ${entry.qtyMax} is below qtyMin ${entry.qtyMin}`,
      });
    }
  });
export type ResourceNodeYield = z.infer<typeof nodeYieldSchema>;

/**
 * The rare extra (§1.1 step 5). Rolled ONCE per gather against
 * `procChance(profLevel)`; if it lands, one entry is picked by weight. Empty =
 * this node has no rare drop, which is legal — not every herb hides a seed.
 */
export const nodeProcSchema = z
  .object({
    itemId: z
      .string()
      .min(3)
      .max(64)
      .regex(/^item_[a-z0-9_]+$/, 'procs reference item ids'),
    qtyMin: z.number().int().min(1).max(99).default(1),
    qtyMax: z.number().int().min(1).max(99).default(1),
    weight: z.number().min(0.01).max(10_000).default(1),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.qtyMax < entry.qtyMin) {
      ctx.addIssue({
        code: 'custom',
        message: `${entry.itemId}: qtyMax ${entry.qtyMax} is below qtyMin ${entry.qtyMin}`,
      });
    }
  });
export type ResourceNodeProc = z.infer<typeof nodeProcSchema>;

export const resourceNodeDefSchema = z
  .object({
    id: nodeSlug,
    name: z.string().min(2).max(48),
    profession: professionSchema,
    tier: z.number().int().min(MIN_NODE_TIER).max(MAX_NODE_TIER),
    /** Baked model shown while the node is standing. */
    modelRef: z.string().min(1).max(64),
    /**
     * Model shown once it is taken — a stump, a cracked rock, bare soil. Null
     * means the node simply disappears until it respawns, which is right for a
     * fishing spot and wrong for a tree.
     */
    depletedModelRef: z.string().max(64).nullable().default(null),
    /** What it normally gives; at least one entry — an empty node is a bug. */
    yields: z.array(nodeYieldSchema).min(1).max(6),
    /** The rare extra, rolled once per gather. May be empty. */
    procs: z.array(nodeProcSchema).max(6).default([]),
    /** Hold time before the speed bonus, ms (§1.1 step 3 default is 3 s). */
    channelMs: z.number().int().min(200).max(30_000).default(GATHER_CHANNEL_MS),
    /** How long until it comes back, ms (§1.1 step 4: 90–180 s, per node). */
    respawnMs: z
      .number()
      .int()
      .min(5_000)
      .max(3_600_000)
      .default(120_000)
      .describe('respawn delay'),
    /** Metres — how big the thing reads in the world, for the editor's rings. */
    radius: z.number().min(0.2).max(8).default(1),
    /** Extra proc rolls for a deliberately risky placement (§1.4). */
    bonusRolls: z.number().int().min(0).max(3).default(0),
  })
  .strict();
export type ResourceNodeDef = z.infer<typeof resourceNodeDefSchema>;

export const validateResourceNodeDef = (raw: unknown): ResourceNodeDef =>
  resourceNodeDefSchema.parse(raw);

/**
 * A node standing somewhere — the map editor's `node` layer, baked into
 * `placements.json`.
 *
 * Deliberately thin: everything about WHAT it is lives on the definition, so
 * moving a forest between tiers is a content edit and not a re-bake of every
 * placement.
 */
export const nodePlacementSchema = z
  .object({
    id: z.string().min(3).max(80),
    nodeId: nodeSlug,
    x: z.number(),
    z: z.number(),
    /** Y rotation, radians. Scatter-style variety without extra definitions. */
    rotation: z.number().default(0),
    /** Uniform scale — a big old oak and a sapling off one definition. */
    scale: z.number().min(0.3).max(3).default(1),
  })
  .strict();
export type NodePlacement = z.infer<typeof nodePlacementSchema>;

/**
 * Pick one weighted entry. Shared with the panel's preview so a simulated
 * gathering session and a real one draw from the same distribution.
 *
 * `roll` is a caller-supplied uniform in [0, 1) — the server passes its seeded
 * RNG, the panel passes a deterministic sequence, and neither needs to know how
 * the other gets its randomness.
 */
export const pickWeighted = <T extends { weight: number }>(
  entries: readonly T[],
  roll: number,
): T | null => {
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return null;
  let ticket = Math.min(0.999999, Math.max(0, roll)) * total;
  for (const entry of entries) {
    ticket -= entry.weight;
    if (ticket < 0) return entry;
  }
  return entries[entries.length - 1] ?? null;
};

export interface GatherStack {
  itemId: string;
  qty: number;
}

/**
 * What one gather gives: the ordinary yield, plus the proc when it lands.
 *
 * Takes its randomness as three explicit rolls rather than calling a generator,
 * so the server, the tests and the panel's preview all drive the SAME function
 * — the alternative is a preview that is merely similar to the real thing.
 */
export const rollGather = (
  def: ResourceNodeDef,
  rolls: { yieldPick: number; yieldQty: number; proc: number; procPick: number; procQty: number },
  procRate: number,
): { yields: GatherStack[]; proc: GatherStack | null } => {
  const chosen = pickWeighted(def.yields, rolls.yieldPick);
  const yields: GatherStack[] = [];
  if (chosen) {
    const span = chosen.qtyMax - chosen.qtyMin + 1;
    const qty = chosen.qtyMin + Math.floor(Math.min(0.999999, Math.max(0, rolls.yieldQty)) * span);
    yields.push({ itemId: chosen.itemId, qty });
  }
  let proc: GatherStack | null = null;
  if (def.procs.length > 0 && rolls.proc < procRate) {
    const hit = pickWeighted(def.procs, rolls.procPick);
    if (hit) {
      const span = hit.qtyMax - hit.qtyMin + 1;
      const qty = hit.qtyMin + Math.floor(Math.min(0.999999, Math.max(0, rolls.procQty)) * span);
      proc = { itemId: hit.itemId, qty };
    }
  }
  return { yields, proc };
};

/** Every item id a node can ever produce — publish resolves these against the catalogue. */
export const nodeItemRefs = (def: ResourceNodeDef): string[] => [
  ...def.yields.map((entry) => entry.itemId),
  ...def.procs.map((entry) => entry.itemId),
];
