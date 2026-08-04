/**
 * The P7 node-effect matrix (phase DoD): every one of the 96 published
 * skill-tree nodes — at EVERY rank — must fold into an observable runtime
 * change, reference only published abilities of its own class, and sit
 * legally in its branch. Data-driven against the REAL published rows
 * (seeded by migration 0010; the panel may retune values, and this matrix
 * keeps whatever it publishes structurally sound).
 *
 * Skipped with a loud warning when no database is reachable (CI provides
 * one as a service container, like the auth suite).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  CLASS_BRANCHES,
  aggregateNodeEffects,
  applyAbilityMods,
  buildEffectiveDefs,
  emptyNodeAggregates,
  nodeGate,
  xpToNext,
  xpToNextDefault,
  MAX_LEVEL,
  type AbilityDef,
  type ClassId,
  type SkillNodeDef,
} from '@dawned/shared';
import { createDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadContent, type GameContent } from './loader.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://dawned:dawned@127.0.0.1:5432/dawned';

let content: GameContent | null = null;

beforeAll(async () => {
  try {
    await runMigrations(DATABASE_URL);
    const handle = createDb(DATABASE_URL);
    content = await loadContent(handle.db);
    await handle.close();
  } catch (error) {
    console.warn(
      `⚠️  progression content matrix SKIPPED — no PostgreSQL at ${DATABASE_URL} (${(error as Error).message})`,
    );
  }
}, 30_000);

/** The aggregates of exactly one node at one rank. */
const foldOne = (def: SkillNodeDef, rank: number): ReturnType<typeof aggregateNodeEffects> =>
  aggregateNodeEffects(new Map([[def.id, def]]), new Map([[def.id, rank]]));

/** Does this fold change ANYTHING a runtime system reads? */
const observable = (
  def: SkillNodeDef,
  rank: number,
  abilities: ReadonlyMap<string, AbilityDef>,
): boolean => {
  const agg = foldOne(def, rank);
  const empty = emptyNodeAggregates();
  const statsMoved = Object.entries(agg.stats).some(
    ([key, value]) => value !== empty.stats[key as keyof typeof empty.stats],
  );
  if (statsMoved) return true;
  if (agg.conditionals.length > 0 || agg.effectMods.length > 0 || agg.procs.length > 0) {
    return true;
  }
  if (
    agg.stance.blockStaminaCostPct !== 0 ||
    agg.stance.blockMitigationDelta !== 0 ||
    agg.stance.perfectBlockStaminaRefund !== 0
  ) {
    return true;
  }
  const p = agg.passives;
  if (
    p.attunementManaDelta !== 0 ||
    p.ambusherRearCritDelta !== 0 ||
    p.finisherRefund !== null ||
    p.poisonsCanCrit ||
    p.poisonJumpOnDeath
  ) {
    return true;
  }
  // Ability mods count when they actually rewrite the def OR carry a rider
  // the executor consumes at commit/resolve (riders don't touch def JSON).
  for (const [abilityId, modsList] of agg.abilityMods) {
    const authored = abilities.get(abilityId);
    if (!authored) continue;
    const effective = applyAbilityMods(authored, modsList);
    if (JSON.stringify(effective) !== JSON.stringify(authored)) return true;
    const RIDER_KEYS = [
      'addEffects',
      'critVs',
      'consumeBonus',
      'guaranteedCritAtCp',
      'epicenterStun',
      'resetCooldownOf',
      'alsoCastFree',
      'onUseGrant',
      'empowerBasics',
      'everyNBonusBolt',
      'zoneAllyMods',
      'overhealToHot',
      'breakMovementOnUse',
      'manaShieldPerPoint',
      'markDamagePctDelta',
      'dotDamagePct',
      'appliedMoveSpeedDeltaPct',
    ] as const;
    const riders = modsList.some((mods) => RIDER_KEYS.some((key) => mods[key] !== undefined));
    if (riders) return true;
  }
  return false;
};

describe('P7 progression content matrix (published rows)', () => {
  it('carries the complete tree: 96 nodes, 24 per class, one capstone per branch', () => {
    if (!content) return;
    const nodes = [...content.skillNodes.values()];
    expect(nodes).toHaveLength(96);
    for (const classId of Object.keys(CLASS_BRANCHES) as ClassId[]) {
      const ofClass = nodes.filter((node) => node.classId === classId);
      expect(ofClass, classId).toHaveLength(24);
      for (const branch of CLASS_BRANCHES[classId]) {
        const inBranch = ofClass.filter((node) => node.branch === branch.id);
        expect(inBranch, `${classId}/${branch.id}`).toHaveLength(8);
        expect(
          inBranch.filter((node) => node.capstone),
          `${classId}/${branch.id} capstone`,
        ).toHaveLength(1);
        // Unique display cells 1..8 — the lattice can't double-book a row.
        expect(new Set(inBranch.map((node) => node.order)).size).toBe(8);
      }
    }
  });

  it('every node at every rank folds into an observable runtime change', () => {
    if (!content) return;
    const dead: string[] = [];
    for (const def of content.skillNodes.values()) {
      for (let rank = 1; rank <= def.maxRanks; rank++) {
        if (!observable(def, rank, content.abilities)) dead.push(`${def.id}@${rank}`);
      }
    }
    expect(dead, `nodes with no observable effect: ${dead.join(', ')}`).toHaveLength(0);
  });

  it('per-rank effects only grow (cumulative ranks never lose an effect kind)', () => {
    if (!content) return;
    for (const def of content.skillNodes.values()) {
      for (let rank = 2; rank <= def.maxRanks; rank++) {
        const prev = def.ranks[rank - 2]!;
        const next = def.ranks[rank - 1]!;
        expect(next.length, `${def.id} rank ${rank}`).toBeGreaterThanOrEqual(prev.length);
      }
    }
  });

  it('every ability reference resolves to a published ability of the same class', () => {
    if (!content) return;
    const abilities = content.abilities;
    const check = (nodeId: string, classId: ClassId, abilityId: string): void => {
      const target = abilities.get(abilityId);
      expect(target, `${nodeId} → ${abilityId}`).toBeDefined();
      expect(target!.classId, `${nodeId} → ${abilityId} class`).toBe(classId);
    };
    for (const def of content.skillNodes.values()) {
      for (const effects of def.ranks) {
        for (const effect of effects) {
          if (effect.kind === 'ability_mod') {
            check(def.id, def.classId, effect.abilityId);
            if (effect.mods.resetCooldownOf)
              check(def.id, def.classId, effect.mods.resetCooldownOf);
            if (effect.mods.alsoCastFree) check(def.id, def.classId, effect.mods.alsoCastFree);
          }
          if (effect.kind === 'proc' && effect.proc === 'low_hp_free_cast') {
            check(def.id, def.classId, effect.abilityId);
          }
        }
      }
    }
  });

  it('effective defs stay machine-legal for every ability_mod node at max rank', () => {
    if (!content) return;
    for (const def of content.skillNodes.values()) {
      const agg = foldOne(def, def.maxRanks);
      const effective = buildEffectiveDefs(content.abilities, agg.abilityMods);
      for (const [abilityId, rewritten] of effective) {
        expect(rewritten.cooldownMs, `${def.id} → ${abilityId} cooldown`).toBeGreaterThanOrEqual(0);
        expect(rewritten.cost.amount, `${def.id} → ${abilityId} cost`).toBeGreaterThanOrEqual(0);
        if (rewritten.castMs > 0) {
          expect(rewritten.castMs, `${def.id} → ${abilityId} cast`).toBeGreaterThanOrEqual(200);
        }
        if (rewritten.channel) {
          expect(rewritten.channel.durationMs, `${def.id} → ${abilityId} channel`).toBeGreaterThan(
            0,
          );
          expect(rewritten.channel.tickEveryMs, `${def.id} → ${abilityId} tick`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('the whole ladder is reachable: gates open by 29 points and level 30', () => {
    if (!content) return;
    for (const def of content.skillNodes.values()) {
      const gate = nodeGate(def, MAX_LEVEL, 12);
      expect(gate.unlocked, `${def.id} unreachable at cap`).toBe(true);
    }
  });

  it('the published curve is complete and formula-exact (seeded defaults)', () => {
    if (!content) return;
    // Level-indexed array (curve[level] = xp to leave it, [0] unused).
    expect(content.xpCurve).toHaveLength(MAX_LEVEL);
    for (let level = 1; level < MAX_LEVEL; level++) {
      expect(xpToNext(content.xpCurve, level), `level ${level}`).toBe(xpToNextDefault(level));
    }
    expect(xpToNext(content.xpCurve, MAX_LEVEL)).toBe(0);
  });
});
