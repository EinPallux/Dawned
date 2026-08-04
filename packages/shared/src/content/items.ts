/**
 * Item content schema (ITEMS_LOOT.md §1–2, §7–8) — the data contract of every
 * thing a player can hold. Rows live in `content_items` (PK (id, status), def
 * jsonb, same pattern as abilities/enemies), are authored in Dawned-Admin,
 * validated here at every boundary (editor save, publish, server boot), and
 * interpreted by one inventory/equipment runtime.
 *
 * Stat budgets, armor baselines and weapon damage are FORMULAS (formulas/
 * items.ts) the editor ƒ-suggests and the publish validator warns about — an
 * item may deviate deliberately, but never by accident.
 */

import { z } from 'zod';
import { classIdSchema } from './abilities.js';

/** Content ids: slugs like `item_weapon_sword_dawnsteel`. */
const itemIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^item_[a-z0-9_]+$/, 'item ids look like item_<category>_<name>');

/**
 * What KIND of thing this is (ITEMS_LOOT.md §1). Drives stacking rules, vendor
 * behavior, tooltip layout and which sub-blocks below are meaningful.
 */
export const itemCategorySchema = z.enum([
  'weapon',
  'offhand',
  'armor',
  'jewelry',
  'consumable',
  'material',
  'quest',
  'junk',
]);
export type ItemCategory = z.infer<typeof itemCategorySchema>;

/** The 11 equipment slots (§2). `none` = not equippable. */
export const equipSlotSchema = z.enum([
  'mainhand',
  'offhand',
  'head',
  'chest',
  'legs',
  'boots',
  'gloves',
  'ring1',
  'ring2',
  'amulet',
  'trinket',
]);
export type EquipSlot = z.infer<typeof equipSlotSchema>;

export const EQUIP_SLOTS: readonly EquipSlot[] = [
  'mainhand',
  'offhand',
  'head',
  'chest',
  'legs',
  'boots',
  'gloves',
  'ring1',
  'ring2',
  'amulet',
  'trinket',
];

/**
 * Where an item WANTS to sit. Rings say `ring` and the runtime picks ring1 or
 * ring2 — the def never has to know which finger is free.
 */
export const itemSlotSchema = z.enum([
  'none',
  'mainhand',
  'offhand',
  'head',
  'chest',
  'legs',
  'boots',
  'gloves',
  'ring',
  'amulet',
  'trinket',
]);
export type ItemSlot = z.infer<typeof itemSlotSchema>;

/** Rarity (§2) — drives roll count, tooltip color and drop feel. */
export const raritySchema = z.enum(['common', 'uncommon', 'rare', 'epic', 'legendary']);
export type Rarity = z.infer<typeof raritySchema>;

export const RARITIES: readonly Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/** Rarity → UI color (UI_UX.md §1 defers to this table). */
export const RARITY_COLORS: Record<Rarity, string> = {
  common: '#E8E4D8',
  uncommon: '#3FBF5A',
  rare: '#3E8FE8',
  epic: '#A44FE0',
  legendary: '#F08A24',
};

/** Armor weight class — sets the free base armor per ilvl·slotWeight (§2). */
export const armorClassSchema = z.enum(['heavy', 'medium_heavy', 'medium', 'light']);
export type ArmorClass = z.infer<typeof armorClassSchema>;

/** The five attributes gear can carry (PROGRESSION.md §2). */
export const attributeKeySchema = z.enum(['str', 'agi', 'int', 'vit', 'end']);
export type AttributeKey = z.infer<typeof attributeKeySchema>;

/**
 * Flat stats an item grants while equipped. Attributes feed the SAME derived
 * stat fold the character sheet runs; armor/crit apply directly.
 */
export const itemStatsSchema = z
  .object({
    str: z.number().int().min(0).max(200).optional(),
    agi: z.number().int().min(0).max(200).optional(),
    int: z.number().int().min(0).max(200).optional(),
    vit: z.number().int().min(0).max(200).optional(),
    end: z.number().int().min(0).max(200).optional(),
    /** Flat armor on top of the slot's free baseline. */
    armor: z.number().min(0).max(500).optional(),
    /** Crit chance in percentage POINTS. */
    critPct: z.number().min(0).max(20).optional(),
  })
  .strict();
export type ItemStats = z.infer<typeof itemStatsSchema>;

/** Weapon block (§2): damage range + the two-hand flag that blocks offhands. */
const weaponSchema = z
  .object({
    dmgMin: z.number().min(1).max(999),
    dmgMax: z.number().min(1).max(999),
    /** Mage staves and great weapons: equipping one clears the offhand. */
    twoHanded: z.boolean().default(false),
  })
  .strict()
  .refine((weapon) => weapon.dmgMax >= weapon.dmgMin, 'dmgMax must be ≥ dmgMin');

/**
 * Epic+ minor effect (§2): a small, readable rider. The vocabulary is closed
 * on purpose — every entry has a runtime site, so a panel-authored effect can
 * never be a no-op the tooltip lies about.
 */
export const itemEffectSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('stat_pct'),
      /** Which derived stat, as a percent (Sprint speed, healing done…). */
      stat: z.enum(['moveSpeed', 'sprintSpeed', 'healingDone', 'maxHp', 'armor', 'damageDealt']),
      pct: z.number().min(-25).max(25),
    })
    .strict(),
  z
    .object({
      kind: z.literal('on_hit_effect'),
      /** Applies an ability-style effect on landing a basic (Emberbrand burn). */
      effectId: z.string().min(1).max(64),
      chancePct: z.number().min(1).max(100),
      durationMs: z.number().int().min(500).max(20000),
      /** Damage over time coefficient (0 = pure debuff). */
      coef: z.number().min(0).max(2).default(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal('on_kill_gold'),
      /** Treasure-hunter trinkets: bonus gold per kill. */
      gold: z.number().int().min(1).max(50),
    })
    .strict(),
]);
export type ItemEffect = z.infer<typeof itemEffectSchema>;

/**
 * Consumable behavior (§7). Potions share one cooldown lane; food applies a
 * timed buff after a sit-eat channel; antidotes cleanse a category.
 */
export const consumableSchema = z
  .object({
    /** Which cooldown lane this shares — `potion` is the 15 s family. */
    lane: z.enum(['potion', 'food', 'antidote']),
    cooldownMs: z.number().int().min(0).max(600000),
    /** Instant restore as a percent of the relevant max. */
    healPctMaxHp: z.number().min(0).max(100).default(0),
    restorePctResource: z.number().min(0).max(100).default(0),
    /** Stamina classes drink the same "tonic" family (§7). */
    restoreStamina: z.number().int().min(0).max(200).default(0),
    /** Timed buff (food/elixirs) — applied as a normal status effect. */
    buff: z
      .object({
        effectId: z.string().min(1).max(64),
        durationMs: z.number().int().min(1000).max(3600000),
        stats: itemStatsSchema,
        /** Regeneration while it runs (Traveler's Rations: +6% HP/s OOC). */
        hpPctPerSecond: z.number().min(0).max(20).default(0),
        /** Food breaks on damage; elixirs persist. */
        breaksOnDamage: z.boolean().default(false),
      })
      .strict()
      .optional(),
    /** Channel before it applies (food's sit-eat); 0 = instant. */
    channelMs: z.number().int().min(0).max(10000).default(0),
    /** Effect categories cleansed (antidote: poison/bleed). */
    cleanses: z.array(z.string().min(1).max(32)).max(4).optional(),
  })
  .strict();
export type ConsumableDef = z.infer<typeof consumableSchema>;

/**
 * The attribute pool a dropped copy may roll from (§2: "no INT swords"). The
 * COUNT of rolled attributes comes from rarity; the pool constrains which.
 * Empty/absent = the item never rolls (handcrafted uniques, consumables).
 */
const rollPoolSchema = z.array(attributeKeySchema).min(1).max(5);

export const itemDefSchema = z
  .object({
    id: itemIdSchema,
    name: z.string().min(1).max(48),
    category: itemCategorySchema,
    slot: itemSlotSchema.default('none'),
    rarity: raritySchema.default('common'),
    /** Intended character level (§2) — drives budgets and the level gate. */
    ilvl: z.number().int().min(1).max(30).default(1),
    /** Empty = usable by all classes; weapons/offhands lock (§2). */
    classLock: z.array(classIdSchema).max(4).default([]),
    /** Max per stack (§1: gear 1, consumables 20, materials/junk 50). */
    stack: z.number().int().min(1).max(50).default(1),
    /** Vendor buy price in gold; sell is a fraction of it (§5). */
    value: z.number().int().min(0).max(100000).default(0),
    /** Unique game-icons slug — publish refuses duplicates (§8). */
    icon: z.string().min(1).max(64),
    /** Baked model id for weapons/offhands (visible on the character). */
    modelRef: z.string().max(64).nullable().default(null),
    /** One-sentence worldbuilding line (§8). */
    flavor: z.string().max(200).default(''),
    /** Fixed stats every copy carries. */
    stats: itemStatsSchema.default({}),
    /** Attributes a dropped copy may roll (count from rarity). */
    rollPool: rollPoolSchema.optional(),
    weapon: weaponSchema.nullable().default(null),
    armorClass: armorClassSchema.nullable().default(null),
    effect: itemEffectSchema.nullable().default(null),
    consumable: consumableSchema.nullable().default(null),
    /** Level required to equip/use (defaults to ilvl at publish time). */
    requiresLevel: z.number().int().min(1).max(30).default(1),
    /** Quest items can't be dropped or sold (§1). */
    bound: z.boolean().default(false),
  })
  .strict()
  .superRefine((def, ctx) => {
    const equippable =
      def.category === 'weapon' ||
      def.category === 'offhand' ||
      def.category === 'armor' ||
      def.category === 'jewelry';
    if (equippable && def.slot === 'none') {
      ctx.addIssue({ code: 'custom', message: `${def.category} items need an equip slot` });
    }
    if (!equippable && def.slot !== 'none') {
      ctx.addIssue({ code: 'custom', message: `${def.category} items are not equippable` });
    }
    if (equippable && def.stack !== 1) {
      ctx.addIssue({ code: 'custom', message: 'equippable items never stack' });
    }
    if (def.category === 'weapon' && !def.weapon) {
      ctx.addIssue({ code: 'custom', message: 'weapons need a weapon damage block' });
    }
    if (def.category !== 'weapon' && def.weapon) {
      ctx.addIssue({ code: 'custom', message: 'only weapons carry a weapon block' });
    }
    if (def.category === 'armor' && !def.armorClass) {
      ctx.addIssue({ code: 'custom', message: 'armor needs an armor class' });
    }
    if (def.category === 'consumable' && !def.consumable) {
      ctx.addIssue({ code: 'custom', message: 'consumables need a consumable block' });
    }
    if (def.category !== 'consumable' && def.consumable) {
      ctx.addIssue({ code: 'custom', message: 'only consumables carry a consumable block' });
    }
    if (def.weapon?.twoHanded && def.slot !== 'mainhand') {
      ctx.addIssue({ code: 'custom', message: 'two-handed weapons occupy the main hand' });
    }
    if (def.classLock.length > 0 && def.category !== 'weapon' && def.category !== 'offhand') {
      // §2: "Class lock on weapons/offhands only; armor/jewelry usable by all".
      ctx.addIssue({ code: 'custom', message: 'only weapons/offhands may class-lock' });
    }
  });

export type ItemDef = z.infer<typeof itemDefSchema>;

/** Parse-or-throw with the item id in the message (publish/boot paths). */
export const validateItemDef = (raw: unknown): ItemDef => {
  const parsed = itemDefSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const id = typeof raw === 'object' && raw !== null && 'id' in raw ? String(raw.id) : '?';
    throw new Error(
      `item ${id}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}`.trim(),
    );
  }
  return parsed.data;
};

/** Which equip slot(s) an item may occupy — rings resolve to either finger. */
export const equipSlotsFor = (def: ItemDef): readonly EquipSlot[] => {
  if (def.slot === 'none') return [];
  if (def.slot === 'ring') return ['ring1', 'ring2'];
  return [def.slot];
};

/** True when the item is gear the paper-doll can hold. */
export const isEquippable = (def: ItemDef): boolean => def.slot !== 'none';

/** How many attributes a dropped copy rolls (§2 rarity table). */
export const ROLLS_BY_RARITY: Record<Rarity, number> = {
  common: 1,
  uncommon: 2,
  rare: 3,
  epic: 3,
  legendary: 0, // handcrafted: everything is authored, nothing rolls
};
