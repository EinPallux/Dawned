import { describe, expect, it } from 'vitest';
import {
  buildXpCurve,
  defaultXpCurveEntries,
  validateXpCurveEntry,
  xpCurveProblems,
} from './xp-curve.js';
import { xpToNextDefault } from '../formulas/progression.js';
import {
  ALL_BRANCH_IDS,
  CLASS_BRANCHES,
  aggregateNodeEffects,
  branchPointsSpent,
  canAllocateNode,
  nodeGate,
  validateSkillNodeDef,
  type SkillNodeDef,
} from './skill-nodes.js';

// ---------------------------------------------------------------------------
// XP curve rows
// ---------------------------------------------------------------------------

describe('xp curve content', () => {
  it('generates 29 valid default rows matching the formula', () => {
    const entries = defaultXpCurveEntries();
    expect(entries).toHaveLength(29);
    for (const entry of entries) {
      expect(validateXpCurveEntry(entry)).toEqual(entry);
      expect(entry.xpToNext).toBe(xpToNextDefault(entry.level));
    }
    expect(entries[0]).toEqual({ id: 'xp_l01', level: 1, xpToNext: 90 });
    expect(entries[28]).toEqual({ id: 'xp_l29', level: 29, xpToNext: 32620 });
  });

  it('rejects id/level mismatches and out-of-range rows', () => {
    expect(() => validateXpCurveEntry({ id: 'xp_l02', level: 3, xpToNext: 100 })).toThrow(
      /does not match/,
    );
    expect(() => validateXpCurveEntry({ id: 'xp_l30', level: 30, xpToNext: 100 })).toThrow();
    expect(() => validateXpCurveEntry({ id: 'xp_l01', level: 1, xpToNext: 0 })).toThrow();
  });

  it('completeness check catches gaps and duplicates', () => {
    const entries = defaultXpCurveEntries();
    expect(xpCurveProblems(entries)).toEqual([]);
    const missing = entries.filter((entry) => entry.level !== 7);
    expect(xpCurveProblems(missing)).toEqual(['level 7 has no xp_curve row']);
    const doubled = [...entries, entries[3]!];
    expect(xpCurveProblems(doubled)).toEqual(['level 4 has 2 xp_curve rows']);
    expect(() => buildXpCurve(missing)).toThrow(/incomplete/);
  });

  it('buildXpCurve honors edited rows over the formula', () => {
    const entries = defaultXpCurveEntries().map((entry) =>
      entry.level === 5 ? { ...entry, xpToNext: 9999 } : entry,
    );
    const curve = buildXpCurve(entries);
    expect(curve[5]).toBe(9999);
    expect(curve[6]).toBe(xpToNextDefault(6));
  });
});

// ---------------------------------------------------------------------------
// Skill nodes
// ---------------------------------------------------------------------------

const statNode = (
  id: string,
  branch: string,
  tier: number,
  order: number,
  maxRanks: number,
  pctPerRank: number,
): SkillNodeDef =>
  validateSkillNodeDef({
    id,
    classId: 'warrior',
    branch,
    name: id,
    tier,
    order,
    maxRanks,
    ranks: Array.from({ length: maxRanks }, (_, i) => [
      { kind: 'stat', mods: { maxHpPct: pctPerRank * (i + 1) } },
    ]),
  });

describe('skill node schema', () => {
  it('the branch registry is consistent and slugs are unique', () => {
    expect(ALL_BRANCH_IDS).toHaveLength(12);
    expect(new Set(ALL_BRANCH_IDS).size).toBe(12);
    expect(CLASS_BRANCHES.warrior.map((branch) => branch.id)).toEqual([
      'bulwark',
      'warlord',
      'juggernaut',
    ]);
  });

  it('accepts one node of every effect kind', () => {
    const kinds: SkillNodeDef['ranks'][number] = [
      { kind: 'stat', mods: { physicalDamagePct: 2, moveSpeedPct: 3 } },
      { kind: 'conditional_damage', vsHpBelowPct: 30, pct: 5 },
      {
        kind: 'ability_mod',
        abilityId: 'ability_warrior_shield_wall',
        mods: { buffDurationDeltaMs: 1000, cooldownDeltaMs: -5000 },
      },
      { kind: 'effect_mod', category: 'bleed', dotDamagePct: 15, durationDeltaMs: 2000 },
      { kind: 'stance_mod', blockStaminaCostPct: -8 },
      { kind: 'passive_mod', finisherRefund: { minCp: 3, energyPerCp: 5 } },
      { kind: 'proc', proc: 'low_hp_heal', thresholdPct: 25, healPct: 20, icdMs: 90000 },
    ];
    const def = validateSkillNodeDef({
      id: 'node_warrior_bulwark_kitchen_sink',
      classId: 'warrior',
      branch: 'bulwark',
      name: 'Kitchen Sink',
      tier: 3,
      order: 5,
      maxRanks: 1,
      ranks: [kinds],
    });
    expect(def.ranks[0]).toHaveLength(7);
  });

  it('accepts ability_mod addEffects using the ability effect vocabulary', () => {
    const def = validateSkillNodeDef({
      id: 'node_cleric_wrath_searing_smite',
      classId: 'cleric',
      branch: 'wrath',
      name: 'Searing Smite',
      tier: 2,
      order: 3,
      maxRanks: 2,
      ranks: [
        [
          {
            kind: 'ability_mod',
            abilityId: 'ability_cleric_holy_smite',
            mods: {
              addEffects: [
                {
                  kind: 'apply_effect',
                  target: 'hit',
                  effectId: 'searing_smite',
                  durationMs: 4000,
                  stacksMax: 1,
                  category: 'burn',
                  mods: {
                    periodic: {
                      kind: 'damage',
                      coefTotal: 0.1,
                      school: 'magic',
                      tickEveryMs: 1000,
                    },
                  },
                },
              ],
            },
          },
        ],
        [
          {
            kind: 'ability_mod',
            abilityId: 'ability_cleric_holy_smite',
            mods: {
              addEffects: [
                {
                  kind: 'apply_effect',
                  target: 'hit',
                  effectId: 'searing_smite',
                  durationMs: 4000,
                  stacksMax: 1,
                  category: 'burn',
                  mods: {
                    periodic: {
                      kind: 'damage',
                      coefTotal: 0.2,
                      school: 'magic',
                      tickEveryMs: 1000,
                    },
                  },
                },
              ],
            },
          },
        ],
      ],
    });
    const rank1 = def.ranks[0]![0]!;
    expect(rank1.kind).toBe('ability_mod');
  });

  it('rejects rank-count mismatches, foreign branches and multi-rank capstones', () => {
    expect(() =>
      validateSkillNodeDef({
        id: 'node_warrior_bulwark_bad',
        classId: 'warrior',
        branch: 'bulwark',
        name: 'Bad',
        tier: 1,
        order: 1,
        maxRanks: 3,
        ranks: [[{ kind: 'stat', mods: { maxHpPct: 3 } }]],
      }),
    ).toThrow(/ranks has 1 entries/);
    expect(() =>
      validateSkillNodeDef({
        id: 'node_warrior_pyromancy_wat',
        classId: 'warrior',
        branch: 'pyromancy',
        name: 'Wat',
        tier: 1,
        order: 1,
        maxRanks: 1,
        ranks: [[{ kind: 'stat', mods: { maxHpPct: 3 } }]],
      }),
    ).toThrow(/not a warrior branch/);
    expect(() =>
      validateSkillNodeDef({
        id: 'node_warrior_bulwark_cap',
        classId: 'warrior',
        branch: 'bulwark',
        name: 'Cap',
        tier: 5,
        capstone: true,
        order: 8,
        maxRanks: 2,
        ranks: [
          [{ kind: 'stat', mods: { maxHpPct: 3 } }],
          [{ kind: 'stat', mods: { maxHpPct: 6 } }],
        ],
      }),
    ).toThrow(/single-rank/);
  });

  it('rejects unknown mod fields loudly (strict authoring)', () => {
    expect(() =>
      validateSkillNodeDef({
        id: 'node_warrior_bulwark_typo',
        classId: 'warrior',
        branch: 'bulwark',
        name: 'Typo',
        tier: 1,
        order: 1,
        maxRanks: 1,
        ranks: [[{ kind: 'stat', mods: { maxHpPercent: 3 } }]],
      }),
    ).toThrow();
  });
});

describe('tier gates (PROGRESSION.md §3)', () => {
  const defs = new Map<string, SkillNodeDef>();
  const t1 = statNode('node_warrior_bulwark_toughened', 'bulwark', 1, 1, 3, 3);
  const t2 = statNode('node_warrior_bulwark_plated', 'bulwark', 2, 3, 3, 5);
  const t4 = statNode('node_warrior_bulwark_second', 'bulwark', 4, 7, 1, 1);
  const cap = validateSkillNodeDef({
    id: 'node_warrior_bulwark_immovable',
    classId: 'warrior',
    branch: 'bulwark',
    name: 'Immovable',
    tier: 5,
    capstone: true,
    order: 8,
    maxRanks: 1,
    ranks: [[{ kind: 'stance_mod', perfectBlockStaminaRefund: 10 }]],
  });
  const other = statNode('node_warrior_warlord_sharpened', 'warlord', 1, 1, 3, 2);
  for (const def of [t1, t2, t4, cap, other]) defs.set(def.id, def);

  it('tier = points threshold AND level gate, whichever is later', () => {
    // Tier 1: 0 points, level 2.
    expect(nodeGate(t1, 1, 0).unlocked).toBe(false);
    expect(nodeGate(t1, 2, 0).unlocked).toBe(true);
    // Tier 2: 3 points AND level 5.
    expect(nodeGate(t2, 10, 2).unlocked).toBe(false);
    expect(nodeGate(t2, 4, 3).unlocked).toBe(false);
    expect(nodeGate(t2, 5, 3).unlocked).toBe(true);
    // Tier 4: 9 points AND level 15.
    expect(nodeGate(t4, 15, 8).pointsMissing).toBe(1);
    expect(nodeGate(t4, 14, 9).levelMissing).toBe(1);
    expect(nodeGate(t4, 15, 9).unlocked).toBe(true);
  });

  it('capstone: 8 in-branch points + level 25', () => {
    expect(nodeGate(cap, 25, 7).unlocked).toBe(false);
    expect(nodeGate(cap, 24, 8).unlocked).toBe(false);
    expect(nodeGate(cap, 25, 8).unlocked).toBe(true);
  });

  it('branch points only count the node’s own branch', () => {
    const ranks = new Map([
      [t1.id, 3],
      [other.id, 2],
    ]);
    expect(branchPointsSpent(ranks, defs, 'warrior', 'bulwark')).toBe(3);
    expect(branchPointsSpent(ranks, defs, 'warrior', 'warlord')).toBe(2);
  });

  it('canAllocateNode walks the whole rulebook', () => {
    const ranks = new Map([[t1.id, 3]]);
    expect(canAllocateNode(defs, ranks, 'node_nope', 10, 5)).toEqual({
      ok: false,
      reason: 'unknown_node',
    });
    expect(canAllocateNode(defs, ranks, t1.id, 10, 5)).toEqual({ ok: false, reason: 'maxed' });
    expect(canAllocateNode(defs, ranks, t2.id, 10, 0)).toEqual({ ok: false, reason: 'no_points' });
    expect(canAllocateNode(defs, ranks, t2.id, 4, 5)).toEqual({ ok: false, reason: 'locked' });
    const allowed = canAllocateNode(defs, ranks, t2.id, 5, 5);
    expect(allowed.ok).toBe(true);
    // Fresh character can open tier 1 the moment the first point exists.
    expect(canAllocateNode(defs, new Map(), t1.id, 2, 1).ok).toBe(true);
  });
});

describe('node aggregation', () => {
  it('sums stats, groups ability mods, keeps procs and flags', () => {
    const defs = new Map<string, SkillNodeDef>();
    const hp = statNode('node_warrior_bulwark_toughened', 'bulwark', 1, 1, 3, 3);
    const sharp = validateSkillNodeDef({
      id: 'node_warrior_warlord_sharpened',
      classId: 'warrior',
      branch: 'warlord',
      name: 'Sharpened',
      tier: 1,
      order: 1,
      maxRanks: 3,
      ranks: [2, 4, 6].map((pct) => [{ kind: 'stat', mods: { physicalDamagePct: pct } }]),
    });
    const brutality = validateSkillNodeDef({
      id: 'node_warrior_warlord_brutality',
      classId: 'warrior',
      branch: 'warlord',
      name: 'Brutality',
      tier: 2,
      order: 2,
      maxRanks: 2,
      ranks: [10, 20].map((pct) => [
        {
          kind: 'ability_mod',
          abilityId: 'ability_warrior_crushing_blow',
          mods: { damagePct: pct },
        },
      ]),
    });
    const colossus = validateSkillNodeDef({
      id: 'node_warrior_juggernaut_colossus',
      classId: 'warrior',
      branch: 'juggernaut',
      name: 'Colossus',
      tier: 5,
      capstone: true,
      order: 8,
      maxRanks: 1,
      ranks: [
        [
          {
            kind: 'proc',
            proc: 'resource_spent_stacks',
            resource: 'rage',
            perSpent: 30,
            effectId: 'colossus',
            durationMs: 10000,
            stacksMax: 3,
            mods: { damageDealtPct: 3, armorPct: 3 },
          },
        ],
      ],
    });
    for (const def of [hp, sharp, brutality, colossus]) defs.set(def.id, def);

    const agg = aggregateNodeEffects(
      defs,
      new Map([
        [hp.id, 2], // rank 2 → +6% HP
        [sharp.id, 3], // rank 3 → +6% phys
        [brutality.id, 1], // rank 1 → Crushing Blow +10%
        [colossus.id, 1],
      ]),
    );
    expect(agg.stats.maxHpPct).toBe(6);
    expect(agg.stats.physicalDamagePct).toBe(6);
    const crushing = agg.abilityMods.get('ability_warrior_crushing_blow');
    expect(crushing).toHaveLength(1);
    expect(crushing![0]!.damagePct).toBe(10);
    expect(agg.procs).toHaveLength(1);
    expect(agg.procs[0]!.proc.proc).toBe('resource_spent_stacks');
    expect(agg.procs[0]!.nodeId).toBe('node_warrior_juggernaut_colossus');
  });

  it('ignores unknown nodes and zero ranks (stale rows never crash a login)', () => {
    const agg = aggregateNodeEffects(new Map(), new Map([['node_gone_missing', 2]]));
    expect(agg.stats.maxHpPct).toBe(0);
    expect(agg.procs).toHaveLength(0);
  });
});
