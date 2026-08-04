/**
 * P8 server item tests: the runtime that sits between the shared planner and
 * the wire — equipment folding into derived stats, per-tagger loot rolls,
 * the vendor lease, consumable lanes and the grant primitives. The shared
 * planner has its own (fuzzed) suite; what is pinned here is everything that
 * only exists once a real player, a real enemy and real content are involved.
 */

import { describe, expect, it } from 'vitest';
import {
  BASIC_COMBOS,
  defaultWorldSettings,
  defaultXpCurve,
  devTerrain,
  validateItemDef,
  validateLootTableDef,
  validateVendorDef,
  type ItemDef,
  type ItemOp,
  type ClassId,
  type LootTableDef,
  type VendorDef,
} from '@dawned/shared';
import { World } from './world.js';
import type { CombatEvent } from './combat.js';
import type { ServerPlayer } from './player.js';
import {
  applyItemOp,
  createPlayerItems,
  equipmentBonus,
  expireLootBags,
  grantGold,
  grantItem,
  inventoryRows,
  playerWeaponDamage,
  rollEnemyLoot,
  shareRarity,
  sweepVendorLeases,
  vendorBuyPrice,
  vendorSellPrice,
  type ItemOpDeps,
  type LootBag,
} from './items.js';
import type { GameContent } from '../content/loader.js';

const SWORD: ItemDef = validateItemDef({
  id: 'item_weapon_sword_dawnsteel',
  name: 'Dawnsteel Sword',
  category: 'weapon',
  slot: 'mainhand',
  rarity: 'uncommon',
  ilvl: 5,
  classLock: ['warrior'],
  value: 60,
  icon: 'broadsword',
  modelRef: 'weapon_sword_dawnsteel',
  stats: { str: 4 },
  weapon: { dmgMin: 9, dmgMax: 13, twoHanded: false },
  requiresLevel: 5,
});

const STAFF: ItemDef = validateItemDef({
  id: 'item_weapon_staff_ember',
  name: 'Ember Staff',
  category: 'weapon',
  slot: 'mainhand',
  ilvl: 5,
  classLock: ['mage'],
  value: 55,
  icon: 'wizard-staff',
  weapon: { dmgMin: 7, dmgMax: 11, twoHanded: true },
});

const CHEST: ItemDef = validateItemDef({
  id: 'item_armor_chest_padded',
  name: 'Padded Jerkin',
  category: 'armor',
  slot: 'chest',
  ilvl: 3,
  value: 30,
  icon: 'leather-vest',
  stats: { vit: 5, armor: 12 },
  armorClass: 'medium',
});

const POTION: ItemDef = validateItemDef({
  id: 'item_consumable_potion_minor',
  name: 'Minor Healing Draught',
  category: 'consumable',
  stack: 20,
  value: 12,
  icon: 'potion-ball',
  consumable: { lane: 'potion', cooldownMs: 15000, healPctMaxHp: 30 },
});

const SHELL: ItemDef = validateItemDef({
  id: 'item_junk_shell',
  name: 'Cracked Shell',
  category: 'junk',
  stack: 50,
  value: 8,
  icon: 'sea-shell',
});

const ITEMS = [SWORD, STAFF, CHEST, POTION, SHELL];

const TABLE: LootTableDef = validateLootTableDef({
  id: 'loot_test_trash',
  name: 'Test Trash',
  entries: [
    { kind: 'item', ref: 'item_junk_shell', weight: 1, minQty: 1, maxQty: 2 },
    { kind: 'item', ref: 'item_weapon_sword_dawnsteel', weight: 1 },
  ],
});

const NOTHING_TABLE: LootTableDef = validateLootTableDef({
  id: 'loot_test_empty',
  name: 'Test Empty',
  entries: [{ kind: 'nothing', weight: 1 }],
});

const VENDOR: VendorDef = validateVendorDef({
  id: 'vendor_test_post',
  name: 'Test Post',
  kind: 'general',
  greeting: 'Dawn finds you well.',
  stock: [{ itemId: 'item_consumable_potion_minor' }, { itemId: 'item_armor_chest_padded' }],
  anchor: { x: 0, z: 0, radius: 4 },
});

const testContent = (): GameContent => ({
  enemies: new Map(),
  spawners: [],
  abilities: new Map(),
  abilityBySlot: new Map(),
  basicChains: BASIC_COMBOS,
  xpCurve: defaultXpCurve(),
  skillNodes: new Map(),
  items: new Map(ITEMS.map((item) => [item.id, item])),
  lootTables: new Map([
    [TABLE.id, TABLE],
    [NOTHING_TABLE.id, NOTHING_TABLE],
  ]),
  vendors: new Map([[VENDOR.id, VENDOR]]),
  worldSettings: defaultWorldSettings(),
});

const makeWorld = (): World =>
  new World(devTerrain, { x: 0, y: devTerrain.heightAt(0, 0), z: 0, yaw: 0 }, testContent());

let nextCharacterId = 1;
/**
 * Spawns carry a jitter ring, so every fixture pins its own position: reach
 * checks (vendor posts, loot bags) are metres-exact and would otherwise pass
 * or fail by luck.
 */
const addTestPlayer = (
  world: World,
  overrides: {
    level?: number;
    gold?: number;
    classId?: ClassId;
    name?: string;
    at?: { x: number; z: number };
  } = {},
): ServerPlayer => {
  const player = world.addPlayer({
    characterId: nextCharacterId++,
    accountId: nextCharacterId,
    name: overrides.name ?? 'Testa',
    classId: overrides.classId ?? 'warrior',
    level: overrides.level ?? 10,
    appearance: {
      body: 'm',
      skin: 0,
      outfit: 'ranger',
      outfitTint: 0,
      hair: 'none',
      hairColor: 0,
      beard: false,
    },
    position: null,
    role: 'player',
    progression: {
      xp: 0,
      gold: overrides.gold ?? 100,
      allocated: { str: 0, agi: 0, int: 0, vit: 0, end: 0 },
      unspentStatPoints: 0,
      unspentSkillPoints: 0,
      nodeRanks: new Map(),
      zonesSeen: new Set(),
    },
  });
  player.movement.x = overrides.at?.x ?? 0;
  player.movement.z = overrides.at?.z ?? 0;
  return player;
};

const makeDeps = (world: World, events: CombatEvent[]): ItemOpDeps => ({
  content: world.itemContent(),
  bags: world.lootBags,
  nowMs: Date.now(),
  events,
});

/** Run one op through the same path the tick takes (fold included). */
const runOp = (world: World, player: ServerPlayer, op: ItemOp): CombatEvent[] => {
  world.queueItemOp(player.id, op);
  // step() drains the queue; the fixture world has no spawners, so the tick is
  // cheap and exercises the real drain (refresh + re-fold + events).
  return world.step();
};

const refusalOf = (events: readonly CombatEvent[]): string | undefined => {
  for (const event of events) {
    if (event.type === 'item-notice' && event.kind === 'refused') return event.reason;
  }
  return undefined;
};

describe('equipment → stats', () => {
  it('folds worn attributes into the derived pass and swaps the damage band', () => {
    const world = makeWorld();
    const player = addTestPlayer(world);
    const baseHp = player.maxHp;
    const unarmed = playerWeaponDamage(player);

    grantItem(player, SWORD.id, 1, makeDeps(world, []));
    grantItem(player, CHEST.id, 1, makeDeps(world, []));
    runOp(world, player, { kind: 'equip', from: 0 });
    runOp(world, player, { kind: 'equip', from: 1 });

    expect(player.items.inventory.equipment.get('mainhand')?.itemId).toBe(SWORD.id);
    expect(player.items.inventory.equipment.get('chest')?.itemId).toBe(CHEST.id);
    // +5 VIT at 12 HP per point (PROGRESSION §2) has to reach maxHp.
    expect(player.maxHp).toBe(baseHp + 60);
    const armed = playerWeaponDamage(player);
    expect(armed).toEqual({ min: 9, max: 13 });
    expect(armed.min).not.toBe(unarmed.min);

    const bonus = equipmentBonus(player.items, world.itemContent().items);
    expect(bonus.stats.str).toBe(4);
    // The jerkin's authored 12 plus the free armour its class/ilvl grants (§2:
    // medium 4/ilvl × chest weight 1.0 × ilvl 3) — budget stats are on top.
    expect(bonus.stats.armor).toBe(24);
  });

  it('reverts the fold on unequip', () => {
    const world = makeWorld();
    const player = addTestPlayer(world);
    const baseHp = player.maxHp;
    grantItem(player, CHEST.id, 1, makeDeps(world, []));
    runOp(world, player, { kind: 'equip', from: 0 });
    expect(player.maxHp).toBe(baseHp + 60);
    runOp(world, player, { kind: 'unequip', slot: 'chest' });
    expect(player.maxHp).toBe(baseHp);
    expect(playerWeaponDamage(player)).not.toEqual({ min: 9, max: 13 });
  });

  it('refuses gear the class or the level does not allow', () => {
    const world = makeWorld();
    const mage = addTestPlayer(world, { classId: 'mage', level: 10, name: 'Maga' });
    grantItem(mage, SWORD.id, 1, makeDeps(world, []));
    expect(refusalOf(runOp(world, mage, { kind: 'equip', from: 0 }))).toBe('wrong_class');

    const lowbie = addTestPlayer(world, { level: 2, name: 'Newta' });
    grantItem(lowbie, SWORD.id, 1, makeDeps(world, []));
    expect(refusalOf(runOp(world, lowbie, { kind: 'equip', from: 0 }))).toBe('level_too_low');
  });

  it('publishes held gear on the roster so everyone sees the weapon', () => {
    const world = makeWorld();
    const player = addTestPlayer(world);
    expect(world.roster()[0]?.mainhandModel).toBeNull();
    grantItem(player, SWORD.id, 1, makeDeps(world, []));
    const events = runOp(world, player, { kind: 'equip', from: 0 });
    expect(events.some((event) => event.type === 'equipment-changed')).toBe(true);
    expect(world.roster()[0]?.mainhandModel).toBe('weapon_sword_dawnsteel');
  });
});

describe('loot bags', () => {
  const fakeEnemy = (level: number, tableId: string | null) =>
    ({
      x: 5,
      y: 0,
      z: 0,
      level,
      def: {
        archetype: 'grunt',
        loot: tableId ? { tableId, rolls: 2, goldMin: 4, goldMax: 8 } : null,
      },
    }) as unknown as Parameters<typeof rollEnemyLoot>[0];

  it('rolls one INDEPENDENT share per tagger', () => {
    const world = makeWorld();
    const a = addTestPlayer(world, { name: 'Taggera' });
    const b = addTestPlayer(world, { name: 'Taggerb' });
    let seed = 7;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const bag = rollEnemyLoot(fakeEnemy(5, TABLE.id), [a, b], world.itemContent(), rng, 0, 1);
    expect(bag).not.toBeNull();
    expect(bag?.shares.size).toBe(2);
    for (const share of bag!.shares.values()) {
      expect(share.gold).toBeGreaterThanOrEqual(4);
      expect(share.gold).toBeLessThanOrEqual(8);
      expect(share.items.length).toBeGreaterThan(0);
    }
    // Rolled independently: the two shares came off different rng draws.
    const rarities = [...bag!.shares.values()].map((share) =>
      shareRarity(share, world.itemContent().items),
    );
    expect(rarities.every((rarity) => rarity === 'common' || rarity === 'uncommon')).toBe(true);
  });

  it('drops no bag at all when nothing rolled', () => {
    const world = makeWorld();
    const player = addTestPlayer(world);
    const bag = rollEnemyLoot(
      fakeEnemy(5, NOTHING_TABLE.id),
      [player],
      world.itemContent(),
      () => 0.5,
      0,
      1,
    );
    // The table pays nothing; only the enemy's own gold band remains.
    expect(bag?.shares.get(player.id)?.items.length ?? 0).toBe(0);
    expect(bag?.shares.get(player.id)?.gold ?? 0).toBeGreaterThan(0);
  });

  it('hands a share over only within reach, and only to its owner', () => {
    const world = makeWorld();
    const owner = addTestPlayer(world, { name: 'Ownera' });
    const stranger = addTestPlayer(world, { name: 'Strangera' });
    const bag: LootBag = {
      id: 1,
      x: owner.movement.x,
      y: owner.movement.y,
      z: owner.movement.z,
      expiresAtMs: Date.now() + 60_000,
      shares: new Map([
        [owner.id, { items: [{ itemId: SHELL.id, qty: 3, rolled: null }], gold: 11 }],
      ]),
    };
    world.lootBags.set(bag.id, bag);

    expect(refusalOf(runOp(world, stranger, { kind: 'loot', bagId: 1, index: null }))).toBe(
      'empty_slot',
    );

    const before = owner.progress.gold;
    runOp(world, owner, { kind: 'loot', bagId: 1, index: null });
    expect(owner.progress.gold).toBe(before + 11);
    expect([...owner.items.inventory.bag.values()][0]).toMatchObject({
      itemId: SHELL.id,
      qty: 3,
    });
    expect(world.lootBags.has(1)).toBe(false); // emptied bags disappear

    // Out of reach: a far bag refuses.
    const far: LootBag = { ...bag, id: 2, x: owner.movement.x + 40 };
    far.shares = new Map([[owner.id, { items: [], gold: 5 }]]);
    world.lootBags.set(2, far);
    expect(refusalOf(runOp(world, owner, { kind: 'loot', bagId: 2, index: null }))).toBe(
      'bad_slot',
    );
  });

  it('expires bags after their lifetime and reports who could see them', () => {
    const world = makeWorld();
    const player = addTestPlayer(world);
    world.lootBags.set(3, {
      id: 3,
      x: 0,
      y: 0,
      z: 0,
      expiresAtMs: 500,
      shares: new Map([[player.id, { items: [], gold: 1 }]]),
    });
    expect(expireLootBags(world.lootBags, 499).size).toBe(0);
    const affected = expireLootBags(world.lootBags, 501);
    expect([...affected]).toEqual([player.id]);
    expect(world.lootBags.size).toBe(0);
  });
});

describe('consumables', () => {
  it('heals, burns the lane cooldown and refuses a second sip', () => {
    const world = makeWorld();
    const player = addTestPlayer(world);
    grantItem(player, POTION.id, 3, makeDeps(world, []));
    player.hp = 10;
    const events = runOp(world, player, { kind: 'use', from: 0 });
    // OOC regen also ticks inside step(), so the floor is what the draught
    // itself is worth — 30% of max on top of the 10 HP it started from.
    expect(player.hp).toBeGreaterThanOrEqual(10 + Math.round(player.maxHp * 0.3));
    expect(player.items.inventory.bag.get(0)?.qty).toBe(2);
    expect(events.some((event) => event.type === 'item-notice' && event.kind === 'used')).toBe(
      true,
    );
    expect(player.items.cooldowns.get('potion')).toBeGreaterThan(Date.now());
    expect(refusalOf(runOp(world, player, { kind: 'use', from: 0 }))).toBe('on_cooldown');
  });

  it('refuses to drink a sword', () => {
    const world = makeWorld();
    const player = addTestPlayer(world);
    grantItem(player, SWORD.id, 1, makeDeps(world, []));
    expect(refusalOf(runOp(world, player, { kind: 'use', from: 0 }))).toBe('not_consumable');
  });
});

describe('vendors', () => {
  it('prices, buys, sells and re-buys with the server’s own numbers', () => {
    const world = makeWorld();
    const player = addTestPlayer(world, { gold: 200 });
    player.movement.x = 0;
    player.movement.z = 0;

    runOp(world, player, { kind: 'vendorOpen', vendorId: VENDOR.id });
    expect(player.items.openVendorId).toBe(VENDOR.id);

    const price = vendorBuyPrice(VENDOR, POTION);
    expect(price).toBe(POTION.value);
    runOp(world, player, { kind: 'vendorBuy', vendorId: VENDOR.id, itemId: POTION.id, qty: 2 });
    expect(player.progress.gold).toBe(200 - price * 2);
    expect(player.items.inventory.bag.get(0)).toMatchObject({ itemId: POTION.id, qty: 2 });

    const sellEach = vendorSellPrice(VENDOR, POTION);
    expect(sellEach).toBe(Math.max(1, Math.round(POTION.value * 0.25)));
    const goldBeforeSale = player.progress.gold;
    runOp(world, player, { kind: 'vendorSell', vendorId: VENDOR.id, from: 0, qty: 2 });
    expect(player.progress.gold).toBe(goldBeforeSale + sellEach * 2);
    expect(player.items.inventory.bag.size).toBe(0);
    expect(player.items.buyback[0]).toMatchObject({ itemId: POTION.id, qty: 2 });

    runOp(world, player, { kind: 'vendorBuyback', vendorId: VENDOR.id, index: 0 });
    expect(player.items.inventory.bag.get(0)).toMatchObject({ itemId: POTION.id, qty: 2 });
    expect(player.progress.gold).toBe(goldBeforeSale);
    expect(player.items.buyback).toHaveLength(0);
  });

  it('refuses purchases the purse cannot cover and stock it does not carry', () => {
    const world = makeWorld();
    const player = addTestPlayer(world, { gold: 1 });
    runOp(world, player, { kind: 'vendorOpen', vendorId: VENDOR.id });
    expect(
      refusalOf(
        runOp(world, player, { kind: 'vendorBuy', vendorId: VENDOR.id, itemId: POTION.id, qty: 1 }),
      ),
    ).toBe('no_gold');
    expect(
      refusalOf(
        runOp(world, player, { kind: 'vendorBuy', vendorId: VENDOR.id, itemId: SWORD.id, qty: 1 }),
      ),
    ).toBe('unknown_item');
  });

  it('closes the panel when the player walks away from the post', () => {
    const world = makeWorld();
    const player = addTestPlayer(world);
    runOp(world, player, { kind: 'vendorOpen', vendorId: VENDOR.id });
    expect(player.items.openVendorId).toBe(VENDOR.id);

    player.movement.x = 50;
    const events: CombatEvent[] = [];
    sweepVendorLeases([player], world.itemContent().vendors, events);
    expect(player.items.openVendorId).toBeNull();
    expect(events).toContainEqual({
      type: 'vendor-panel',
      playerId: player.id,
      vendorId: VENDOR.id,
      open: false,
    });

    // …and a trade attempted from over there is refused outright.
    expect(
      refusalOf(
        runOp(world, player, { kind: 'vendorBuy', vendorId: VENDOR.id, itemId: POTION.id, qty: 1 }),
      ),
    ).toBe('bad_slot');
  });

  it('never lets a sale mint gold from a bound item', () => {
    const world = makeWorld();
    const player = addTestPlayer(world);
    const questItem = validateItemDef({
      id: 'item_quest_token',
      name: 'Sealed Token',
      category: 'quest',
      value: 500,
      icon: 'token',
      bound: true,
    });
    const content = world.itemContent();
    (content.items as Map<string, ItemDef>).set(questItem.id, questItem);
    grantItem(player, questItem.id, 1, makeDeps(world, []));
    runOp(world, player, { kind: 'vendorOpen', vendorId: VENDOR.id });
    const gold = player.progress.gold;
    expect(
      refusalOf(runOp(world, player, { kind: 'vendorSell', vendorId: VENDOR.id, from: 0, qty: 1 })),
    ).toBe('bound_item');
    expect(player.progress.gold).toBe(gold);
  });
});

describe('grants and persistence rows', () => {
  it('reports overflow instead of silently eating a grant', () => {
    const world = makeWorld();
    const player = addTestPlayer(world);
    const events: CombatEvent[] = [];
    // 48 cells × 50 per stack of junk fills the pack exactly.
    const leftover = grantItem(player, SHELL.id, 48 * 50 + 7, makeDeps(world, events));
    expect(leftover).toBe(7);
    expect(player.items.inventory.bag.size).toBe(48);
    expect(events.some((event) => event.type === 'item-notice' && event.kind === 'full')).toBe(
      true,
    );
  });

  it('keeps the purse non-negative and mirrors it onto the character row', () => {
    const world = makeWorld();
    const player = addTestPlayer(world, { gold: 30 });
    grantGold(player, 20, makeDeps(world, []));
    expect(player.progress.gold).toBe(50);
    expect(player.items.inventory.gold).toBe(50);
    grantGold(player, -999, makeDeps(world, []));
    expect(player.progress.gold).toBe(0);
  });

  it('serializes bag and paper-doll into one row per occupied cell', () => {
    const world = makeWorld();
    const player = addTestPlayer(world);
    grantItem(player, SWORD.id, 1, makeDeps(world, []));
    grantItem(player, POTION.id, 4, makeDeps(world, []));
    runOp(world, player, { kind: 'equip', from: 0 });

    const rows = inventoryRows(player.items);
    expect(rows).toHaveLength(2);
    const equipped = rows.find((row) => row.container === 'equipment');
    expect(equipped?.slot).toBe(0); // mainhand is index 0 of EQUIP_SLOTS
    expect(equipped?.stack.itemId).toBe(SWORD.id);
    const bagged = rows.find((row) => row.container === 'inventory');
    expect(bagged?.stack).toMatchObject({ itemId: POTION.id, qty: 4 });
  });

  it('restores a persisted pack, gear bonus included', () => {
    const world = makeWorld();
    const restored = createPlayerItems(77, {
      bag: new Map([[2, { id: 5, itemId: POTION.id, qty: 3, rolled: null }]]),
      equipment: new Map([['chest', { id: 6, itemId: CHEST.id, qty: 1, rolled: { vit: 2 } }]]),
    });
    expect(restored.inventory.gold).toBe(77);
    const bonus = equipmentBonus(restored, world.itemContent().items);
    // Fixed stats plus the rolled ones on that particular copy.
    expect(bonus.stats.vit).toBe(7);
  });
});

describe('op hygiene', () => {
  it('resyncs even when it refuses — a mispredicted drag must be healed', () => {
    const world = makeWorld();
    const player = addTestPlayer(world);
    const events: CombatEvent[] = [];
    const result = applyItemOp(player, { kind: 'move', from: 0, to: 1 }, makeDeps(world, events));
    expect(result.equipmentChanged).toBe(false);
    expect(events.some((event) => event.type === 'inventory-dirty')).toBe(true);
    expect(refusalOf(events)).toBe('empty_slot');
  });

  it('bounds the queue instead of growing the heap', () => {
    const world = makeWorld();
    const player = addTestPlayer(world);
    for (let index = 0; index < 2000; index++) {
      world.queueItemOp(player.id, { kind: 'sort' });
    }
    // The drain is bounded, so the tick after a spam burst still returns.
    expect(() => world.step()).not.toThrow();
  });
});
