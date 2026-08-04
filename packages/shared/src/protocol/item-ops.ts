/**
 * The one client-authored JSON payload in the protocol (v10, `ClientOp.ItemOp`).
 *
 * Everything else the client sends is fixed-width binary the codec bounds by
 * construction; item intents carry slots, ids and quantities, so they get a
 * zod gate at the boundary — the project rule, and the reason a malformed or
 * malicious op can never reach the inventory planner.
 */

import { z } from 'zod';
import { equipSlotSchema } from '../content/items.js';

const gridSlot = z.number().int().min(0).max(47);
const quantity = z.number().int().min(1).max(50);
const itemRef = z
  .string()
  .min(1)
  .max(64)
  .regex(/^item_[a-z0-9_]+$/);
const vendorRef = z
  .string()
  .min(1)
  .max(64)
  .regex(/^vendor_[a-z0-9_]+$/);

export const itemOpSchema = z.discriminatedUnion('kind', [
  /** Drag a bag cell onto another (swap or merge). */
  z.object({ kind: z.literal('move'), from: gridSlot, to: gridSlot }).strict(),
  /** Shift-drag part of a stack into an empty cell. */
  z.object({ kind: z.literal('split'), from: gridSlot, to: gridSlot, qty: quantity }).strict(),
  /** Wear a bag item; `prefer` picks a ring finger. */
  z
    .object({ kind: z.literal('equip'), from: gridSlot, prefer: equipSlotSchema.optional() })
    .strict(),
  /** Take a piece off the paper-doll. */
  z.object({ kind: z.literal('unequip'), slot: equipSlotSchema }).strict(),
  /** Drink/eat a consumable. */
  z.object({ kind: z.literal('use'), from: gridSlot }).strict(),
  /** Sort button. */
  z.object({ kind: z.literal('sort') }).strict(),
  /** Throw away (quest/bound items refuse). */
  z.object({ kind: z.literal('drop'), from: gridSlot, qty: quantity }).strict(),
  /** Take one entry from a loot bag, or all of it when `index` is null. */
  z
    .object({
      kind: z.literal('loot'),
      bagId: z.number().int().min(1).max(0xffffffff),
      index: z.number().int().min(0).max(63).nullable(),
    })
    .strict(),
  /** Walk up to a market post and open its panel. */
  z.object({ kind: z.literal('vendorOpen'), vendorId: vendorRef }).strict(),
  z
    .object({
      kind: z.literal('vendorBuy'),
      vendorId: vendorRef,
      itemId: itemRef,
      qty: quantity,
    })
    .strict(),
  z
    .object({
      kind: z.literal('vendorSell'),
      vendorId: vendorRef,
      from: gridSlot,
      qty: quantity,
    })
    .strict(),
  z
    .object({
      kind: z.literal('vendorBuyback'),
      vendorId: vendorRef,
      index: z.number().int().min(0).max(9),
    })
    .strict(),
  /** Close the panel (drops the proximity lease server-side). */
  z.object({ kind: z.literal('vendorClose') }).strict(),
]);

export type ItemOp = z.infer<typeof itemOpSchema>;

/** Parse a wire payload; returns null for anything the schema refuses. */
export const parseItemOp = (raw: unknown): ItemOp | null => {
  const parsed = itemOpSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};
