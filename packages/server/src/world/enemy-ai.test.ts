/**
 * P9 archetype behaviour: the parts of the AI that are decidable without a
 * whole world — a Charger's lunge, a boss walking its phases, the swarm ring.
 * The steering itself is playtested; these pin the rules that would break
 * silently (a charge that never ends, a phase that re-announces, a lunge that
 * hits the same player twice).
 */

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  BASIC_COMBOS,
  EntityEventKind,
  defaultWorldSettings,
  devTerrain,
  defaultXpCurve,
  enemyAbilitySchema,
  enemyDefSchema,
  flatTerrain,
  HitFlag,
  type EnemyAbilityDef,
  type EnemyDef,
} from '@dawned/shared';
import { ServerEnemy } from './enemy.js';
import { decide, move, type AiContext } from './enemy-ai.js';
import { World } from './world.js';
import type { GameContent } from '../content/loader.js';
import { applyDamageToEnemy, type CombatEvent } from './combat.js';
import type { ServerPlayer } from './player.js';

// Fixtures describe what the schema READS, not what it produces: typing an
// override as Partial<EnemyDef> would force every defaulted field (a phase's
// speedMult, an ability's overshootMs) to be spelled out at every call site.
const ability = (
  over: Partial<z.input<typeof enemyAbilitySchema>> & { id: string },
): EnemyAbilityDef => enemyAbilitySchema.parse({ kind: 'melee_arc', clip: 'Attack', ...over });

const def = (over: Partial<z.input<typeof enemyDefSchema>> & { id: string }): EnemyDef =>
  enemyDefSchema.parse({
    name: 'Test',
    archetype: 'grunt',
    levelMin: 5,
    levelMax: 5,
    modelRef: 'enemies_mushnub',
    abilities: [ability({ id: 'swipe' })],
    ...over,
  });

/**
 * A REAL player in a real world. The damage path a charge runs through reads
 * deep into a player (rewind history, node aggregates, block state), so a
 * hand-stubbed object only ever gets as far as the next field it forgot.
 */
const emptyContent = (): GameContent => ({
  enemies: new Map(),
  spawners: [],
  abilities: new Map(),
  abilityBySlot: new Map(),
  basicChains: BASIC_COMBOS,
  xpCurve: defaultXpCurve(),
  skillNodes: new Map(),
  items: new Map(),
  lootTables: new Map(),
  vendors: new Map(),
  worldSettings: defaultWorldSettings(),
});

let nextCharacterId = 1;
const realPlayer = (x: number, z: number): ServerPlayer => {
  const world = new World(devTerrain, { x: 0, y: 0, z: 0, yaw: 0 }, emptyContent());
  const player = world.addPlayer({
    characterId: nextCharacterId++,
    accountId: nextCharacterId,
    name: `Bait${nextCharacterId}`,
    classId: 'warrior',
    level: 10,
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
      gold: 0,
      allocated: { str: 0, agi: 0, int: 0, vit: 0, end: 0 },
      unspentStatPoints: 0,
      unspentSkillPoints: 0,
      nodeRanks: new Map(),
      zonesSeen: new Set(),
    },
  });
  player.movement.x = x;
  player.movement.y = 0;
  player.movement.z = z;
  return player;
};

const makeCtx = (
  players: ServerPlayer[],
  nowMs: number,
  roll = 0.5,
): AiContext & { events: CombatEvent[] } => ({
  players: new Map(players.map((p) => [p.id, p])),
  terrain: flatTerrain(0),
  nowMs,
  dt: 0.05,
  rng: () => roll,
  events: [],
  enemiesByCamp: () => [],
  projectiles: [],
  nextProjectileId: () => 1,
  packSize: () => 4,
});

const spawn = (enemyDef: EnemyDef, x = 0, z = 0): ServerEnemy =>
  new ServerEnemy(1, enemyDef, 5, 'spawner_test', null, x, 0, z);

/**
 * Clear the last decision so the next one starts fresh. Behind a function
 * boundary on purpose: assigning `enemy.swing = null` inline narrows the field
 * to `null` for the rest of the scope, and TypeScript cannot see `decide()`
 * fill it back in — the test would then read as dead code to the linter.
 */
const readyForNextDecision = (enemy: ServerEnemy): void => {
  enemy.swing = null;
  enemy.recoverUntilMs = 0;
  enemy.cooldowns.clear();
};

describe('Charger: line up → lunge → overshoot', () => {
  const charger = def({
    id: 'enemy_stalker',
    archetype: 'charger',
    abilities: [
      ability({
        id: 'pounce',
        kind: 'charge_rect',
        rangeMin: 5,
        rangeMax: 10,
        chargeDistance: 14,
        chargeSpeed: 14,
        chargeWidth: 2.4,
        overshootMs: 1200,
        windupMs: 800,
        telegraph: true,
      }),
    ],
  });

  it('telegraphs a RECT along the lane it will travel, not a cone', () => {
    const enemy = spawn(charger);
    const player = realPlayer(0, 8);
    const ctx = makeCtx([player], 1000);
    enemy.enterState('combat', 1000);
    enemy.addThreat(player.id, 10);
    decide(enemy, ctx);
    const telegraph = ctx.events.find((e) => e.type === 'telegraph');
    expect(telegraph).toBeDefined();
    if (telegraph?.type !== 'telegraph') throw new Error('expected a telegraph');
    expect(telegraph.shape).toBe(3); // TelegraphShape.Rect
    // The decal's length is the CHARGE distance — what the lunge will cover —
    // not the ability's attack reach.
    expect(telegraph.size).toBe(14);
    expect(telegraph.spread).toBe(2.4);
  });

  it('starts the lunge at contact and ends it in a stagger', () => {
    const enemy = spawn(charger);
    const player = realPlayer(0, 8);
    let now = 1000;
    const ctx = makeCtx([player], now);
    enemy.enterState('combat', now);
    enemy.addThreat(player.id, 10);
    decide(enemy, ctx);
    expect(enemy.swing).not.toBeNull();

    // Wind-up passes → contact launches the charge instead of resolving a hit.
    now += 850;
    const contact = makeCtx([player], now);
    move(enemy, [], contact);
    expect(enemy.charge).not.toBeNull();
    expect(enemy.swing).toBeNull();

    // Run it out. 14 m at 14 m/s = 1 s of flight.
    const startZ = enemy.z;
    for (let i = 0; i < 40 && enemy.charge; i++) {
      now += 50;
      move(enemy, [], makeCtx([player], now));
    }
    expect(enemy.charge).toBeNull();
    expect(enemy.z - startZ).toBeGreaterThan(5); // it actually travelled
    // …and it is now punishable.
    expect(enemy.stunnedUntilMs).toBeGreaterThan(now);
  });

  it('hits each player in the lane at most once', () => {
    const enemy = spawn(charger);
    const player = realPlayer(0, 6);
    let now = 1000;
    enemy.enterState('combat', now);
    enemy.addThreat(player.id, 10);
    decide(enemy, makeCtx([player], now));
    now += 850;
    move(enemy, [], makeCtx([player], now));

    let resolves = 0;
    for (let i = 0; i < 40 && enemy.charge; i++) {
      now += 50;
      const ctx = makeCtx([player], now);
      move(enemy, [], ctx);
      resolves += ctx.events.filter((e) => e.type === 'ability-resolve').length;
    }
    // The lunge passes right through the player's position; without the
    // per-victim guard it would re-hit on every tick of contact.
    expect(resolves).toBe(1);
  });

  it('never runs forever, even charging into open ground', () => {
    const enemy = spawn(def({ ...charger, id: 'enemy_slow_charger' }));
    let now = 1000;
    const player = realPlayer(0, 8);
    enemy.enterState('combat', now);
    enemy.addThreat(player.id, 10);
    decide(enemy, makeCtx([player], now));
    now += 850;
    move(enemy, [], makeCtx([player], now));
    for (let i = 0; i < 200 && enemy.charge; i++) {
      now += 50;
      move(enemy, [], makeCtx([player], now));
    }
    expect(enemy.charge).toBeNull();
  });
});

describe('Boss phases drive the fight', () => {
  const king = def({
    id: 'enemy_mushroom_king',
    rank: 'zone_boss',
    arenaRadius: 25,
    phases: [
      { atHpPct: 50, damageMult: 1.25, recoverMult: 0.8, announce: 'The spores rise' },
      { atHpPct: 20, damageMult: 1.5, speedMult: 1.2, recoverMult: 0.7, announce: 'ROOT AND RUIN' },
    ],
    abilities: [
      ability({ id: 'stomp' }),
      ability({ id: 'ring', kind: 'ground_circle', rangeMax: 10, phase: 1 }),
    ],
  });

  it('announces each phase exactly once as HP falls', () => {
    const enemy = spawn(king);
    const player = realPlayer(0, 2);
    let now = 1000;
    enemy.enterState('combat', now);
    enemy.addThreat(player.id, 10);

    const phaseEvents = (): number => {
      const ctx = makeCtx([player], now);
      decide(enemy, ctx);
      return ctx.events.filter(
        (e) => e.type === 'entity-event' && e.event === EntityEventKind.Phase,
      ).length;
    };

    enemy.hp = enemy.maxHp; // phase 0
    expect(phaseEvents()).toBe(0);
    now += 1000;
    enemy.hp = enemy.maxHp * 0.4; // crosses 50%
    expect(phaseEvents()).toBe(1);
    expect(enemy.phaseIndex).toBe(1);
    now += 1000;
    expect(phaseEvents()).toBe(0); // still phase 1 — no repeat
    now += 1000;
    enemy.hp = enemy.maxHp * 0.1; // crosses 20%
    expect(phaseEvents()).toBe(1);
    expect(enemy.phaseIndex).toBe(2);
    now += 1000;
    // Healed back up: the fight does NOT rewind.
    enemy.hp = enemy.maxHp * 0.9;
    expect(phaseEvents()).toBe(0);
    expect(enemy.phaseIndex).toBe(2);
  });

  it('unlocks a phase-gated ability only after the transition', () => {
    const enemy = spawn(king);
    const player = realPlayer(0, 2);
    let now = 1000;
    enemy.enterState('combat', now);
    enemy.addThreat(player.id, 10);

    // A roll at the very top of the weight range picks the LAST selectable
    // ability, so this reads "the newest thing it can do".
    const newestAbility = (): string | null => {
      readyForNextDecision(enemy);
      decide(enemy, makeCtx([player], now, 0.999));
      return enemy.swing === null ? null : enemy.swing.ability.id;
    };

    enemy.hp = enemy.maxHp;
    // Phase 0: the ring is gated, so even the top roll can only find the stomp.
    expect(newestAbility()).toBe('stomp');
    now += 1000;
    enemy.hp = enemy.maxHp * 0.3;
    decide(enemy, makeCtx([player], now)); // cross into phase 1
    expect(enemy.phaseIndex).toBe(1);
    now += 1000;
    expect(newestAbility()).toBe('ring');
  });

  it('leashes on the ARENA radius rather than the generic leash', () => {
    const enemy = spawn(king, 0, 0);
    const player = realPlayer(0, 40);
    const now = 1000;
    enemy.enterState('combat', now);
    enemy.addThreat(player.id, 10);
    // 30 m from home: inside the def's 40 m leashRadius, outside the 25 m arena.
    enemy.x = 0;
    enemy.z = 30;
    decide(enemy, makeCtx([player], now));
    expect(enemy.state).toBe('return');
  });
});

describe('Caster casts are flagged so the client can show a stoppable bar', () => {
  it('marks a cast ability-start and leaves a swing unmarked', () => {
    const caster = def({
      id: 'enemy_hexer',
      archetype: 'caster',
      abilities: [
        ability({ id: 'hex', kind: 'projectile', rangeMax: 16, cast: true, windupMs: 1600 }),
      ],
    });
    const enemy = spawn(caster);
    const player = realPlayer(0, 10);
    const ctx = makeCtx([player], 1000);
    enemy.enterState('combat', 1000);
    enemy.addThreat(player.id, 10);
    decide(enemy, ctx);
    const start = ctx.events.find((e) => e.type === 'ability-start');
    if (start?.type !== 'ability-start') throw new Error('expected an ability-start');
    expect(start.cast).toBe(true);
    expect(start.durationMs).toBe(1600);
  });

  it('a stun drops the cast — the interrupt window is the counterplay', () => {
    const caster = def({
      id: 'enemy_hexer2',
      archetype: 'caster',
      abilities: [
        ability({ id: 'hex', kind: 'projectile', rangeMax: 16, cast: true, windupMs: 1600 }),
      ],
    });
    const enemy = spawn(caster);
    const player = realPlayer(0, 10);
    enemy.enterState('combat', 1000);
    enemy.addThreat(player.id, 10);
    decide(enemy, makeCtx([player], 1000));
    expect(enemy.swing).not.toBeNull();
    enemy.stunFor(2000, 1200);
    expect(enemy.swing).toBeNull();
  });
});

describe('once-per-life abilities', () => {
  it('are spent at commit, so interrupting one still burns it', () => {
    const warded = def({
      id: 'enemy_warded',
      abilities: [
        ability({ id: 'ward', kind: 'self_shield', oncePerLife: true, shieldPct: 25 }),
        ability({ id: 'swipe' }),
      ],
    });
    const enemy = spawn(warded);
    const player = realPlayer(0, 2);
    enemy.enterState('combat', 1000);
    enemy.addThreat(player.id, 10);
    decide(enemy, makeCtx([player], 1000));
    const first = enemy.swing === null ? null : enemy.swing.ability.id;
    expect(first).toBeDefined();
    if (first === 'ward') {
      expect(enemy.spentAbilities.has('ward')).toBe(true);
      // Interrupted before it landed — still spent.
      enemy.stunFor(100, 1100);
      expect(enemy.spentAbilities.has('ward')).toBe(true);
    }
    // A full reset gives it back: spent is per LIFE, not forever.
    enemy.resetToHome(2000);
    expect(enemy.spentAbilities.size).toBe(0);
    expect(enemy.phaseIndex).toBe(0);
  });
});

/**
 * The decal is a promise (COMBAT.md §5): whatever shape the player was shown
 * is the shape the server tests. These pin the two kinds whose resolution
 * P9-B declared but never wired — a circle that was silently resolving as a
 * melee cone, and a shield that granted nothing at all.
 */
describe('Ability kinds resolve as the shape they telegraph', () => {
  const caster = def({
    id: 'enemy_pool_caster',
    archetype: 'caster',
    abilities: [
      ability({
        id: 'pool',
        kind: 'ground_circle',
        clip: 'Bite_Front',
        rangeMin: 0,
        rangeMax: 14,
        circleRadius: 5,
        reach: 2.2,
        angleDeg: 90,
        windupMs: 1000,
        telegraph: true,
      }),
    ],
  });

  it('places the circle on the target, not on the caster', () => {
    const enemy = spawn(caster, 0, 0);
    const player = realPlayer(0, 10);
    const ctx = makeCtx([player], 1000);
    enemy.enterState('combat', 1000);
    enemy.addThreat(player.id, 10);
    decide(enemy, ctx);

    expect(enemy.swing?.ability.id).toBe('pool');
    expect(enemy.swing?.z).toBeCloseTo(10, 3);
    const decal = ctx.events.find((event) => event.type === 'telegraph');
    expect(decal).toBeDefined();
    if (decal?.type === 'telegraph') {
      expect(decal.z).toBeCloseTo(10, 3);
      expect(decal.size).toBe(5); // the CIRCLE radius, not the melee reach
    }
  });

  it('hits inside the circle at 10 m — a cone from the caster would not', () => {
    const enemy = spawn(caster, 0, 0);
    const player = realPlayer(0, 10);
    const ctx = makeCtx([player], 1000);
    enemy.enterState('combat', 1000);
    enemy.addThreat(player.id, 10);
    decide(enemy, ctx);

    const hpBefore = player.hp;
    move(enemy, [], makeCtx([player], 2100, 0.5));
    expect(player.hp).toBeLessThan(hpBefore);
  });

  it('spares anyone who walked out of it before contact', () => {
    const enemy = spawn(caster, 0, 0);
    const player = realPlayer(0, 10);
    const ctx = makeCtx([player], 1000);
    enemy.enterState('combat', 1000);
    enemy.addThreat(player.id, 10);
    decide(enemy, ctx);

    // The pool was placed at z = 10; step well clear of its 5 m radius.
    player.movement.z = 20;
    const hpBefore = player.hp;
    move(enemy, [], makeCtx([player], 2100, 0.5));
    expect(player.hp).toBe(hpBefore);
  });

  it('self_shield grants a real absorb that eats damage and then runs out', () => {
    const warded = def({
      id: 'enemy_warded_pool',
      abilities: [
        ability({
          id: 'ward',
          kind: 'self_shield',
          clip: 'Bite_Front',
          shieldPct: 25,
          shieldDurationMs: 5000,
          windupMs: 500,
          rangeMax: 30,
        }),
      ],
    });
    const enemy = spawn(warded, 0, 0);
    const player = realPlayer(0, 2);
    enemy.enterState('combat', 1000);
    enemy.addThreat(player.id, 10);
    decide(enemy, makeCtx([player], 1000));
    expect(enemy.swing?.ability.id).toBe('ward');

    move(enemy, [], makeCtx([player], 1600));
    const pool = enemy.effects.reduce((sum, effect) => sum + effect.shieldPool, 0);
    expect(pool).toBe(Math.round(enemy.maxHp * 0.25));

    // A hit smaller than the pool takes no HP at all, and is flagged absorbed.
    const events: CombatEvent[] = [];
    const hpBefore = enemy.hp;
    const hit = applyDamageToEnemy(enemy, player.id, player, 10, false, 0, 1700, events);
    expect(enemy.hp).toBe(hpBefore);
    expect(hit.flags & HitFlag.Absorbed).toBeTruthy();
    // Threat still counts the full swing: hitting a shield is not punished.
    expect(enemy.threat.get(player.id)).toBe(20);

    // Burst past the pool and HP starts moving again.
    applyDamageToEnemy(enemy, player.id, player, pool, false, 0, 1800, events);
    expect(enemy.hp).toBeLessThan(hpBefore);
  });
});
