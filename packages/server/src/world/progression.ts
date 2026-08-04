/**
 * Server progression (P7, PROGRESSION.md): XP awards + level-ups, banked
 * point allocation, skill-tree ranks, respec, and the character-specific
 * folds derived from them (stats, resource mods, effective ability defs).
 *
 * The WORLD calls in here during the tick (kill XP, zone discovery, procs);
 * the GATEWAY calls in for allocation requests and persists on the events
 * this module emits. All validation runs the SHARED helpers the client
 * predicts with — an honest client never sees a refusal, a dishonest one is
 * silently corrected by the next ProgressSync.
 */

import {
  MAX_LEVEL,
  RespecWireKind,
  XpSource,
  aggregateNodeEffects,
  applyXpGain,
  applyXpRate,
  buildEffectiveDefs,
  canAllocateNode,
  XP_TAG_DAMAGE_FRACTION,
  killXp,
  neutralResourceMods,
  playerStats,
  rebuildResourceMax,
  respecCost,
  skillPointsForLevel,
  statPointsForLevel,
  xpToNext,
  type AbilityDef,
  type AttributeSpread,
  type NodeAggregates,
  type ResourceMods,
  type SkillNodeDef,
  type XpCurve,
  type EnemyRank,
} from '@dawned/shared';
import type { CombatEvent } from './combat.js';
import type { ServerPlayer } from './player.js';

/** Per-character progression state carried on the ServerPlayer. */
export interface PlayerProgress {
  /** XP into the current level (level itself lives on the player). */
  xp: number;
  gold: number;
  /** Spent attribute points on top of the class base spread. */
  allocated: AttributeSpread;
  unspentStatPoints: number;
  unspentSkillPoints: number;
  nodeRanks: Map<string, number>;
  /** Folded view of the allocated tree — rebuilt on any rank change. */
  aggregates: NodeAggregates;
  /** Node-rewritten ability defs (only touched abilities appear). */
  effectiveDefs: Map<string, AbilityDef>;
  /** Proc internal cooldowns by node id (Second Wind, Perfect Kill…). */
  procReadyAtMs: Map<string, number>;
  /** Class resource spent toward Colossus-style stack procs. */
  resourceSpentAccum: number;
  /** Landed-bolt counters for every-Nth procs, by ability id (Righteous Echo). */
  boltCounters: Map<string, number>;
  /** Zone slugs already discovered (loaded at spawn; grows in play). */
  zonesSeen: Set<string>;
  /** Serializes write-through saves so updates never interleave. */
  persistChain: Promise<void>;
}

export const createPlayerProgress = (spec: {
  xp: number;
  gold: number;
  allocated: AttributeSpread;
  unspentStatPoints: number;
  unspentSkillPoints: number;
  nodeRanks: Map<string, number>;
  zonesSeen: Set<string>;
}): PlayerProgress => ({
  xp: spec.xp,
  gold: spec.gold,
  allocated: { ...spec.allocated },
  unspentStatPoints: spec.unspentStatPoints,
  unspentSkillPoints: spec.unspentSkillPoints,
  nodeRanks: spec.nodeRanks,
  aggregates: aggregateNodeEffects(new Map(), new Map()),
  effectiveDefs: new Map(),
  procReadyAtMs: new Map(),
  resourceSpentAccum: 0,
  boltCounters: new Map(),
  zonesSeen: spec.zonesSeen,
  persistChain: Promise.resolve(),
});

/** Everything progression needs from the world's content. */
export interface ProgressionContent {
  xpCurve: XpCurve;
  skillNodes: ReadonlyMap<string, SkillNodeDef>;
  abilities: ReadonlyMap<string, AbilityDef>;
  xpRate: number;
}

/** Class-resource mods from the aggregated tree (Clarity/Flow/Vigor…). */
export const resourceModsOf = (player: ServerPlayer): ResourceMods | undefined => {
  const stats = player.progress.aggregates.stats;
  const mods = neutralResourceMods();
  if (player.resource.type === 'energy') {
    mods.maxFlat = stats.maxEnergyDelta;
    mods.regenFlat = stats.energyRegenDelta;
  } else if (player.resource.type === 'mana') {
    mods.maxPct = stats.maxManaPct;
    mods.regenPct = stats.manaRegenPct;
  }
  if (mods.maxFlat === 0 && mods.maxPct === 0 && mods.regenFlat === 0 && mods.regenPct === 0) {
    return undefined;
  }
  return mods;
};

/**
 * Re-derive stats/pools from level + allocation + node scalars. Called on
 * spawn, level-up, allocation, respec and content reload. `refill` tops HP,
 * stamina and pools up (the §1.3 level-up contract).
 */
export const rebuildPlayerDerived = (player: ServerPlayer, refill: boolean): void => {
  const agg = player.progress.aggregates.stats;
  // Worn gear adds attributes BEFORE the derivation (P8): a +5 VIT chest has
  // to raise Max HP through the same 12-per-VIT rule the sheet shows, not as
  // a bolted-on afterthought. Flat armor/crit apply after, like node scalars.
  const gear = player.items.bonus;
  const allocated = {
    str: player.progress.allocated.str + (gear.stats.str ?? 0),
    agi: player.progress.allocated.agi + (gear.stats.agi ?? 0),
    int: player.progress.allocated.int + (gear.stats.int ?? 0),
    vit: player.progress.allocated.vit + (gear.stats.vit ?? 0),
    end: player.progress.allocated.end + (gear.stats.end ?? 0),
  };
  const stats = playerStats(player.classId, player.level, allocated);
  stats.maxHp = Math.max(1, Math.round(stats.maxHp * (1 + agg.maxHpPct / 100)));
  stats.armor = (stats.armor + (gear.stats.armor ?? 0)) * (1 + agg.armorPct / 100);
  stats.critPct += agg.critPct + (gear.stats.critPct ?? 0);
  player.stats = stats;
  player.maxHp = stats.maxHp;
  player.hp = refill ? stats.maxHp : Math.min(player.hp, stats.maxHp);
  player.movement.maxStamina = stats.maxStamina;
  if (refill) {
    player.movement.stamina = stats.maxStamina;
  } else {
    player.movement.stamina = Math.min(player.movement.stamina, stats.maxStamina);
  }
  rebuildResourceMax(player.resource, player.classId, stats.int, resourceModsOf(player), refill);
};

/** Re-fold the allocated tree (aggregates + effective defs + derived stats). */
export const rebuildNodeFolds = (
  player: ServerPlayer,
  content: ProgressionContent,
  refill = false,
): void => {
  player.progress.aggregates = aggregateNodeEffects(content.skillNodes, player.progress.nodeRanks);
  player.progress.effectiveDefs = buildEffectiveDefs(
    content.abilities,
    player.progress.aggregates.abilityMods,
  );
  rebuildPlayerDerived(player, refill);
};

/** The def a THIS PLAYER'S press should run: node-rewritten, else authored. */
export const effectiveDefOf = (
  player: ServerPlayer,
  abilityId: string,
  authored: ReadonlyMap<string, AbilityDef>,
): AbilityDef | undefined =>
  player.progress.effectiveDefs.get(abilityId) ?? authored.get(abilityId);

// ---------------------------------------------------------------------------
// XP awards + level-ups
// ---------------------------------------------------------------------------

/**
 * Award XP through the curve: bar events always, level-ups cascade with the
 * full §1.3 juice contract (refill, banked points, broadcast). `raw` is the
 * pre-xpRate amount; capped characters ignore awards entirely.
 */
export const awardXp = (
  player: ServerPlayer,
  raw: number,
  source: XpSource,
  content: ProgressionContent,
  events: CombatEvent[],
): void => {
  if (player.dead && source === XpSource.Kill) return; // dead taggers earn nothing
  if (player.level >= MAX_LEVEL || raw <= 0) return;
  const amount = applyXpRate(raw, content.xpRate);
  const result = applyXpGain(
    content.xpCurve,
    { level: player.level, xp: player.progress.xp },
    amount,
  );
  player.progress.xp = result.xp;
  events.push({
    type: 'xp-gained',
    playerId: player.id,
    amount,
    source,
    xp: result.xp,
    level: result.level,
  });
  if (result.levelsGained > 0) {
    const from = player.level;
    player.level = result.level;
    player.progress.unspentStatPoints +=
      statPointsForLevel(result.level) - statPointsForLevel(from);
    player.progress.unspentSkillPoints +=
      skillPointsForLevel(result.level) - skillPointsForLevel(from);
    rebuildPlayerDerived(player, true);
    events.push({ type: 'level-up', playerId: player.id, level: result.level });
  }
  events.push({ type: 'progress-dirty', playerId: player.id });
};

/** Kill XP for every tagged player (≥10% damage OR healed a tagger). */
/**
 * Who earned this kill (PROGRESSION.md §1.1): ≥10% of the damage, or any heal
 * on someone who did (Cleric-safe). ONE definition — XP awards and loot rolls
 * both read it, so a player can never be paid by one and skipped by the other.
 */
export const killTaggers = (ledger: {
  damage: ReadonlyMap<number, number>;
  healAssists: ReadonlyMap<number, ReadonlySet<number>>;
}): Set<number> => {
  let total = 0;
  for (const amount of ledger.damage.values()) total += amount;
  const tagged = new Set<number>();
  if (total <= 0) return tagged;
  for (const [playerId, amount] of ledger.damage) {
    if (amount / total >= XP_TAG_DAMAGE_FRACTION) tagged.add(playerId);
  }
  for (const [healerId, healedWho] of ledger.healAssists) {
    if (tagged.has(healerId)) continue;
    for (const targetId of healedWho) {
      if (tagged.has(targetId)) {
        tagged.add(healerId);
        break;
      }
    }
  }
  return tagged;
};

export const awardKillXp = (
  taggers: {
    damage: ReadonlyMap<number, number>;
    healAssists: ReadonlyMap<number, ReadonlySet<number>>;
  },
  mobLevel: number,
  rank: EnemyRank,
  xpMult: number,
  players: ReadonlyMap<number, ServerPlayer>,
  content: ProgressionContent,
  events: CombatEvent[],
): void => {
  for (const playerId of killTaggers(taggers)) {
    const player = players.get(playerId);
    if (!player || player.dead) continue;
    awardXp(player, killXp(mobLevel, rank, player.level, xpMult), XpSource.Kill, content, events);
  }
};

// ---------------------------------------------------------------------------
// Allocation + respec (gateway request handlers)
// ---------------------------------------------------------------------------

/**
 * Spend banked attribute points. Deltas were staged client-side; the sum
 * must fit the bank. Returns false on refusal (client re-syncs either way).
 */
export const allocateStats = (
  player: ServerPlayer,
  deltas: AttributeSpread,
  events: CombatEvent[],
): boolean => {
  const parts = [deltas.str, deltas.agi, deltas.int, deltas.vit, deltas.end];
  const total = parts.reduce((sum, n) => sum + n, 0);
  const valid =
    parts.every((n) => Number.isInteger(n) && n >= 0) &&
    total > 0 &&
    total <= player.progress.unspentStatPoints;
  if (valid) {
    player.progress.allocated.str += deltas.str;
    player.progress.allocated.agi += deltas.agi;
    player.progress.allocated.int += deltas.int;
    player.progress.allocated.vit += deltas.vit;
    player.progress.allocated.end += deltas.end;
    player.progress.unspentStatPoints -= total;
    rebuildPlayerDerived(player, false);
  }
  events.push({ type: 'progress-dirty', playerId: player.id });
  return valid;
};

/** Put one rank into a node (shared gate decides). */
export const allocateSkill = (
  player: ServerPlayer,
  nodeId: string,
  content: ProgressionContent,
  events: CombatEvent[],
): boolean => {
  const verdict = canAllocateNode(
    content.skillNodes,
    player.progress.nodeRanks,
    nodeId,
    player.level,
    player.progress.unspentSkillPoints,
  );
  if (verdict.ok) {
    player.progress.nodeRanks.set(nodeId, (player.progress.nodeRanks.get(nodeId) ?? 0) + 1);
    player.progress.unspentSkillPoints -= 1;
    rebuildNodeFolds(player, content);
  }
  events.push({ type: 'progress-dirty', playerId: player.id });
  return verdict.ok;
};

/**
 * Mirror of Dawn respec (§6): full refund for gold. The Mirror is a Dawnhaven
 * interactable that exists at P12 — until the world does, the panel button
 * works from anywhere (PROGRESSION.md as-built note; the price still bites).
 */
export const respec = (
  player: ServerPlayer,
  wireKind: number,
  content: ProgressionContent,
  events: CombatEvent[],
): boolean => {
  const kind =
    wireKind === (RespecWireKind.Skills as number)
      ? ('skills' as const)
      : wireKind === (RespecWireKind.Stats as number)
        ? ('stats' as const)
        : null;
  let ok = false;
  if (kind !== null) {
    const cost = respecCost(kind, player.level);
    if (player.progress.gold >= cost) {
      const hasAnything =
        kind === 'skills'
          ? player.progress.nodeRanks.size > 0
          : player.progress.allocated.str +
              player.progress.allocated.agi +
              player.progress.allocated.int +
              player.progress.allocated.vit +
              player.progress.allocated.end >
            0;
      if (hasAnything) {
        player.progress.gold -= cost;
        if (kind === 'skills') {
          player.progress.nodeRanks.clear();
          player.progress.unspentSkillPoints = skillPointsForLevel(player.level);
          rebuildNodeFolds(player, content);
        } else {
          player.progress.allocated = { str: 0, agi: 0, int: 0, vit: 0, end: 0 };
          player.progress.unspentStatPoints = statPointsForLevel(player.level);
          rebuildPlayerDerived(player, false);
        }
        ok = true;
      }
    }
  }
  events.push({ type: 'progress-dirty', playerId: player.id });
  return ok;
};

/**
 * GM/dev level set (pre-GM-suite, P7 DoD tool): jumps to `level` with a
 * clean bank. Down-levels refund everything free (allocation could exceed
 * the smaller bank) — it is a testing tool, not an economy surface.
 */
export const setLevel = (
  player: ServerPlayer,
  level: number,
  content: ProgressionContent,
  events: CombatEvent[],
): void => {
  const target = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  const down = target < player.level;
  player.level = target;
  player.progress.xp = 0;
  if (down) {
    player.progress.nodeRanks.clear();
    player.progress.allocated = { str: 0, agi: 0, int: 0, vit: 0, end: 0 };
    player.progress.unspentStatPoints = statPointsForLevel(target);
    player.progress.unspentSkillPoints = skillPointsForLevel(target);
  } else {
    const spentStats =
      player.progress.allocated.str +
      player.progress.allocated.agi +
      player.progress.allocated.int +
      player.progress.allocated.vit +
      player.progress.allocated.end;
    let spentSkills = 0;
    for (const ranks of player.progress.nodeRanks.values()) spentSkills += ranks;
    player.progress.unspentStatPoints = Math.max(0, statPointsForLevel(target) - spentStats);
    player.progress.unspentSkillPoints = Math.max(0, skillPointsForLevel(target) - spentSkills);
  }
  rebuildNodeFolds(player, content, true);
  events.push({ type: 'level-up', playerId: player.id, level: target });
  events.push({ type: 'progress-dirty', playerId: player.id });
};

/** The ProgressSync payload for one player (gateway encodes + sends). */
export const progressSyncOf = (
  player: ServerPlayer,
  content: ProgressionContent,
): {
  level: number;
  xp: number;
  xpToNext: number;
  gold: number;
  unspentStatPoints: number;
  unspentSkillPoints: number;
  allocated: AttributeSpread;
  nodes: Record<string, number>;
} => ({
  level: player.level,
  xp: player.progress.xp,
  xpToNext: xpToNext(content.xpCurve, player.level),
  gold: player.progress.gold,
  unspentStatPoints: player.progress.unspentStatPoints,
  unspentSkillPoints: player.progress.unspentSkillPoints,
  allocated: { ...player.progress.allocated },
  nodes: Object.fromEntries(player.progress.nodeRanks),
});
