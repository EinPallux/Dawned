/**
 * Skill-tree node content schema (PROGRESSION.md §3, CLASSES.md trees) — rows
 * in `content_skill_nodes` (PK (id, status), def jsonb, standard content
 * pattern), authored via the Dawned-Admin tree editor, validated here at every
 * boundary and folded into play by the server (and mirrored by the client for
 * sheet preview + allocation prediction).
 *
 * Design of the effect vocabulary: each node stores, PER RANK, the TOTAL
 * effect at that rank (cumulative, not a delta) — rank arrays make "+3% per
 * rank" read [3, 6, 9] and free odd curves from interpretation ambiguity.
 * The vocabulary is a closed set sized to express every 0.1.0 node
 * (96 across four classes) without a scripting escape hatch:
 *
 * - `stat`               character-sheet & pipeline scalars (HP%, armor%, crit,
 *                        school damage%, regen, stamina costs, CC durations…)
 * - `conditional_damage` +X% damage against targets in a state (Executioner,
 *                        Frostbite, Flensing, Judgement)
 * - `ability_mod`        per-ability def rewrites + on-use riders (coefs,
 *                        cooldowns, radii, added effects, resets, empowers…)
 * - `effect_mod`         tweaks to effects of a category the PLAYER applies
 *                        (burn/poison DoT %, durations, chill magnitude…)
 * - `stance_mod`         RMB stance parameter tweaks (block cost/mitigation,
 *                        perfect-block refunds)
 * - `passive_mod`        class-passive parameter tweaks (Attunement, Ambusher,
 *                        finisher refunds, poison rules)
 * - `proc`               reactive triggers with an ICD where needed (Second
 *                        Wind, Colossus stacks, thorns, auto-Aegis…)
 */

import { z } from 'zod';
import type { ClassId } from '../data/appearance.js';
import {
  abilityEffectSchema,
  classIdSchema,
  effectCategorySchema,
  effectModsSchema,
} from './abilities.js';

// ---------------------------------------------------------------------------
// Branch registry (design-fixed; nodes are the content)
// ---------------------------------------------------------------------------

export interface BranchMeta {
  /** Branch slug used by node rows (`bulwark`). */
  id: string;
  /** Display name ("Bulwark"). */
  name: string;
  /** One-line identity shown as the branch header subtitle. */
  theme: string;
}

/** The 3 branches per class, in display order (CLASSES.md §1–4). */
export const CLASS_BRANCHES: Record<ClassId, readonly [BranchMeta, BranchMeta, BranchMeta]> = {
  warrior: [
    { id: 'bulwark', name: 'Bulwark', theme: 'survive' },
    { id: 'warlord', name: 'Warlord', theme: 'damage' },
    { id: 'juggernaut', name: 'Juggernaut', theme: 'rage & utility' },
  ],
  mage: [
    { id: 'pyromancy', name: 'Pyromancy', theme: 'burst' },
    { id: 'cryomancy', name: 'Cryomancy', theme: 'control' },
    { id: 'arcana', name: 'Arcana', theme: 'resource & mobility' },
  ],
  rogue: [
    { id: 'assassination', name: 'Assassination', theme: 'crit & single-target' },
    { id: 'swiftblade', name: 'Swiftblade', theme: 'energy & mobility' },
    { id: 'toxicologist', name: 'Toxicologist', theme: 'poison & AoE' },
  ],
  cleric: [
    { id: 'light', name: 'Light', theme: 'healing' },
    { id: 'wrath', name: 'Wrath', theme: 'damage' },
    { id: 'warden', name: 'Warden', theme: 'defense & utility' },
  ],
};

/** Every legal branch slug (validation + editor dropdowns). */
export const ALL_BRANCH_IDS: readonly string[] = Object.values(CLASS_BRANCHES)
  .flat()
  .map((branch) => branch.id);

// ---------------------------------------------------------------------------
// Tier gating (PROGRESSION.md §3)
// ---------------------------------------------------------------------------

/** In-branch points required to open tier i+1 (tiers 1..5). */
export const TIER_POINT_THRESHOLDS = [0, 3, 6, 9, 12] as const;
/** Character level required to open tier i+1 — whichever is LATER applies. */
export const TIER_LEVEL_GATES = [2, 5, 10, 15, 20] as const;
/** Capstones ignore the tier ladder: 8 in-branch points + level 25. */
export const CAPSTONE_POINTS_REQUIRED = 8;
export const CAPSTONE_LEVEL_GATE = 25;

// ---------------------------------------------------------------------------
// Node effect vocabulary
// ---------------------------------------------------------------------------

/** Content ids: slugs like `node_warrior_bulwark_toughened`. */
const nodeIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^node_[a-z0-9_]+$/, 'skill node ids look like node_<class>_<branch>_<name>');

const abilityIdRefSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^ability_[a-z0-9_]+$/, 'ability refs look like ability_<class>_<name>');

/**
 * Character-sheet and combat-pipeline scalars. Everything sums across nodes;
 * percentages are additive with each other and multiply the base once summed
 * (server fold, P7-B). Signed where reduction is the point.
 */
export const nodeStatModsSchema = z
  .object({
    /** Derived-stat multipliers (percent). */
    maxHpPct: z.number().min(-50).max(100).optional(),
    armorPct: z.number().min(-50).max(200).optional(),
    maxManaPct: z.number().min(-50).max(100).optional(),
    manaRegenPct: z.number().min(-50).max(200).optional(),
    /** Flat pool/regen adds (Energy is flat by design — Conditioning/Vigor). */
    maxEnergyDelta: z.number().int().min(-50).max(50).optional(),
    energyRegenDelta: z.number().min(-6).max(6).optional(),
    /** Crit chance in percentage POINTS; spell-only variant for Critical Mass. */
    critPct: z.number().min(-10).max(20).optional(),
    spellCritPct: z.number().min(-10).max(20).optional(),
    /** Outgoing damage by school (percent). */
    physicalDamagePct: z.number().min(-50).max(100).optional(),
    magicDamagePct: z.number().min(-50).max(100).optional(),
    /** All incoming damage (Glacial Armor −3%). */
    damageTakenPct: z.number().min(-50).max(50).optional(),
    /** All outgoing healing (Devotion). */
    healingDonePct: z.number().min(-50).max(100).optional(),
    /** Movement (Fleet/Traveler/Pilgrim — folds into the shared step params). */
    moveSpeedPct: z.number().min(-30).max(30).optional(),
    /** Stamina economy (Acrobat, Marathon). */
    dodgeStaminaCostDelta: z.number().int().min(-15).max(0).optional(),
    sprintStaminaPerSDelta: z.number().min(-4).max(0).optional(),
    /** CC durations: on you (Thick Skull/Unshakeable, %), you deal (Relentless, ms). */
    ccOnYouDurationPct: z.number().min(-60).max(0).optional(),
    ccDealtDurationDeltaMs: z.number().int().min(0).max(1500).optional(),
    /** Rage economy riders (Boiling Blood, Enraging Defense). */
    rageOnBasicHitDelta: z.number().int().min(0).max(5).optional(),
    rageWhenHitDelta: z.number().int().min(0).max(5).optional(),
  })
  .strict();

/** +X% damage against targets currently in a matching state. */
const conditionalDamageSchema = z
  .object({
    kind: z.literal('conditional_damage'),
    /** Match any of these effect categories on the target… */
    vsCategories: z.array(effectCategorySchema).min(1).max(4).optional(),
    /** …or these entity states. */
    vsHpBelowPct: z.number().min(1).max(90).optional(),
    vsStaggered: z.boolean().optional(),
    vsStunned: z.boolean().optional(),
    pct: z.number().min(1).max(100),
  })
  .strict();

/**
 * Per-ability rewrites and on-use riders. Numeric deltas rewrite the def both
 * sides evaluate (cooldown/cast/cost feed the SHARED machine — prediction
 * stays exact); riders are server-applied at commit/resolve.
 */
export const abilityModsSchema = z
  .object({
    /** Direct damage effects ×(1+pct/100) / +coef (Brutality vs Warbringer). */
    damagePct: z.number().min(-90).max(200).optional(),
    coefDelta: z.number().min(-5).max(5).optional(),
    /** Finisher scaling (Deep Cuts). */
    coefPerComboPointDelta: z.number().min(0).max(1).optional(),
    /** Heal/shield effects (Cleansing Light, Guardian Aegis). */
    healCoefDelta: z.number().min(-5).max(5).optional(),
    healPct: z.number().min(-90).max(200).optional(),
    shieldPct: z.number().min(-90).max(200).optional(),
    /** Timing/costs — negative shortens/cheapens. Channel deltas keep the
     * bolt count (tickEveryMs scales with the duration, Quickened Barrage). */
    cooldownDeltaMs: z.number().int().min(-60000).max(60000).optional(),
    castDeltaMs: z.number().int().min(-2000).max(2000).optional(),
    channelDeltaMs: z.number().int().min(-3000).max(3000).optional(),
    costDelta: z.number().int().min(-50).max(50).optional(),
    /** Geometry (Wide Nova, Cleaving Blows, Elastic Blink, Rampage). */
    radiusDelta: z.number().min(-6).max(6).optional(),
    rangeDelta: z.number().min(-10).max(10).optional(),
    arcDeltaDeg: z.number().min(-60).max(60).optional(),
    maxTargetsDelta: z.number().int().min(-5).max(5).optional(),
    ticksDelta: z.number().int().min(-3).max(3).optional(),
    /** The ability's stun/root/knockdown durations (Permafrost). */
    ccDurationDeltaMs: z.number().int().min(-2000).max(2000).optional(),
    /** The ability's apply_effect buff/debuff durations (Unbreakable, Smoke
     * Trickery) and its zone lifetime/size (Blessed Ground). */
    buffDurationDeltaMs: z.number().int().min(-10000).max(10000).optional(),
    zoneDurationDeltaMs: z.number().int().min(-10000).max(10000).optional(),
    zoneRadiusDelta: z.number().min(-4).max(4).optional(),
    /** The ability's periodic riders (Deep Wounds bleed +15% & +2 s). */
    dotDamagePct: z.number().min(-90).max(200).optional(),
    dotDurationDeltaMs: z.number().int().min(-10000).max(10000).optional(),
    /** Death Mark's taken-from-caster percent (Ruthless). */
    markDamagePctDelta: z.number().int().min(0).max(50).optional(),
    /** Slow/chill magnitude on THIS ability's applied effects (Cripple Mastery:
     * −8 makes a −40% slow −48%). */
    appliedMoveSpeedDeltaPct: z.number().int().min(-30).max(0).optional(),
    /** Mana Shield efficiency override (Barrier Tuning: 2.0 → 1.75). */
    manaShieldPerPoint: z.number().min(0.5).max(10).optional(),
    /** Mend overheal converts to a HoT (Overflow: pct of overheal over ms). */
    overhealToHot: z
      .object({
        pct: z.number().min(5).max(100),
        durationMs: z.number().int().min(1000).max(10000),
      })
      .optional(),
    /** Appended to the def's effect list (Scorched Ground's field, Searing
     * Smite's DoT, Momentum/Battle Roar's self-buffs, Immovable's heal…).
     * Same shapes as authored ability effects — one applier serves both. */
    addEffects: z.array(abilityEffectSchema).min(1).max(4).optional(),
    /** Only apply addEffects/onHit riders vs targets bearing a category
     * (Winter's Grasp: Ice Lance vs chilled). */
    addEffectsRequireCategories: z.array(effectCategorySchema).min(1).max(4).optional(),
    /** Extra stun at the epicenter of a ground_aoe (Supernova). */
    epicenterStun: z
      .object({
        radius: z.number().min(0.5).max(6),
        durationMs: z.number().int().min(200).max(3000),
      })
      .optional(),
    /** Consume matching effects from hit targets for bonus coef (Combustion
     * per burning target, Caustic Burst per poison stack). */
    consumeBonus: z
      .object({
        category: effectCategorySchema,
        per: z.enum(['target', 'stack']),
        coef: z.number().min(0.01).max(2),
        max: z.number().int().min(1).max(10),
      })
      .optional(),
    /** Extra crit chance vs targets bearing a category (Shatter vs rooted). */
    critVs: z
      .object({
        categories: z.array(effectCategorySchema).min(1).max(4),
        pct: z.number().min(1).max(100),
      })
      .optional(),
    /** Guaranteed crit when spending exactly max CP (Perfect Kill). */
    guaranteedCritAtCp: z
      .object({
        cp: z.number().int().min(1).max(5),
        icdMs: z.number().int().min(1000).max(60000),
      })
      .optional(),
    /** On-use riders. */
    breakMovementOnUse: z.boolean().optional(),
    resetCooldownOf: abilityIdRefSchema.optional(),
    /** Free follow-up cast at the caster's feet (Dawn's Embrace). */
    alsoCastFree: abilityIdRefSchema.optional(),
    /** Grants on use: resource and/or a next-cast-instant window (Archmage). */
    onUseGrant: z
      .object({
        mana: z.number().int().min(0).max(50).optional(),
        nextCastInstant: z.object({ icdMs: z.number().int().min(1000).max(60000) }).optional(),
      })
      .optional(),
    /** Empower the next N basics after use (Flurry). */
    empowerBasics: z
      .object({
        count: z.number().int().min(1).max(5),
        attackSpeedPct: z.number().int().min(0).max(100),
        comboPointsPer: z.number().int().min(0).max(2),
      })
      .optional(),
    /** Every Nth use fires a free bonus bolt (Righteous Echo). */
    everyNBonusBolt: z
      .object({
        n: z.number().int().min(2).max(5),
        coef: z.number().min(0.1).max(2),
      })
      .optional(),
    /** Zone grants extra ally mods while inside (Beacon: +10% armor). */
    zoneAllyMods: effectModsSchema.optional(),
  })
  .strict();

const abilityModSchema = z
  .object({
    kind: z.literal('ability_mod'),
    abilityId: abilityIdRefSchema,
    mods: abilityModsSchema,
  })
  .strict();

/** Tweaks to every effect of a category the player applies. */
const effectModSchema = z
  .object({
    kind: z.literal('effect_mod'),
    category: effectCategorySchema,
    /** Periodic damage of the category (Ignition burns +15%, Virulence +8%). */
    dotDamagePct: z.number().min(-90).max(200).optional(),
    /** Applied duration (Lingering poisons +1.5 s). */
    durationDeltaMs: z.number().int().min(-10000).max(10000).optional(),
    /** Movement magnitude for slow-family categories (Deep Chill −7). */
    moveSpeedDeltaPct: z.number().int().min(-30).max(0).optional(),
    /** Extra mods merged onto the applied effect (Numbing Toxin: poisoned
     * enemies deal −4%). */
    addTargetMods: effectModsSchema.optional(),
  })
  .strict();

/** RMB stance parameter tweaks. */
const stanceModSchema = z
  .object({
    kind: z.literal('stance_mod'),
    /** Block stamina per absorbed hit, percent (Stalwart Block −8%). */
    blockStaminaCostPct: z.number().min(-60).max(0).optional(),
    /** Block mitigation, percentage points (Shield Training +5). */
    blockMitigationDelta: z.number().min(0).max(20).optional(),
    /** Perfect blocks refund flat stamina (Immovable rider). */
    perfectBlockStaminaRefund: z.number().int().min(0).max(25).optional(),
  })
  .strict();

/** Class-passive parameter tweaks. */
const passiveModSchema = z
  .object({
    kind: z.literal('passive_mod'),
    /** Attunement refund +N Mana (Swift Recovery). */
    attunementManaDelta: z.number().int().min(0).max(10).optional(),
    /** Ambusher rear crit bonus, percentage points (Opportunist). */
    ambusherRearCritDelta: z.number().min(0).max(20).optional(),
    /** Finishers refund energy per CP when spending ≥ minCp (Combo Flow). */
    finisherRefund: z
      .object({
        minCp: z.number().int().min(1).max(5),
        energyPerCp: z.number().min(0.5).max(10),
      })
      .optional(),
    /** Poison rules (Plaguebearer). */
    poisonsCanCrit: z.boolean().optional(),
    poisonJumpOnDeath: z.boolean().optional(),
  })
  .strict();

/** Reactive triggers. Each proc kind carries exactly what its handler needs. */
const procSchema = z.discriminatedUnion('proc', [
  z
    .object({
      kind: z.literal('proc'),
      proc: z.literal('low_hp_heal'),
      thresholdPct: z.number().min(5).max(50),
      healPct: z.number().min(5).max(50),
      icdMs: z.number().int().min(10000).max(300000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('proc'),
      proc: z.literal('low_hp_free_cast'),
      thresholdPct: z.number().min(5).max(50),
      abilityId: abilityIdRefSchema,
      icdMs: z.number().int().min(10000).max(300000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('proc'),
      proc: z.literal('on_kill_buff'),
      effectId: z.string().min(1).max(64),
      durationMs: z.number().int().min(1000).max(30000),
      mods: effectModsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('proc'),
      proc: z.literal('resource_spent_stacks'),
      resource: z.enum(['rage', 'mana', 'energy']),
      perSpent: z.number().int().min(10).max(100),
      effectId: z.string().min(1).max(64),
      durationMs: z.number().int().min(1000).max(30000),
      stacksMax: z.number().int().min(1).max(5),
      mods: effectModsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('proc'),
      proc: z.literal('melee_thorns'),
      coef: z.number().min(0.01).max(2),
    })
    .strict(),
  z
    .object({
      kind: z.literal('proc'),
      proc: z.literal('block_thorns'),
      coef: z.number().min(0.01).max(2),
    })
    .strict(),
  z
    .object({
      kind: z.literal('proc'),
      proc: z.literal('melee_attacker_apply'),
      effectId: z.string().min(1).max(64),
      category: effectCategorySchema,
      durationMs: z.number().int().min(500).max(10000),
      mods: effectModsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('proc'),
      proc: z.literal('on_self_heal_buff'),
      effectId: z.string().min(1).max(64),
      durationMs: z.number().int().min(500).max(10000),
      inCombatOnly: z.boolean().default(true),
      mods: effectModsSchema,
    })
    .strict(),
]);

const nodeStatEffectSchema = z
  .object({
    kind: z.literal('stat'),
    mods: nodeStatModsSchema,
  })
  .strict();

export const nodeEffectSchema = z.discriminatedUnion('kind', [
  nodeStatEffectSchema,
  conditionalDamageSchema,
  abilityModSchema,
  effectModSchema,
  stanceModSchema,
  passiveModSchema,
  // Nested union: 8 proc shapes discriminated on `proc`, all kind: 'proc'.
  procSchema,
]);

export type NodeEffect = z.infer<typeof nodeEffectSchema>;
export type NodeStatMods = z.infer<typeof nodeStatModsSchema>;
export type AbilityMods = z.infer<typeof abilityModsSchema>;
export type NodeProc = z.infer<typeof procSchema>;

// ---------------------------------------------------------------------------
// The node def
// ---------------------------------------------------------------------------

export const skillNodeDefSchema = z
  .object({
    id: nodeIdSchema,
    classId: classIdSchema,
    /** Branch slug from CLASS_BRANCHES[classId]. */
    branch: z.string().min(1).max(32),
    name: z.string().min(1).max(40),
    /** Icon id from the baked icon atlas; empty = auto glyph. */
    icon: z.string().max(64).default(''),
    /** Player-facing template; #{n} slots filled per rank at render. */
    description: z.string().max(300).default(''),
    /** Ladder position 1..5 (thresholds/level gates); capstones sit apart. */
    tier: z.number().int().min(1).max(5),
    /** Capstone rule: 8 in-branch points + level 25 (ignores tier ladder). */
    capstone: z.boolean().default(false),
    /** Display order within the branch column (1..8). */
    order: z.number().int().min(1).max(8),
    maxRanks: z.number().int().min(1).max(3),
    /**
     * ranks[i] = the node's COMPLETE effect list at rank i+1 (cumulative
     * totals, not deltas) — the server applies exactly ranks[currentRank-1].
     */
    ranks: z.array(z.array(nodeEffectSchema).min(1).max(8)).min(1).max(3),
  })
  .strict()
  .superRefine((def, ctx) => {
    if (def.ranks.length !== def.maxRanks) {
      ctx.addIssue({
        code: 'custom',
        message: `ranks has ${def.ranks.length} entries but maxRanks is ${def.maxRanks}`,
      });
    }
    const branches = CLASS_BRANCHES[def.classId];
    if (!branches.some((branch) => branch.id === def.branch)) {
      ctx.addIssue({
        code: 'custom',
        message: `branch ${def.branch} is not a ${def.classId} branch (${branches
          .map((branch) => branch.id)
          .join('/')})`,
      });
    }
    if (def.capstone && def.maxRanks !== 1) {
      ctx.addIssue({ code: 'custom', message: 'capstones are single-rank' });
    }
    if (def.capstone && def.tier !== 5) {
      ctx.addIssue({
        code: 'custom',
        message: 'capstones sit at tier 5 (their gate is the 8-point + L25 rule)',
      });
    }
  });

export type SkillNodeDef = z.infer<typeof skillNodeDefSchema>;

/** Parse + throw with the row id in the message (boot/publish validation). */
export const validateSkillNodeDef = (raw: unknown): SkillNodeDef => {
  const result = skillNodeDefSchema.safeParse(raw);
  if (!result.success) {
    const id = typeof raw === 'object' && raw !== null && 'id' in raw ? String(raw.id) : '<no id>';
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`skill node def ${id} invalid: ${issues}`);
  }
  return result.data;
};

// ---------------------------------------------------------------------------
// Allocation rules (both sides run these — clicks predict, server decides)
// ---------------------------------------------------------------------------

/** A character's allocated ranks by node id (from `character_skills`). */
export type NodeRanks = ReadonlyMap<string, number>;

/** Total points spent inside one branch. */
export const branchPointsSpent = (
  ranks: NodeRanks,
  defsById: ReadonlyMap<string, SkillNodeDef>,
  classId: ClassId,
  branch: string,
): number => {
  let total = 0;
  for (const [nodeId, rank] of ranks) {
    const def = defsById.get(nodeId);
    if (def && def.classId === classId && def.branch === branch) total += rank;
  }
  return total;
};

export interface NodeGate {
  unlocked: boolean;
  /** Points still missing in-branch (0 when satisfied). */
  pointsMissing: number;
  /** Level still missing (0 when satisfied). */
  levelMissing: number;
}

/**
 * Tier gate (§3): investment threshold OR level gate — whichever is LATER —
 * both must be satisfied. Capstones use the 8-point + level-25 rule instead.
 */
export const nodeGate = (def: SkillNodeDef, level: number, branchPoints: number): NodeGate => {
  const needPoints = def.capstone ? CAPSTONE_POINTS_REQUIRED : TIER_POINT_THRESHOLDS[def.tier - 1]!;
  const needLevel = def.capstone ? CAPSTONE_LEVEL_GATE : TIER_LEVEL_GATES[def.tier - 1]!;
  const pointsMissing = Math.max(0, needPoints - branchPoints);
  const levelMissing = Math.max(0, needLevel - level);
  return { unlocked: pointsMissing === 0 && levelMissing === 0, pointsMissing, levelMissing };
};

export type AllocateRefusal = 'unknown_node' | 'maxed' | 'no_points' | 'locked';

/**
 * May one more rank go into `nodeId` right now? The client runs this before
 * sending; the server re-runs it as the authority. Divergence self-heals via
 * ProgressSync.
 */
export const canAllocateNode = (
  defsById: ReadonlyMap<string, SkillNodeDef>,
  ranks: NodeRanks,
  nodeId: string,
  level: number,
  unspentSkillPoints: number,
): { ok: true; def: SkillNodeDef } | { ok: false; reason: AllocateRefusal } => {
  const def = defsById.get(nodeId);
  if (!def) return { ok: false, reason: 'unknown_node' };
  const current = ranks.get(nodeId) ?? 0;
  if (current >= def.maxRanks) return { ok: false, reason: 'maxed' };
  if (unspentSkillPoints < 1) return { ok: false, reason: 'no_points' };
  const points = branchPointsSpent(ranks, defsById, def.classId, def.branch);
  if (!nodeGate(def, level, points).unlocked) return { ok: false, reason: 'locked' };
  return { ok: true, def };
};

// ---------------------------------------------------------------------------
// Aggregation — what a character's allocated tree amounts to at runtime
// ---------------------------------------------------------------------------

export interface NodeAggregates {
  /** Summed sheet scalars across all allocated nodes. */
  stats: Required<{ [K in keyof NodeStatMods]-?: number }>;
  conditionals: z.infer<typeof conditionalDamageSchema>[];
  /** Ability id → the mod lists to fold into its def/commit/resolve. */
  abilityMods: ReadonlyMap<string, AbilityMods[]>;
  effectMods: z.infer<typeof effectModSchema>[];
  stance: {
    blockStaminaCostPct: number;
    blockMitigationDelta: number;
    perfectBlockStaminaRefund: number;
  };
  passives: {
    attunementManaDelta: number;
    ambusherRearCritDelta: number;
    finisherRefund: { minCp: number; energyPerCp: number } | null;
    poisonsCanCrit: boolean;
    poisonJumpOnDeath: boolean;
  };
  procs: NodeProc[];
}

const EMPTY_STATS: NodeAggregates['stats'] = {
  maxHpPct: 0,
  armorPct: 0,
  maxManaPct: 0,
  manaRegenPct: 0,
  maxEnergyDelta: 0,
  energyRegenDelta: 0,
  critPct: 0,
  spellCritPct: 0,
  physicalDamagePct: 0,
  magicDamagePct: 0,
  damageTakenPct: 0,
  healingDonePct: 0,
  moveSpeedPct: 0,
  dodgeStaminaCostDelta: 0,
  sprintStaminaPerSDelta: 0,
  ccOnYouDurationPct: 0,
  ccDealtDurationDeltaMs: 0,
  rageOnBasicHitDelta: 0,
  rageWhenHitDelta: 0,
};

/**
 * Fold a character's allocated ranks into one consumable bundle. Pure and
 * deterministic: the server folds on load/allocation, the client folds the
 * same for the sheet preview — identical inputs, identical outputs.
 */
export const aggregateNodeEffects = (
  defsById: ReadonlyMap<string, SkillNodeDef>,
  ranks: NodeRanks,
): NodeAggregates => {
  const stats = { ...EMPTY_STATS };
  const conditionals: NodeAggregates['conditionals'] = [];
  const abilityMods = new Map<string, AbilityMods[]>();
  const effectMods: NodeAggregates['effectMods'] = [];
  const stance = { blockStaminaCostPct: 0, blockMitigationDelta: 0, perfectBlockStaminaRefund: 0 };
  const passives: NodeAggregates['passives'] = {
    attunementManaDelta: 0,
    ambusherRearCritDelta: 0,
    finisherRefund: null,
    poisonsCanCrit: false,
    poisonJumpOnDeath: false,
  };
  const procs: NodeProc[] = [];

  for (const [nodeId, rank] of ranks) {
    const def = defsById.get(nodeId);
    if (!def || rank < 1) continue;
    const effects = def.ranks[Math.min(rank, def.maxRanks) - 1];
    if (!effects) continue;
    for (const effect of effects) {
      switch (effect.kind) {
        case 'stat': {
          for (const [key, value] of Object.entries(effect.mods)) {
            if (typeof value === 'number') {
              stats[key as keyof NodeStatMods] += value;
            }
          }
          break;
        }
        case 'conditional_damage':
          conditionals.push(effect);
          break;
        case 'ability_mod': {
          const list = abilityMods.get(effect.abilityId) ?? [];
          list.push(effect.mods);
          abilityMods.set(effect.abilityId, list);
          break;
        }
        case 'effect_mod':
          effectMods.push(effect);
          break;
        case 'stance_mod':
          stance.blockStaminaCostPct += effect.blockStaminaCostPct ?? 0;
          stance.blockMitigationDelta += effect.blockMitigationDelta ?? 0;
          stance.perfectBlockStaminaRefund += effect.perfectBlockStaminaRefund ?? 0;
          break;
        case 'passive_mod':
          passives.attunementManaDelta += effect.attunementManaDelta ?? 0;
          passives.ambusherRearCritDelta += effect.ambusherRearCritDelta ?? 0;
          if (effect.finisherRefund) passives.finisherRefund = effect.finisherRefund;
          if (effect.poisonsCanCrit) passives.poisonsCanCrit = true;
          if (effect.poisonJumpOnDeath) passives.poisonJumpOnDeath = true;
          break;
        case 'proc':
          procs.push(effect);
          break;
      }
    }
  }
  return { stats, conditionals, abilityMods, effectMods, stance, passives, procs };
};

/** The empty fold (fresh characters, enemies, tests). */
export const emptyNodeAggregates = (): NodeAggregates => aggregateNodeEffects(new Map(), new Map());
