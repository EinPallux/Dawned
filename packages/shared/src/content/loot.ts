/**
 * Loot tables (ITEMS_LOOT.md §4) — what a kill, a chest or a gathering node
 * pays out. Rows live in `content_loot_tables`; tables NEST (enemy → "T1
 * humanoid" → "T1 generic gear") so a tier's gear pool is authored once.
 *
 * The roller here is the only one in the project: the admin simulator runs it
 * over 1,000 seeded rolls to show a distribution, and the server runs it on
 * death. Same code, same numbers — the preview cannot lie.
 */

import { z } from 'zod';
import type { Rng } from '../formulas/damage.js';

/** Content ids: slugs like `loot_dawnshore_trash`. */
const lootTableIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^loot_[a-z0-9_]+$/, 'loot table ids look like loot_<name>');

const itemRefSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^item_[a-z0-9_]+$/, 'item refs look like item_<category>_<name>');

/**
 * One weighted outcome. `nothing` is a first-class entry: most trash rolls pay
 * no gear, and saying so in DATA (rather than hiding it in roller code) is
 * what lets the panel show an honest drop-rate preview.
 */
const lootEntrySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('item'),
      ref: itemRefSchema,
      weight: z.number().min(0.01).max(10000),
      minQty: z.number().int().min(1).max(50).default(1),
      maxQty: z.number().int().min(1).max(50).default(1),
      /** Gate by killer level (low-level players don't pull T3 gear). */
      minKillerLevel: z.number().int().min(1).max(30).optional(),
    })
    .strict()
    .refine((entry) => entry.maxQty >= entry.minQty, 'maxQty must be ≥ minQty'),
  z
    .object({
      kind: z.literal('table'),
      ref: lootTableIdSchema,
      weight: z.number().min(0.01).max(10000),
      minKillerLevel: z.number().int().min(1).max(30).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('gold'),
      weight: z.number().min(0.01).max(10000),
      minQty: z.number().int().min(1).max(100000),
      maxQty: z.number().int().min(1).max(100000),
    })
    .strict()
    .refine((entry) => entry.maxQty >= entry.minQty, 'maxQty must be ≥ minQty'),
  z
    .object({
      kind: z.literal('nothing'),
      weight: z.number().min(0.01).max(10000),
    })
    .strict(),
]);
export type LootEntry = z.infer<typeof lootEntrySchema>;

export const lootTableDefSchema = z
  .object({
    id: lootTableIdSchema,
    name: z.string().min(1).max(48),
    entries: z.array(lootEntrySchema).min(1).max(40),
  })
  .strict();
export type LootTableDef = z.infer<typeof lootTableDefSchema>;

export const validateLootTableDef = (raw: unknown): LootTableDef => {
  const parsed = lootTableDefSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const id = typeof raw === 'object' && raw !== null && 'id' in raw ? String(raw.id) : '?';
    throw new Error(
      `loot table ${id}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}`.trim(),
    );
  }
  return parsed.data;
};

/** What a roll produced. Gold is aggregated by the caller. */
export type LootDrop =
  { kind: 'item'; itemId: string; qty: number } | { kind: 'gold'; qty: number };

export interface LootContext {
  /** Level of the player the roll is for (entry gates read this). */
  killerLevel: number;
}

/** Nesting guard — a cycle in authored data must not hang the server. */
const MAX_TABLE_DEPTH = 6;

const eligible = (entry: LootEntry, context: LootContext): boolean => {
  if (entry.kind === 'gold' || entry.kind === 'nothing') return true;
  return entry.minKillerLevel === undefined || context.killerLevel >= entry.minKillerLevel;
};

const pickEntry = (
  entries: readonly LootEntry[],
  context: LootContext,
  rng: Rng,
): LootEntry | null => {
  const pool = entries.filter((entry) => eligible(entry, context));
  const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return null;
  let ticket = rng() * total;
  for (const entry of pool) {
    ticket -= entry.weight;
    if (ticket <= 0) return entry;
  }
  return pool[pool.length - 1] ?? null;
};

const qtyBetween = (min: number, max: number, rng: Rng): number =>
  min + Math.floor(rng() * (max - min + 1));

/**
 * Roll one table `rolls` times. Nested tables resolve recursively (depth- and
 * cycle-guarded); unknown refs are skipped rather than thrown — publish-time
 * cross-checks are the gate, and a live server must never crash on content.
 */
export const rollLootTable = (
  tables: ReadonlyMap<string, LootTableDef>,
  tableId: string,
  rolls: number,
  context: LootContext,
  rng: Rng,
): LootDrop[] => {
  const drops: LootDrop[] = [];
  const rollOnce = (id: string, depth: number, seen: readonly string[]): void => {
    if (depth > MAX_TABLE_DEPTH || seen.includes(id)) return;
    const table = tables.get(id);
    if (!table) return;
    const entry = pickEntry(table.entries, context, rng);
    if (!entry || entry.kind === 'nothing') return;
    if (entry.kind === 'item') {
      drops.push({
        kind: 'item',
        itemId: entry.ref,
        qty: qtyBetween(entry.minQty, entry.maxQty, rng),
      });
    } else if (entry.kind === 'gold') {
      drops.push({ kind: 'gold', qty: qtyBetween(entry.minQty, entry.maxQty, rng) });
    } else {
      rollOnce(entry.ref, depth + 1, [...seen, id]);
    }
  };
  for (let roll = 0; roll < Math.max(0, rolls); roll++) rollOnce(tableId, 0, []);
  return drops;
};

/** Every table id a table can reach (publish cross-checks, cycle detection). */
export const referencedTables = (
  tables: ReadonlyMap<string, LootTableDef>,
  tableId: string,
  seen: Set<string> = new Set(),
): Set<string> => {
  if (seen.has(tableId)) return seen;
  seen.add(tableId);
  const table = tables.get(tableId);
  if (!table) return seen;
  for (const entry of table.entries) {
    if (entry.kind === 'table') referencedTables(tables, entry.ref, seen);
  }
  return seen;
};

/** True when following `table` refs from `tableId` returns to itself. */
export const hasCycle = (tables: ReadonlyMap<string, LootTableDef>, tableId: string): boolean => {
  const walk = (id: string, stack: readonly string[]): boolean => {
    if (stack.includes(id)) return true;
    const table = tables.get(id);
    if (!table) return false;
    return table.entries.some((entry) => entry.kind === 'table' && walk(entry.ref, [...stack, id]));
  };
  return walk(tableId, []);
};
