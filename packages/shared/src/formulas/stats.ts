/**
 * Derived combat stats for players and enemies — the single source both sides
 * read (docs/design/PROGRESSION.md §2, docs/design/NPCS_ENEMIES.md §5).
 *
 * P7: attribute totals = class base spread + player-allocated points (+3
 * banked per level, spent via the Character panel). Attribute GRANTS apply to
 * the total — a Warrior's base 14 STR is 7 armor before any allocation.
 * Gear bonuses stack on top at P8 through the same AttributeSpread shape.
 */

import { STAMINA_REGEN_PER_SEC } from '../constants.js';
import type { ClassId } from '../data/appearance.js';

export interface AttributeSpread {
  str: number;
  agi: number;
  int: number;
  vit: number;
  end: number;
}

/** Class starting spreads (PROGRESSION.md §2, sum 50). */
export const CLASS_BASE_ATTRIBUTES: Record<ClassId, AttributeSpread> = {
  warrior: { str: 14, agi: 9, int: 6, vit: 13, end: 8 },
  mage: { str: 6, agi: 9, int: 15, vit: 11, end: 9 },
  rogue: { str: 8, agi: 15, int: 6, vit: 10, end: 11 },
  cleric: { str: 9, agi: 7, int: 14, vit: 12, end: 8 },
};

/** The all-zero spread (fresh characters; also the "no gear" placeholder). */
export const zeroAttributes = (): AttributeSpread => ({ str: 0, agi: 0, int: 0, vit: 0, end: 0 });

/** Base spread + allocated points → the totals every grant reads. */
export const attributeTotals = (classId: ClassId, allocated: AttributeSpread): AttributeSpread => {
  const base = CLASS_BASE_ATTRIBUTES[classId];
  return {
    str: base.str + allocated.str,
    agi: base.agi + allocated.agi,
    int: base.int + allocated.int,
    vit: base.vit + allocated.vit,
    end: base.end + allocated.end,
  };
};

/** Stamina regen bonus: +0.2/s per 4 END points (PROGRESSION.md §2). */
export const staminaRegenForEnd = (endurance: number): number =>
  STAMINA_REGEN_PER_SEC + 0.2 * Math.floor(endurance / 4);

/** Everything combat math needs to know about an attacker/defender. */
export interface CombatStats {
  maxHp: number;
  /** Attack power (physical school). */
  ap: number;
  /** Spell power (magic school). */
  sp: number;
  /** Crit chance in percent (0–100). */
  critPct: number;
  armor: number;
  /** Magic mitigation in percent (0–100); players have none in 0.1.0. */
  magicResistPct: number;
  maxStamina: number;
  /** Stamina regenerated per second (END-scaled since P7). */
  staminaRegenPerS: number;
  /** INT attribute (mana pool sizing — CLASSES.md §0, v7). */
  int: number;
}

/**
 * Player stats at a level (PROGRESSION.md §2 derivations), with allocated
 * attribute points folded on top of the class base spread. AP comes from the
 * class primary (STR for Warrior, AGI for Rogue); casters lean on SP. Gear
 * armor is 0 until P8 items. Omitting `allocated` gives the unallocated
 * baseline (enemy-side callers, pre-P7 tests).
 */
export const playerStats = (
  classId: ClassId,
  level: number,
  allocated: AttributeSpread = zeroAttributes(),
): CombatStats => {
  const a = attributeTotals(classId, allocated);
  const primary = classId === 'rogue' ? a.agi : a.str;
  return {
    maxHp: 80 + 12 * a.vit + 6 * (level - 1),
    ap: primary,
    sp: a.int,
    critPct: 5 + 0.04 * a.agi,
    armor: 0.5 * a.str,
    magicResistPct: 0,
    maxStamina: 100 + 5 * a.end + 2 * (level - 1),
    staminaRegenPerS: staminaRegenForEnd(a.end),
    int: a.int,
  };
};

/**
 * Baseline weapon damage roll range at a level (COMBAT.md §6.2 `weaponDmg`).
 * Real weapons with rolled ranges arrive at P8 — until then every class swings
 * this implied training gear, scaled so damage keeps pace with enemy HP.
 */
export const baseWeaponDamage = (level: number): { min: number; max: number } => ({
  min: 4 + Math.floor(1.5 * (level - 1)),
  max: 6 + 2 * (level - 1),
});

// ---------------------------------------------------------------------------
// Enemies (NPCS_ENEMIES.md §5 — editor "suggest" formulas and P4 defaults)
// ---------------------------------------------------------------------------

export type EnemyArchetype = 'grunt' | 'ranged' | 'caster' | 'charger' | 'swarm' | 'dummy';
export type EnemyRank = 'normal' | 'elite' | 'zone_boss' | 'world_boss';

/** Damage multiplier per archetype (§5 archetypeMod). Dummies never attack. */
export const ARCHETYPE_DAMAGE_MOD: Record<EnemyArchetype, number> = {
  grunt: 1.0,
  ranged: 0.8,
  caster: 1.1,
  charger: 1.2,
  swarm: 0.45,
  dummy: 0,
};

/** Rank multipliers on base stats (§1). */
export const RANK_MULTIPLIERS: Record<EnemyRank, { hp: number; dmg: number }> = {
  normal: { hp: 1, dmg: 1 },
  elite: { hp: 2.5, dmg: 1.3 },
  zone_boss: { hp: 8, dmg: 1.6 },
  world_boss: { hp: 20, dmg: 1.9 },
};

/** Elite+ ranks gain stagger meter at a reduced rate (§1: elites 75%). */
export const RANK_STAGGER_GAIN: Record<EnemyRank, number> = {
  normal: 1,
  elite: 0.75,
  zone_boss: 0.5,
  world_boss: 0,
};

export interface EnemyBaseStats {
  maxHp: number;
  /** Damage per basic swing before per-ability coefficients. */
  swingDamage: number;
  armor: number;
  magicResistPct: number;
}

/** Base at-level stats before rank multipliers (§5 curve). */
export const enemyBaseStats = (level: number, archetype: EnemyArchetype): EnemyBaseStats => ({
  maxHp: Math.round(40 + 22 * Math.pow(level, 1.28)),
  swingDamage: (3 + 2.1 * level) * ARCHETYPE_DAMAGE_MOD[archetype],
  armor: (archetype === 'grunt' ? 8 : 4) * level,
  magicResistPct: archetype === 'caster' ? 20 : 10,
});

/** Full stats: curve × rank. Content rows may override any field on top. */
export const enemyStats = (
  level: number,
  archetype: EnemyArchetype,
  rank: EnemyRank,
): EnemyBaseStats => {
  const base = enemyBaseStats(level, archetype);
  const mult = RANK_MULTIPLIERS[rank];
  return {
    maxHp: Math.round(base.maxHp * mult.hp),
    swingDamage: base.swingDamage * mult.dmg,
    armor: base.armor,
    magicResistPct: base.magicResistPct,
  };
};
