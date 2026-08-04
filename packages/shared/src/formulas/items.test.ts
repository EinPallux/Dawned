/**
 * Item curve + loot roller tests — the numbers ITEMS_LOOT.md §2/§4/§5 fixes,
 * pinned so a refactor can't quietly re-balance the game.
 */

import { describe, expect, it } from 'vitest';
import { ROLLS_BY_RARITY, itemDefSchema, validateItemDef, type ItemDef } from '../content/items.js';
import {
  hasCycle,
  lootTableDefSchema,
  referencedTables,
  rollLootTable,
  type LootTableDef,
} from '../content/loot.js';
import { vendorDefSchema } from '../content/vendors.js';
import {
  RARITY_MULTS,
  SLOT_WEIGHTS,
  baseArmorFor,
  itemValue,
  killGold,
  rollItemStats,
  sellPriceFor,
  statBudget,
  totalItemStats,
  weaponDamageFor,
} from './items.js';

/** Deterministic RNG so every roll assertion is reproducible. */
const rng = (seed: number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

describe('stat budgets (§2)', () => {
  it('follows slotWeight × (4 + 1.1 × ilvl) × rarityMult', () => {
    // Chest, ilvl 10, rare: 1.0 × (4 + 11) × 1.35 = 20.25
    expect(statBudget('chest', 10, 'rare')).toBeCloseTo(20.25, 5);
    // Ring, ilvl 20, common: 0.4 × 26 = 10.4
    expect(statBudget('ring', 20, 'common')).toBeCloseTo(10.4, 5);
  });

  it('keeps the documented slot weights and rarity multipliers', () => {
    expect(SLOT_WEIGHTS.mainhand).toBe(1.0);
    expect(SLOT_WEIGHTS.chest).toBe(1.0);
    expect(SLOT_WEIGHTS.legs).toBe(0.85);
    expect(SLOT_WEIGHTS.head).toBe(0.7);
    expect(SLOT_WEIGHTS.ring).toBe(0.4);
    expect(RARITY_MULTS).toEqual({
      common: 1.0,
      uncommon: 1.15,
      rare: 1.35,
      epic: 1.6,
      legendary: 1.9,
    });
  });

  it('gives armor its free baseline by weight class', () => {
    // Heavy chest at ilvl 10: 6 × 1.0 × 10 = 60
    expect(baseArmorFor('heavy', 'chest', 10)).toBe(60);
    // Light boots at ilvl 10: 3 × 0.6 × 10 = 18
    expect(baseArmorFor('light', 'boots', 10)).toBe(18);
  });

  it('scales weapon damage as 3 + 1.6 × ilvl ± 12%', () => {
    const at10 = weaponDamageFor(10);
    expect((at10.min + at10.max) / 2).toBeCloseTo(19, 0); // avg 3 + 16
    expect(at10.min).toBe(Math.round(19 * 0.88));
    expect(at10.max).toBe(Math.round(19 * 1.12));
  });
});

describe('value and gold (§5)', () => {
  it('prices items from their budget and pays 25% on sale', () => {
    const value = itemValue('armor', 'chest', 10, 'rare');
    expect(value).toBe(Math.round(20.25 * 3 + 6));
    expect(sellPriceFor(value)).toBe(Math.floor(value * 0.25));
  });

  it('never sells anything for 0 gold, and quest items for nothing at all', () => {
    expect(sellPriceFor(3)).toBe(1);
    expect(sellPriceFor(0)).toBe(0);
    expect(itemValue('quest', 'none', 20, 'common')).toBe(0);
  });

  it('pays kill gold around 1.2 × mobLevel', () => {
    const random = rng(5);
    const samples = Array.from({ length: 500 }, () => killGold(10, random));
    const average = samples.reduce((sum, gold) => sum + gold, 0) / samples.length;
    expect(average).toBeGreaterThan(9);
    expect(average).toBeLessThan(15);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(1);
  });
});

const gearDef = (over: Partial<ItemDef> = {}): ItemDef =>
  itemDefSchema.parse({
    id: 'item_armor_chest_roll',
    name: 'Test Plate',
    icon: 'icon_plate',
    category: 'armor',
    slot: 'chest',
    ilvl: 10,
    rarity: 'rare',
    armorClass: 'heavy',
    rollPool: ['str', 'vit', 'end'],
    ...over,
  });

describe('rolled stats (§2)', () => {
  it('rolls exactly the rarity-appropriate number of attributes from the pool', () => {
    const random = rng(11);
    for (const rarity of ['common', 'uncommon', 'rare'] as const) {
      const def = gearDef({ rarity });
      const rolled = rollItemStats(def, random);
      expect(Object.keys(rolled)).toHaveLength(ROLLS_BY_RARITY[rarity]);
      for (const key of Object.keys(rolled)) expect(def.rollPool).toContain(key);
    }
  });

  it('spends the whole budget and never rolls a zero-point attribute', () => {
    const random = rng(3);
    const def = gearDef();
    for (let i = 0; i < 200; i++) {
      const rolled = rollItemStats(def, random);
      const total = Object.values(rolled).reduce((sum, points) => sum + points, 0);
      expect(total).toBe(Math.round(statBudget('chest', 10, 'rare')));
      for (const points of Object.values(rolled)) expect(points).toBeGreaterThanOrEqual(1);
    }
  });

  it('legendaries and pool-less items roll nothing (handcrafted)', () => {
    const random = rng(9);
    expect(rollItemStats(gearDef({ rarity: 'legendary' }), random)).toEqual({});
    expect(rollItemStats(gearDef({ rollPool: undefined }), random)).toEqual({});
  });

  it('folds fixed stats, free armor and the roll into one spread', () => {
    const def = gearDef({ stats: { str: 2, critPct: 1 } });
    const total = totalItemStats(def, { vit: 5 });
    expect(total.str).toBe(2);
    expect(total.vit).toBe(5);
    expect(total.critPct).toBe(1);
    expect(total.armor).toBe(baseArmorFor('heavy', 'chest', 10));
  });
});

describe('item schema guards (§1–2, §8)', () => {
  const base = { id: 'item_weapon_sword_a', name: 'Sword', icon: 'icon_sword' };

  it('accepts a complete weapon row', () => {
    const def = validateItemDef({
      ...base,
      category: 'weapon',
      slot: 'mainhand',
      ilvl: 5,
      classLock: ['warrior'],
      weapon: { dmgMin: 8, dmgMax: 12 },
      modelRef: 'items_weapons_sword_a',
    });
    expect(def.weapon?.twoHanded).toBe(false);
    expect(def.stack).toBe(1);
  });

  it('refuses equippables without a slot, and non-equippables with one', () => {
    expect(() =>
      validateItemDef({ ...base, category: 'weapon', weapon: { dmgMin: 1, dmgMax: 2 } }),
    ).toThrow(/equip slot/);
    expect(() =>
      validateItemDef({
        id: 'item_material_ore',
        name: 'Ore',
        icon: 'i',
        category: 'material',
        slot: 'chest',
      }),
    ).toThrow(/not equippable/);
  });

  it('refuses weapons without damage, armor without a class, consumables without a block', () => {
    expect(() => validateItemDef({ ...base, category: 'weapon', slot: 'mainhand' })).toThrow(
      /damage block/,
    );
    expect(() =>
      validateItemDef({
        id: 'item_armor_x',
        name: 'X',
        icon: 'i',
        category: 'armor',
        slot: 'head',
      }),
    ).toThrow(/armor class/);
    expect(() =>
      validateItemDef({ id: 'item_consumable_x', name: 'X', icon: 'i', category: 'consumable' }),
    ).toThrow(/consumable block/);
  });

  it('refuses stacking gear and class-locked armor (§2)', () => {
    expect(() =>
      validateItemDef({
        ...base,
        category: 'weapon',
        slot: 'mainhand',
        stack: 5,
        weapon: { dmgMin: 1, dmgMax: 2 },
      }),
    ).toThrow(/never stack/);
    expect(() =>
      validateItemDef({
        id: 'item_armor_y',
        name: 'Y',
        icon: 'i',
        category: 'armor',
        slot: 'head',
        armorClass: 'light',
        classLock: ['mage'],
      }),
    ).toThrow(/weapons\/offhands/);
  });

  it('keeps two-handers in the main hand', () => {
    expect(() =>
      validateItemDef({
        id: 'item_offhand_bad',
        name: 'Bad',
        icon: 'i',
        category: 'offhand',
        slot: 'offhand',
        weapon: { dmgMin: 1, dmgMax: 2, twoHanded: true },
      }),
    ).toThrow();
  });
});

describe('loot tables (§4)', () => {
  const tables = new Map<string, LootTableDef>(
    (
      [
        {
          id: 'loot_trash',
          name: 'Trash',
          entries: [
            { kind: 'nothing', weight: 70 },
            { kind: 'item', ref: 'item_junk_shell', weight: 20, minQty: 1, maxQty: 2 },
            { kind: 'table', ref: 'loot_gear', weight: 10 },
          ],
        },
        {
          id: 'loot_gear',
          name: 'Gear',
          entries: [
            { kind: 'item', ref: 'item_weapon_sword_a', weight: 1 },
            { kind: 'item', ref: 'item_armor_chest_a', weight: 1, minKillerLevel: 5 },
          ],
        },
        {
          id: 'loot_coins',
          name: 'Coins',
          entries: [{ kind: 'gold', weight: 1, minQty: 5, maxQty: 9 }],
        },
      ] as const
    ).map((raw) => {
      const table = lootTableDefSchema.parse(raw);
      return [table.id, table];
    }),
  );

  it('respects weights across many rolls', () => {
    const random = rng(21);
    const drops = rollLootTable(tables, 'loot_trash', 4000, { killerLevel: 10 }, random);
    const junk = drops.filter((drop) => drop.kind === 'item' && drop.itemId === 'item_junk_shell');
    // 20% of 4000 rolls, generous band for RNG noise.
    expect(junk.length).toBeGreaterThan(600);
    expect(junk.length).toBeLessThan(1000);
    // 30% of rolls produce nothing at all → far fewer drops than rolls.
    expect(drops.length).toBeLessThan(4000);
  });

  it('resolves nested tables', () => {
    const random = rng(4);
    const drops = rollLootTable(tables, 'loot_trash', 3000, { killerLevel: 10 }, random);
    expect(
      drops.some((drop) => drop.kind === 'item' && drop.itemId === 'item_weapon_sword_a'),
    ).toBe(true);
  });

  it('gates entries by killer level', () => {
    const random = rng(8);
    const low = rollLootTable(tables, 'loot_gear', 800, { killerLevel: 2 }, random);
    expect(low.every((drop) => drop.kind === 'item' && drop.itemId === 'item_weapon_sword_a')).toBe(
      true,
    );
    const high = rollLootTable(tables, 'loot_gear', 800, { killerLevel: 9 }, random);
    expect(high.some((drop) => drop.kind === 'item' && drop.itemId === 'item_armor_chest_a')).toBe(
      true,
    );
  });

  it('rolls gold within its band', () => {
    const random = rng(13);
    const drops = rollLootTable(tables, 'loot_coins', 200, { killerLevel: 1 }, random);
    expect(drops).toHaveLength(200);
    for (const drop of drops) {
      expect(drop.kind).toBe('gold');
      expect(drop.qty).toBeGreaterThanOrEqual(5);
      expect(drop.qty).toBeLessThanOrEqual(9);
    }
  });

  it('is deterministic for a seed (the panel simulator matches the server)', () => {
    const a = rollLootTable(tables, 'loot_trash', 50, { killerLevel: 10 }, rng(99));
    const b = rollLootTable(tables, 'loot_trash', 50, { killerLevel: 10 }, rng(99));
    expect(a).toEqual(b);
  });

  it('survives a cycle in authored data and reports it', () => {
    const cyclic = new Map(tables);
    cyclic.set(
      'loot_a',
      lootTableDefSchema.parse({
        id: 'loot_a',
        name: 'A',
        entries: [{ kind: 'table', ref: 'loot_b', weight: 1 }],
      }),
    );
    cyclic.set(
      'loot_b',
      lootTableDefSchema.parse({
        id: 'loot_b',
        name: 'B',
        entries: [{ kind: 'table', ref: 'loot_a', weight: 1 }],
      }),
    );
    expect(hasCycle(cyclic, 'loot_a')).toBe(true);
    expect(hasCycle(tables, 'loot_trash')).toBe(false);
    // The roller must terminate rather than blow the stack.
    expect(() => rollLootTable(cyclic, 'loot_a', 10, { killerLevel: 5 }, rng(1))).not.toThrow();
  });

  it('lists reachable tables for publish cross-checks', () => {
    expect([...referencedTables(tables, 'loot_trash')].sort()).toEqual(['loot_gear', 'loot_trash']);
  });

  it('ignores unknown refs instead of crashing a live server', () => {
    const drops = rollLootTable(tables, 'loot_missing', 5, { killerLevel: 5 }, rng(2));
    expect(drops).toEqual([]);
  });
});

describe('vendors (§6)', () => {
  it('defaults to buy 100% / sell 25% and accepts an anchor', () => {
    const vendor = vendorDefSchema.parse({
      id: 'vendor_general_dawnhaven',
      name: 'General Goods',
      kind: 'general',
      stock: [{ itemId: 'item_consumable_potion_minor' }],
      anchor: { x: 4, z: 380 },
    });
    expect(vendor.buyMult).toBe(1);
    expect(vendor.sellMult).toBe(0.25);
    expect(vendor.anchor?.radius).toBe(3.5);
    expect(vendor.stock[0]?.priceOverride).toBeNull();
  });

  it('refuses non-item stock refs', () => {
    expect(() =>
      vendorDefSchema.parse({
        id: 'vendor_x',
        name: 'X',
        kind: 'general',
        stock: [{ itemId: 'weapon_sword' }],
      }),
    ).toThrow();
  });
});
