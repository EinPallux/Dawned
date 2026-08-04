/**
 * Human wording for the P7 panels, generated from the DATA (UI_UX.md §4:
 * "derived stats list with hover formulas — transparency!"). Node tooltips
 * render each rank's structured effect list; the character sheet mirrors the
 * exact derived formulas (playerStats + node folds) the server computes with.
 */

import {
  CLASS_BASE_ATTRIBUTES,
  RESOURCE_BY_CLASS,
  attributeTotals,
  maxResourceFor,
  neutralResourceMods,
  playerStats,
  staminaRegenForEnd,
  type AttributeSpread,
  type ClassId,
  type EquipmentBonus,
  type NodeAggregates,
  type NodeEffect,
  type SkillNodeDef,
} from '@dawned/shared';

const signed = (value: number, unit = ''): string =>
  `${value >= 0 ? '+' : '−'}${Math.abs(Number(value.toFixed(2)))}${unit}`;

const seconds = (ms: number): string => `${Number((Math.abs(ms) / 1000).toFixed(2))} s`;

/** Sheet-scalar labels (stat effects + the numeric half of ability mods). */
const STAT_LABELS: Record<string, (v: number) => string> = {
  maxHpPct: (v) => `${signed(v, '%')} Max HP`,
  armorPct: (v) => `${signed(v, '%')} Armor`,
  maxManaPct: (v) => `${signed(v, '%')} Max Mana`,
  manaRegenPct: (v) => `${signed(v, '%')} Mana regen`,
  maxEnergyDelta: (v) => `${signed(v)} Max Energy`,
  energyRegenDelta: (v) => `${signed(v)}/s Energy regen`,
  critPct: (v) => `${signed(v, '%')} Crit chance`,
  spellCritPct: (v) => `${signed(v, '%')} spell Crit chance`,
  physicalDamagePct: (v) => `${signed(v, '%')} physical damage`,
  magicDamagePct: (v) => `${signed(v, '%')} magic damage`,
  damageTakenPct: (v) => `${signed(v, '%')} damage taken`,
  healingDonePct: (v) => `${signed(v, '%')} healing done`,
  moveSpeedPct: (v) => `${signed(v, '%')} move speed`,
  dodgeStaminaCostDelta: (v) => `${signed(v)} dodge stamina cost`,
  sprintStaminaPerSDelta: (v) => `${signed(v)}/s sprint stamina drain`,
  ccOnYouDurationPct: (v) => `${signed(v, '%')} crowd-control duration on you`,
  ccDealtDurationDeltaMs: (v) => `${signed(v / 1000, ' s')} to control you apply`,
  rageOnBasicHitDelta: (v) => `${signed(v)} Rage per basic hit`,
  rageWhenHitDelta: (v) => `${signed(v)} Rage when hit`,
};

/** Per-ability numeric rewrites (the def deltas both sides fold). */
const ABILITY_MOD_LABELS: Record<string, (v: number) => string> = {
  damagePct: (v) => `${signed(v, '%')} damage`,
  coefDelta: (v) => `${signed(v)} coefficient`,
  healCoefDelta: (v) => `${signed(v)} heal coefficient`,
  cooldownDeltaMs: (v) => `${signed(v / 1000, ' s')} cooldown`,
  castDeltaMs: (v) => `${signed(v / 1000, ' s')} cast time`,
  channelDeltaMs: (v) => `${signed(v / 1000, ' s')} channel`,
  costDelta: (v) => `${signed(v)} cost`,
  radiusDelta: (v) => `${signed(v, ' m')} radius`,
  rangeDelta: (v) => `${signed(v, ' m')} range`,
  arcDeltaDeg: (v) => `${signed(v, '°')} arc`,
  maxTargetsDelta: (v) => `${signed(v)} max targets`,
  ticksDelta: (v) => `${signed(v)} ticks`,
  ccDurationDeltaMs: (v) => `${signed(v / 1000, ' s')} control duration`,
  buffDurationDeltaMs: (v) => `${signed(v / 1000, ' s')} buff duration`,
  zoneDurationDeltaMs: (v) => `${signed(v / 1000, ' s')} zone duration`,
  zoneRadiusDelta: (v) => `${signed(v, ' m')} zone radius`,
  dotDamagePct: (v) => `${signed(v, '%')} periodic damage`,
  dotDurationDeltaMs: (v) => `${signed(v / 1000, ' s')} periodic duration`,
  markDamagePctDelta: (v) => `${signed(v, '%')} mark bonus`,
  appliedMoveSpeedDeltaPct: (v) => `${signed(v, '%')} applied slow`,
  manaShieldPerPoint: (v) => `${v} absorb per Mana`,
  shieldPct: (v) => `${signed(v, '%')} absorb`,
};

const prettifyKey = (key: string): string =>
  key
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .toLowerCase()
    .trim();

/** One structured mods object → readable fragments (label table + fallback). */
const describeMods = (
  mods: Record<string, unknown>,
  labels: Record<string, (v: number) => string>,
): string[] => {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(mods)) {
    if (value === undefined || value === null || key === 'kind') continue;
    const label = labels[key];
    if (label && typeof value === 'number') {
      parts.push(label(value));
    } else if (typeof value === 'boolean') {
      if (value) parts.push(prettifyKey(key));
    } else if (typeof value === 'number') {
      parts.push(`${prettifyKey(key)} ${signed(value)}`);
    } else if (key === 'addEffects') {
      parts.push('adds an effect');
    } else if (key === 'critVs') {
      parts.push('can crit vs marked states');
    } else if (key === 'resetCooldownOf' && typeof value === 'string') {
      parts.push(`resets ${abilityWord(value)}'s cooldown`);
    } else if (key === 'alsoCastFree' && typeof value === 'string') {
      parts.push(`also casts ${abilityWord(value)} free`);
    } else if (key === 'onUseGrant') {
      const grant = value as { mana?: number; nextCastInstant?: unknown };
      if (grant.mana) parts.push(`${signed(grant.mana)} Mana on use`);
      if (grant.nextCastInstant) parts.push('next cast is instant');
    } else if (key === 'empowerBasics') {
      const emp = value as { count: number; attackSpeedPct: number };
      parts.push(`next ${emp.count} basics swing ${emp.attackSpeedPct}% faster`);
    } else if (key === 'everyNBonusBolt') {
      const bolt = value as { n: number };
      parts.push(`every ${bolt.n}. use fires a bonus bolt`);
    } else if (key === 'consumeBonus') {
      parts.push('bonus when consuming its state');
    } else if (key === 'zoneAllyMods') {
      parts.push('allies inside gain more');
    } else if (key === 'epicenterStun') {
      const stun = value as { durationMs: number };
      parts.push(`stuns ${seconds(stun.durationMs)} at the epicenter`);
    } else if (key === 'guaranteedCritAtCp') {
      const crit = value as { cp: number };
      parts.push(`always crits at ${crit.cp} combo points`);
    } else if (key === 'overhealToHot') {
      const hot = value as { pct: number; durationMs: number };
      parts.push(`${hot.pct}% of overhealing becomes a ${seconds(hot.durationMs)} heal over time`);
    } else {
      parts.push(prettifyKey(key));
    }
  }
  return parts;
};

/** `ability_warrior_whirlwind` → "Whirlwind" via the loaded name index. */
let abilityNames = new Map<string, string>();
export const setAbilityNames = (names: Map<string, string>): void => {
  abilityNames = names;
};
const abilityWord = (abilityId: string): string =>
  abilityNames.get(abilityId) ?? abilityId.split('_').slice(2).join(' ');

/** One effect → one player-facing line. Data in, words out — no hand text. */
export const describeEffect = (effect: NodeEffect): string => {
  switch (effect.kind) {
    case 'stat':
      return describeMods(effect.mods, STAT_LABELS).join(', ');
    case 'conditional_damage': {
      const targets: string[] = [];
      if (effect.vsCategories) targets.push(`${effect.vsCategories.join('/')} targets`);
      if (effect.vsHpBelowPct) targets.push(`targets under ${effect.vsHpBelowPct}% HP`);
      if (effect.vsStaggered) targets.push('staggered targets');
      if (effect.vsStunned) targets.push('stunned targets');
      return `${signed(effect.pct, '%')} damage vs ${targets.join(' and ')}`;
    }
    case 'ability_mod':
      return `${abilityWord(effect.abilityId)}: ${describeMods(effect.mods, ABILITY_MOD_LABELS).join(', ')}`;
    case 'effect_mod': {
      const parts: string[] = [];
      if (effect.dotDamagePct) parts.push(`tick ${signed(effect.dotDamagePct, '%')}`);
      if (effect.durationDeltaMs) {
        parts.push(`last ${signed(effect.durationDeltaMs / 1000, ' s')}`);
      }
      if (effect.moveSpeedDeltaPct) parts.push(`slow ${signed(effect.moveSpeedDeltaPct, '%')}`);
      if (effect.addTargetMods) parts.push('weaken their bearer');
      return `Your ${effect.category}s ${parts.join(', ')}`;
    }
    case 'stance_mod': {
      const parts: string[] = [];
      if (effect.blockStaminaCostPct) {
        parts.push(`block costs ${signed(effect.blockStaminaCostPct, '%')} stamina`);
      }
      if (effect.blockMitigationDelta) {
        parts.push(`${signed(effect.blockMitigationDelta, '%')} block mitigation`);
      }
      if (effect.perfectBlockStaminaRefund) {
        parts.push(`perfect blocks refund ${effect.perfectBlockStaminaRefund} stamina`);
      }
      return parts.join(', ');
    }
    case 'passive_mod': {
      const parts: string[] = [];
      if (effect.attunementManaDelta) {
        parts.push(`Attunement refunds ${signed(effect.attunementManaDelta)} Mana`);
      }
      if (effect.ambusherRearCritDelta) {
        parts.push(`${signed(effect.ambusherRearCritDelta, '%')} crit from behind`);
      }
      if (effect.finisherRefund) {
        parts.push(
          `finishers at ${effect.finisherRefund.minCp}+ CP refund ${effect.finisherRefund.energyPerCp} Energy per point`,
        );
      }
      if (effect.poisonsCanCrit) parts.push('poisons can crit');
      if (effect.poisonJumpOnDeath) parts.push('poisons jump on kill');
      return parts.join(', ');
    }
    case 'proc':
      switch (effect.proc) {
        case 'low_hp_heal':
          return `Below ${effect.thresholdPct}% HP: heal ${effect.healPct}% Max HP (${Math.round(effect.icdMs / 1000)} s cooldown)`;
        case 'low_hp_free_cast':
          return `Below ${effect.thresholdPct}% HP: free ${abilityWord(effect.abilityId)} (${Math.round(effect.icdMs / 1000)} s cooldown)`;
        case 'on_kill_buff':
          return `Kills grant ${
            describeMods(effect.mods, STAT_MODS_ON_EFFECT).join(', ') || 'a buff'
          } for ${seconds(effect.durationMs)}`;
        case 'resource_spent_stacks':
          return `Every ${effect.perSpent} ${effect.resource} spent: a stack (max ${effect.stacksMax}) for ${seconds(effect.durationMs)}`;
        case 'melee_thorns':
          return `Melee attackers take ${effect.coef} coefficient damage`;
        case 'block_thorns':
          return `Blocked attackers take ${effect.coef} coefficient damage`;
        case 'melee_attacker_apply':
          return `Melee attackers suffer a ${effect.category} for ${seconds(effect.durationMs)}`;
        case 'on_self_heal_buff':
          return `Healing yourself${effect.inCombatOnly ? ' in combat' : ''} grants ${
            describeMods(effect.mods, STAT_MODS_ON_EFFECT).join(', ') || 'a buff'
          } for ${seconds(effect.durationMs)}`;
      }
  }
  return '';
};

/** Labels for the AbilityEffectMods shape granted by procs (buff payloads). */
const STAT_MODS_ON_EFFECT: Record<string, (v: number) => string> = {
  damageDealtPct: (v) => `${signed(v, '%')} damage`,
  damageTakenPct: (v) => `${signed(v, '%')} damage taken`,
  moveSpeedPct: (v) => `${signed(v, '%')} move speed`,
  attackSpeedPct: (v) => `${signed(v, '%')} attack speed`,
  armorPct: (v) => `${signed(v, '%')} armor`,
  critPct: (v) => `${signed(v, '%')} crit`,
  dodgeCostDelta: (v) => `${signed(v)} dodge cost`,
};

/** All lines for a node at `rank` (0 → the rank-1 preview). */
export const describeNodeRank = (def: SkillNodeDef, rank: number): string[] => {
  const clamped = Math.min(Math.max(rank, 1), def.maxRanks);
  return (def.ranks[clamped - 1] ?? []).map(describeEffect).filter((line) => line.length > 0);
};

// ---------------------------------------------------------------------------
// Character sheet — derived rows with their formulas (hover transparency)
// ---------------------------------------------------------------------------

export interface DerivedRow {
  label: string;
  value: string;
  /** The PROGRESSION.md §2 formula, shown on hover. */
  formula: string;
}

/**
 * Derived stats at (class, level, allocation), with the node folds applied
 * exactly like the server's rebuildPlayerDerived. `staged` lets the C panel
 * preview the +/- staging before Confirm.
 */
export const derivedRows = (
  classId: ClassId,
  level: number,
  allocated: AttributeSpread,
  aggregates: NodeAggregates,
  /**
   * Worn gear's flat contributions (armor, crit). Attribute bonuses are folded
   * into `allocated` by the caller BEFORE derivation — the same order the
   * server uses, so a +5 VIT chest raises Max HP through the 12-per-VIT rule
   * rather than as a bolted-on afterthought.
   */
  gear?: EquipmentBonus,
): DerivedRow[] => {
  const stats = playerStats(classId, level, allocated);
  const agg = aggregates.stats;
  const maxHp = Math.max(1, Math.round(stats.maxHp * (1 + agg.maxHpPct / 100)));
  const armor = (stats.armor + (gear?.stats.armor ?? 0)) * (1 + agg.armorPct / 100);
  const crit = stats.critPct + agg.critPct + (gear?.stats.critPct ?? 0);
  const resourceType = RESOURCE_BY_CLASS[classId];
  const mods = neutralResourceMods();
  if (resourceType === 'energy') mods.maxFlat = agg.maxEnergyDelta;
  else if (resourceType === 'mana') mods.maxPct = agg.maxManaPct;
  const resourceMax = maxResourceFor(classId, stats.int, mods);
  const rows: DerivedRow[] = [
    {
      label: 'Max HP',
      value: String(maxHp),
      formula: '80 + 12×VIT + 6×(level−1), ×(1 + node %)',
    },
    {
      label: 'Attack Power',
      value: String(Math.round(stats.ap)),
      formula: classId === 'rogue' ? 'AGI (class primary)' : 'STR (class primary)',
    },
    {
      label: 'Spell Power',
      value: String(Math.round(stats.sp)),
      formula: 'INT',
    },
    {
      label: 'Crit chance',
      value: `${crit.toFixed(1)}%`,
      formula: '5 + 0.04×AGI, + node points',
    },
    {
      label: 'Armor',
      value: armor.toFixed(1),
      formula: 'worn armor + 0.5×STR, ×(1 + node %)',
    },
    {
      label: `Max ${resourceType === 'mana' ? 'Mana' : resourceType === 'energy' ? 'Energy' : 'Rage'}`,
      value: String(resourceMax),
      formula:
        resourceType === 'mana' ? '100 + 10×INT, ×(1 + node %)' : 'class pool + node bonuses',
    },
    {
      label: 'Max Stamina',
      value: String(Math.round(stats.maxStamina)),
      formula: '100 + 5×END + 2×(level−1)',
    },
    {
      label: 'Stamina regen',
      value: `${stats.staminaRegenPerS.toFixed(1)}/s`,
      formula: `base + 0.2/s per 4 END (END ${attributeTotals(classId, allocated).end})`,
    },
  ];
  if (agg.moveSpeedPct !== 0) {
    rows.push({
      label: 'Move speed',
      value: `+${agg.moveSpeedPct}%`,
      formula: '5.5 m/s jog ± node %',
    });
  }
  return rows;
};

/** The §2 recommended-build line ("Suggested: Warrior — 2 STR 1 VIT"). */
export const suggestedAllocation = (classId: ClassId): AttributeSpread => {
  switch (classId) {
    case 'warrior':
      return { str: 2, agi: 0, int: 0, vit: 1, end: 0 };
    case 'mage':
      return { str: 0, agi: 0, int: 2, vit: 1, end: 0 };
    case 'rogue':
      return { str: 0, agi: 2, int: 0, vit: 0, end: 1 };
    case 'cleric':
      return { str: 0, agi: 0, int: 2, vit: 1, end: 0 };
  }
};

export const CLASS_BASE = CLASS_BASE_ATTRIBUTES;
export { attributeTotals, staminaRegenForEnd };
