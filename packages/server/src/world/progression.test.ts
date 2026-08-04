/**
 * P7 server progression tests: level-ups with the full refill contract,
 * banked-point allocation + tier gates, respec pricing, the kill-XP tag rule
 * (damage share + heal assists), /setlevel, CC-duration nodes, low-HP procs
 * and the node→stats/resource/effective-def folds — the pieces the browser
 * smoke can only exercise end-to-end, pinned here at the unit level.
 */

import { describe, expect, it } from 'vitest';
import {
  BASIC_COMBOS,
  XpSource,
  defaultXpCurve,
  defaultWorldSettings,
  devTerrain,
  validateAbilityDef,
  validateSkillNodeDef,
  type AbilityDef,
  type SkillNodeDef,
} from '@dawned/shared';
import { World } from './world.js';
import { applyCcToPlayer, type CombatEvent } from './combat.js';
import {
  allocateSkill,
  allocateStats,
  awardKillXp,
  awardXp,
  respec,
  setLevel,
} from './progression.js';
import type { GameContent } from '../content/loader.js';

const crushingBlow = (): AbilityDef =>
  validateAbilityDef({
    id: 'ability_warrior_crushing_blow',
    classId: 'warrior',
    binding: { kind: 'slot', slot: 1 },
    name: 'Crushing Blow',
    cost: { type: 'rage', amount: 25 },
    cooldownMs: 8000,
    targeting: { kind: 'melee_arc', angleDeg: 90, reach: 3 },
    effects: [{ kind: 'damage', coef: 1.6, staggerBonus: 20 }],
    anim: { clip: 'Sword_Attack', clipSeconds: 1, durationMs: 800 },
  });

const NODES: SkillNodeDef[] = [
  validateSkillNodeDef({
    id: 'node_warrior_bulwark_toughened',
    classId: 'warrior',
    branch: 'bulwark',
    name: 'Toughened',
    tier: 1,
    order: 1,
    maxRanks: 3,
    ranks: [3, 6, 9].map((pct) => [{ kind: 'stat', mods: { maxHpPct: pct } }]),
  }),
  validateSkillNodeDef({
    id: 'node_warrior_bulwark_thick_skull',
    classId: 'warrior',
    branch: 'bulwark',
    name: 'Thick Skull',
    tier: 2,
    order: 3,
    maxRanks: 1,
    ranks: [[{ kind: 'stat', mods: { ccOnYouDurationPct: -20 } }]],
  }),
  validateSkillNodeDef({
    id: 'node_warrior_bulwark_second_wind',
    classId: 'warrior',
    branch: 'bulwark',
    name: 'Second Wind',
    tier: 1,
    order: 2,
    maxRanks: 1,
    ranks: [[{ kind: 'proc', proc: 'low_hp_heal', thresholdPct: 25, healPct: 20, icdMs: 90000 }]],
  }),
  validateSkillNodeDef({
    id: 'node_warrior_warlord_brutality',
    classId: 'warrior',
    branch: 'warlord',
    name: 'Brutality',
    tier: 1,
    order: 1,
    maxRanks: 2,
    ranks: [10, 20].map((pct) => [
      { kind: 'ability_mod', abilityId: 'ability_warrior_crushing_blow', mods: { damagePct: pct } },
    ]),
  }),
];

const testContent = (): GameContent => {
  const ability = crushingBlow();
  return {
    enemies: new Map(),
    spawners: [],
    abilities: new Map([[ability.id, ability]]),
    abilityBySlot: new Map([[`warrior:1`, ability]]),
    basicChains: BASIC_COMBOS,
    xpCurve: defaultXpCurve(),
    skillNodes: new Map(NODES.map((node) => [node.id, node])),
    worldSettings: defaultWorldSettings(),
  };
};

const makeWorld = (): World =>
  new World(devTerrain, { x: 0, y: devTerrain.heightAt(0, 0), z: 0, yaw: 0 }, testContent());

const addTestPlayer = (
  world: World,
  overrides: Partial<{
    level: number;
    xp: number;
    gold: number;
    unspentStatPoints: number;
    unspentSkillPoints: number;
    nodeRanks: Map<string, number>;
  }> = {},
) =>
  world.addPlayer({
    characterId: 1,
    accountId: 1,
    name: 'Testa',
    classId: 'warrior',
    level: overrides.level ?? 1,
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
    role: 'gm',
    progression: {
      xp: overrides.xp ?? 0,
      gold: overrides.gold ?? 25,
      allocated: { str: 0, agi: 0, int: 0, vit: 0, end: 0 },
      unspentStatPoints: overrides.unspentStatPoints ?? 0,
      unspentSkillPoints: overrides.unspentSkillPoints ?? 0,
      nodeRanks: overrides.nodeRanks ?? new Map<string, number>(),
      zonesSeen: new Set(),
    },
  });

describe('XP awards and level-ups', () => {
  it('levels up with the §1.3 contract: refill, banked points, events', () => {
    const world = makeWorld();
    const player = addTestPlayer(world);
    player.hp = 50;
    player.movement.stamina = 10;
    const events: CombatEvent[] = [];
    awardXp(player, 120, XpSource.Kill, world.progressionContent(), events); // 90 to level 2
    expect(player.level).toBe(2);
    expect(player.progress.xp).toBe(30);
    expect(player.progress.unspentStatPoints).toBe(3);
    expect(player.progress.unspentSkillPoints).toBe(1);
    expect(player.hp).toBe(player.maxHp); // full refill
    expect(player.movement.stamina).toBe(player.movement.maxStamina);
    expect(events.some((e) => e.type === 'level-up' && e.level === 2)).toBe(true);
    expect(events.some((e) => e.type === 'xp-gained' && e.amount === 120)).toBe(true);
  });

  it('applies the world xpRate and never rounds a positive award to 0', () => {
    const world = makeWorld();
    const player = addTestPlayer(world);
    const content = { ...world.progressionContent(), xpRate: 0.25 };
    const events: CombatEvent[] = [];
    awardXp(player, 2, XpSource.Kill, content, events);
    const gained = events.find((e) => e.type === 'xp-gained');
    expect(gained?.amount).toBe(1);
  });

  it('capped characters ignore awards', () => {
    const world = makeWorld();
    const player = addTestPlayer(world, { level: 30 });
    const events: CombatEvent[] = [];
    awardXp(player, 99999, XpSource.Kill, world.progressionContent(), events);
    expect(player.level).toBe(30);
    expect(events).toHaveLength(0);
  });
});

describe('kill-XP tag rule (§1.1)', () => {
  it('tags ≥10% damage contributors and healers of taggers', () => {
    const world = makeWorld();
    const tank = addTestPlayer(world);
    const poker = world.addPlayer({
      characterId: 2,
      accountId: 2,
      name: 'Pokey',
      classId: 'rogue',
      level: 1,
      appearance: tank.appearance,
      position: null,
    });
    const healer = world.addPlayer({
      characterId: 3,
      accountId: 3,
      name: 'Mendy',
      classId: 'cleric',
      level: 1,
      appearance: tank.appearance,
      position: null,
    });
    const players = new Map([
      [tank.id, tank],
      [poker.id, poker],
      [healer.id, healer],
    ]);
    const events: CombatEvent[] = [];
    awardKillXp(
      {
        damage: new Map([
          [tank.id, 95],
          [poker.id, 5], // under 10% — no tag
        ]),
        healAssists: new Map([[healer.id, new Set([tank.id])]]),
      },
      3,
      'normal',
      1,
      players,
      world.progressionContent(),
      events,
    );
    const paid = events.filter((e) => e.type === 'xp-gained').map((e) => e.playerId);
    expect(paid).toContain(tank.id);
    expect(paid).toContain(healer.id); // healed a tagger — Cleric-safe
    expect(paid).not.toContain(poker.id);
  });
});

describe('allocation, tiers and respec', () => {
  it('spends banked attribute points and rebuilds stats', () => {
    const world = makeWorld();
    const player = addTestPlayer(world, { unspentStatPoints: 6 });
    const baseHp = player.maxHp;
    const events: CombatEvent[] = [];
    expect(allocateStats(player, { str: 2, agi: 0, int: 0, vit: 3, end: 1 }, events)).toBe(true);
    expect(player.progress.unspentStatPoints).toBe(0);
    expect(player.maxHp).toBe(baseHp + 36); // +3 VIT ×12
    expect(player.stats.ap).toBeGreaterThan(0);
    // Over-spend refuses without mutating.
    expect(allocateStats(player, { str: 9, agi: 0, int: 0, vit: 0, end: 0 }, events)).toBe(false);
  });

  it('gates skill nodes by tier and folds allocated ranks into stats/defs', () => {
    const world = makeWorld();
    const content = world.progressionContent();
    const player = addTestPlayer(world, { level: 5, unspentSkillPoints: 4 });
    const events: CombatEvent[] = [];
    // Tier 2 locked with 0 in-branch points…
    expect(allocateSkill(player, 'node_warrior_bulwark_thick_skull', content, events)).toBe(false);
    // …opens after 3 points in tier 1.
    for (let i = 0; i < 3; i++) {
      expect(allocateSkill(player, 'node_warrior_bulwark_toughened', content, events)).toBe(true);
    }
    expect(allocateSkill(player, 'node_warrior_bulwark_thick_skull', content, events)).toBe(true);
    expect(player.progress.unspentSkillPoints).toBe(0);
    // Toughened rank 3 = +9% MaxHP folded into the sheet.
    const unbuffed = addTestPlayer(makeWorld(), { level: 5 });
    expect(player.maxHp).toBe(Math.round(unbuffed.maxHp * 1.09));
  });

  it('rewrites ability defs for allocated ability_mod nodes', () => {
    const world = makeWorld();
    const content = world.progressionContent();
    const player = addTestPlayer(world, {
      unspentSkillPoints: 2,
      nodeRanks: new Map([['node_warrior_warlord_brutality', 2]]),
    });
    const effective = player.progress.effectiveDefs.get('ability_warrior_crushing_blow');
    expect(effective).toBeDefined();
    const damage = effective!.effects[0];
    expect(damage?.kind === 'damage' && damage.coef).toBeCloseTo(1.6 * 1.2);
    // Respec clears the fold.
    player.progress.gold = 10_000;
    const events: CombatEvent[] = [];
    expect(respec(player, 1, content, events)).toBe(true);
    expect(player.progress.nodeRanks.size).toBe(0);
    expect(player.progress.effectiveDefs.size).toBe(0);
    expect(player.progress.gold).toBe(10_000 - 25); // 25 × level 1
  });

  it('refuses respec without the gold or without anything to refund', () => {
    const world = makeWorld();
    const content = world.progressionContent();
    const events: CombatEvent[] = [];
    const broke = addTestPlayer(world, {
      gold: 0,
      nodeRanks: new Map([['node_warrior_bulwark_toughened', 1]]),
    });
    expect(respec(broke, 1, content, events)).toBe(false);
    const empty = addTestPlayer(makeWorld(), { gold: 999 });
    expect(respec(empty, 1, content, events)).toBe(false);
  });

  it('setLevel banks points going up and refunds everything coming down', () => {
    const world = makeWorld();
    const content = world.progressionContent();
    const player = addTestPlayer(world);
    const events: CombatEvent[] = [];
    setLevel(player, 10, content, events);
    expect(player.level).toBe(10);
    expect(player.progress.unspentStatPoints).toBe(27);
    expect(player.progress.unspentSkillPoints).toBe(9);
    expect(player.hp).toBe(player.maxHp);
    // Spend some, then drop to 3: everything refunds to the smaller bank.
    allocateStats(player, { str: 5, agi: 0, int: 0, vit: 0, end: 0 }, events);
    allocateSkill(player, 'node_warrior_bulwark_toughened', content, events);
    setLevel(player, 3, content, events);
    expect(player.progress.unspentStatPoints).toBe(6);
    expect(player.progress.unspentSkillPoints).toBe(2);
    expect(player.progress.nodeRanks.size).toBe(0);
    expect(player.progress.allocated.str).toBe(0);
  });
});

describe('node runtime hooks', () => {
  it('Thick Skull shortens CC before DR', () => {
    const world = makeWorld();
    const withNode = addTestPlayer(world, {
      nodeRanks: new Map([
        ['node_warrior_bulwark_toughened', 3],
        ['node_warrior_bulwark_thick_skull', 1],
      ]),
    });
    const events: CombatEvent[] = [];
    const verdict = applyCcToPlayer(withNode, 'stun', 1000, 1000, events);
    expect(verdict.durationMs).toBe(800); // −20%
  });

  it('Second Wind heals at the threshold and honors its ICD (world tick)', () => {
    const world = makeWorld();
    const player = addTestPlayer(world, {
      nodeRanks: new Map([['node_warrior_bulwark_second_wind', 1]]),
    });
    player.hp = Math.floor(player.maxHp * 0.2);
    world.step();
    expect(player.hp).toBeGreaterThanOrEqual(
      Math.floor(player.maxHp * 0.2) + Math.round(player.maxHp * 0.2),
    );
    // Wound again inside the ICD: no second proc.
    player.hp = Math.floor(player.maxHp * 0.1);
    world.step();
    expect(player.hp).toBeLessThan(player.maxHp * 0.2);
  });
});
