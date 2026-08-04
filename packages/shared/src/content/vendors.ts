/**
 * Vendors (ITEMS_LOOT.md §6) — who buys and sells, and at what multiple.
 * Rows live in `content_vendors`; the panel authors stock lists, the server
 * prices every transaction from these numbers (never from client input).
 *
 * P8 ships the vendor SYSTEM plus a world anchor per vendor (a market post
 * with an `F` prompt). P11/P12 replace anchors with real NPCs standing in
 * real settlements — the vendor rows themselves don't change.
 */

import { z } from 'zod';

const vendorIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^vendor_[a-z0-9_]+$/, 'vendor ids look like vendor_<name>');

const itemRefSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^item_[a-z0-9_]+$/, 'item refs look like item_<category>_<name>');

/** Vendor archetypes (§6) — flavor + which tab the panel opens on. */
export const vendorKindSchema = z.enum([
  'general',
  'weaponsmith',
  'armorer',
  'alchemist',
  'collector',
]);
export type VendorKind = z.infer<typeof vendorKindSchema>;

const vendorStockSchema = z
  .object({
    itemId: itemRefSchema,
    /** Overrides the item's own value as the buy price (gold). */
    priceOverride: z.number().int().min(0).max(100000).nullable().default(null),
  })
  .strict();

export const vendorDefSchema = z
  .object({
    id: vendorIdSchema,
    name: z.string().min(1).max(48),
    kind: vendorKindSchema,
    /** Buy price multiple of item value (§5: players pay 100%). */
    buyMult: z.number().min(0.1).max(5).default(1),
    /** Sell price multiple (§5: 25%; the Collector pays more for junk). */
    sellMult: z.number().min(0.05).max(1).default(0.25),
    /** The Collector buys but sells nothing (§6). */
    stock: z.array(vendorStockSchema).max(60).default([]),
    /**
     * Where the market post stands until P12 places the real NPC. Null = the
     * vendor exists as data but has no world presence yet.
     */
    anchor: z
      .object({
        x: z.number().min(-2000).max(2000),
        z: z.number().min(-2000).max(2000),
        /** Interaction radius in metres. */
        radius: z.number().min(1).max(12).default(3.5),
      })
      .strict()
      .nullable()
      .default(null),
    greeting: z.string().max(160).default(''),
  })
  .strict();
export type VendorDef = z.infer<typeof vendorDefSchema>;

export const validateVendorDef = (raw: unknown): VendorDef => {
  const parsed = vendorDefSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const id = typeof raw === 'object' && raw !== null && 'id' in raw ? String(raw.id) : '?';
    throw new Error(
      `vendor ${id}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}`.trim(),
    );
  }
  return parsed.data;
};

/** How many sold stacks a session remembers for buyback (§6). */
export const BUYBACK_DEPTH = 10;
