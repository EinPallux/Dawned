/**
 * Enemy content rows — `content_enemies` (docs/tech/DATABASE.md §3,
 * docs/design/NPCS_ENEMIES.md). The game server validates every published row
 * through THIS schema at boot; Dawned-Admin's Enemy Editor (A1) generates its
 * form from it. Stats default from the §5 curve (formulas/stats.ts) — rows
 * override only what a designer deliberately changed.
 */

import { z } from 'zod';

/** Content slugs: `enemy_mushroom_king` style (CLAUDE.md ID rules). */
export const contentSlug = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'lowercase slug (letters, digits, underscore)');

export const enemyArchetypeSchema = z.enum([
  'grunt',
  'ranged',
  'caster',
  'charger',
  'swarm',
  'dummy',
]);
export const enemyRankSchema = z.enum(['normal', 'elite', 'zone_boss', 'world_boss']);

/**
 * One entry in an enemy's weighted attack list (NPCS_ENEMIES.md §2 "attack
 * selection"). P4 shipped the melee kinds the Grunt archetype uses and P5 the
 * projectile volleys; P9 adds the two shapes the remaining archetypes need —
 * the Charger's telegraphed lane and the Caster's self-shield.
 */
export const enemyAbilitySchema = z.object({
  id: contentSlug,
  /** Selection weight among currently-valid abilities. */
  weight: z.number().min(0).max(100).default(1),
  cooldownMs: z.number().int().min(0).max(120_000).default(0),
  /** Valid range band from the target, metres. */
  rangeMin: z.number().min(0).max(64).default(0),
  rangeMax: z.number().min(0.5).max(64).default(2.5),
  kind: z.enum(['melee_arc', 'projectile', 'ground_circle', 'charge_rect', 'self_shield']),
  /** Damage coefficient on the enemy's swing damage. */
  coef: z.number().min(0).max(10).default(1),
  /** Shape parameters (arc reach/angle; projectile speed/radius; circle radius). */
  reach: z.number().min(0.5).max(30).default(2.2),
  angleDeg: z.number().min(10).max(360).default(90),
  projectileSpeed: z.number().min(4).max(60).default(18),
  projectileRadius: z.number().min(0.1).max(2).default(0.3),
  circleRadius: z.number().min(0.5).max(12).default(2.5),
  /** Wind-up before contact, ms. Heavies telegraph; ≥600 ms reads on its own. */
  windupMs: z.number().int().min(100).max(5000).default(500),
  /** Recovery after contact before the next decision, ms. */
  recoverMs: z.number().int().min(0).max(5000).default(600),
  /**
   * Heavy attacks draw the exact server shape as a ground decal for the whole
   * wind-up (COMBAT.md §8); light attacks read via animation only.
   */
  telegraph: z.boolean().default(false),
  /** Anim clip on the enemy rig (bake-verified per model). */
  clip: z.string().min(1).max(64),

  // --- P9 archetype fields -------------------------------------------------
  /**
   * Caster casts (NPCS_ENEMIES.md §1): the wind-up is a visible, INTERRUPTIBLE
   * cast bar rather than a swing telegraph — "the interrupt window is the
   * counterplay". 0 keeps the P4 behaviour (a wind-up nothing can stop).
   *
   * A cast uses `windupMs` for its length like every other wind-up; this flag
   * only decides whether the client shows a bar and whether a stun/interrupt
   * lands on it, so the two can never disagree about timing.
   */
  cast: z.boolean().default(false),
  /**
   * The Charger's lane (`charge_rect`): it lines up, telegraphs a rect, then
   * travels `chargeDistance` at `chargeSpeed`, hitting everything in a lane
   * `chargeWidth` wide. Overshooting leaves it staggered for `overshootMs` —
   * that punish window IS the archetype's counterplay, so it is never 0.
   */
  chargeDistance: z.number().min(2).max(40).default(12),
  chargeWidth: z.number().min(0.6).max(8).default(2.4),
  chargeSpeed: z.number().min(4).max(30).default(14),
  overshootMs: z.number().int().min(200).max(6000).default(1200),
  /** `self_shield`: absorb granted, as a fraction of the caster's own max HP. */
  shieldPct: z.number().min(0).max(100).default(20),
  /**
   * Only selectable at or below this fraction of max HP — the §2 `hpThreshold`
   * condition. 100 = always available (the common case); a boss's desperation
   * ability sits at 35, a self-shield at 60 so it fires when it matters.
   */
  hpThresholdPct: z.number().min(1).max(100).default(100),
  /** Once per life: self-shields and boss openers must not loop. */
  oncePerLife: z.boolean().default(false),
  /**
   * Boss phase gate: this ability only unlocks from the numbered phase on
   * (0 = available from the start). Phases are declared on the enemy def.
   */
  phase: z.number().int().min(0).max(4).default(0),
});

/**
 * A boss phase (NPCS_ENEMIES.md §1: "phase at 50% HP (+1 ability or
 * modifier)"). Crossing `atHpPct` downward moves the fight to the next phase
 * — one way, so healing back over the line cannot re-trigger the announce.
 */
export const bossPhaseSchema = z.object({
  /** Fraction of max HP at which this phase begins. */
  atHpPct: z.number().min(1).max(99),
  /** Multipliers that apply from this phase on. */
  damageMult: z.number().min(0.25).max(4).default(1),
  speedMult: z.number().min(0.25).max(4).default(1),
  /** Attack-rate scalar: <1 shortens recovery between abilities. */
  recoverMult: z.number().min(0.2).max(4).default(1),
  /** Shown as the boss's line when the phase starts (empty = silent). */
  announce: z.string().max(80).default(''),
});

export const enemyDefSchema = z.object({
  id: contentSlug,
  name: z.string().min(2).max(40),
  archetype: enemyArchetypeSchema,
  rank: enemyRankSchema.default('normal'),
  levelMin: z.number().int().min(1).max(30),
  levelMax: z.number().int().min(1).max(30),
  /** Baked model id in the asset manifest (e.g. `enemies_glub`). */
  modelRef: z.string().min(1).max(64),
  scale: z.number().min(0.2).max(3).default(1),
  /** Hit capsule. Defaults suit the small Quaternius critters. */
  hitRadius: z.number().min(0.2).max(3).default(0.5),
  hitHeight: z.number().min(0.4).max(6).default(1.2),
  /** Movement speed in m/s (players jog 5.5). */
  moveSpeed: z.number().min(0.5).max(10).default(3.6),
  /** Stat overrides on the §5 curve; omitted fields use the formula. */
  statOverrides: z
    .object({
      maxHp: z.number().int().min(1).optional(),
      swingDamage: z.number().min(0).optional(),
      armor: z.number().min(0).optional(),
      magicResistPct: z.number().min(0).max(95).optional(),
    })
    .default({}),
  abilities: z.array(enemyAbilitySchema).min(0).max(8),
  aggroRadius: z.number().min(2).max(40).default(10),
  leashRadius: z.number().min(10).max(120).default(40),
  /**
   * Boss phases, lowest-HP-last is NOT required — they are sorted by threshold
   * descending at load. Empty for everything that is not a boss; a `rank` of
   * zone_boss/world_boss with no phases is legal but flagged by the editor,
   * since "phase at 50%" is what makes a boss fight a fight (§1).
   */
  phases: z.array(bossPhaseSchema).max(4).default([]),
  /**
   * Arena leash: a boss never leaves this radius from its spawn, whatever the
   * threat table says. 0 = use `leashRadius` like every other enemy.
   */
  arenaRadius: z.number().min(0).max(120).default(0),
  /** Camp tag for social aggro (NPCS_ENEMIES.md §2); null = loner. */
  socialTag: z.string().max(40).nullable().default(null),
  xpMult: z.number().min(0).max(10).default(1),
  /**
   * What this type pays out on death (P8, ITEMS_LOOT.md §4). Null = nothing
   * drops (training dummies). Elites/bosses take extra rolls via `rolls`.
   */
  loot: z
    .object({
      tableId: z
        .string()
        .min(1)
        .max(64)
        .regex(/^loot_[a-z0-9_]+$/, 'loot refs look like loot_<name>'),
      /** Table invocations per kill (§4: usually 1–2, elites +1). */
      rolls: z.number().int().min(0).max(6).default(1),
      goldMin: z.number().int().min(0).max(100000).default(0),
      goldMax: z.number().int().min(0).max(100000).default(0),
    })
    .strict()
    .nullable()
    .default(null),
});

export type BossPhaseDef = z.infer<typeof bossPhaseSchema>;
export type EnemyAbilityDef = z.infer<typeof enemyAbilitySchema>;
export type EnemyDef = z.infer<typeof enemyDefSchema>;

/**
 * Which phase a boss is in at a given HP fraction, and the modifiers that
 * apply there. Phase 0 is the opening state with no modifiers; phase N is the
 * Nth declared threshold, counting down.
 *
 * Phases never step BACK: the caller passes the phase already reached, so
 * healing above a threshold (a Cleric add, an absorb) cannot replay an
 * announce or undo a speed-up mid-fight.
 */
export interface BossPhaseState {
  index: number;
  damageMult: number;
  speedMult: number;
  recoverMult: number;
  announce: string;
}

export const NEUTRAL_PHASE: BossPhaseState = {
  index: 0,
  damageMult: 1,
  speedMult: 1,
  recoverMult: 1,
  announce: '',
};

/** Phases sorted the way the fight walks them: highest threshold first. */
export const orderedPhases = (def: Pick<EnemyDef, 'phases'>): readonly BossPhaseDef[] =>
  [...def.phases].sort((a, b) => b.atHpPct - a.atHpPct);

/**
 * The phase for `hpFraction` (0..1), never below `reachedIndex`. Returns the
 * folded modifiers so a caller applies one object, not a loop.
 */
export const bossPhaseAt = (
  def: Pick<EnemyDef, 'phases'>,
  hpFraction: number,
  reachedIndex = 0,
): BossPhaseState => {
  const ordered = orderedPhases(def);
  let index = reachedIndex;
  for (let i = 0; i < ordered.length; i++) {
    if (hpFraction * 100 <= ordered[i]!.atHpPct) index = Math.max(index, i + 1);
  }
  if (index <= 0) return NEUTRAL_PHASE;
  const phase = ordered[index - 1]!;
  return {
    index,
    damageMult: phase.damageMult,
    speedMult: phase.speedMult,
    recoverMult: phase.recoverMult,
    announce: phase.announce,
  };
};

/** Everything that can stop an enemy ability from being chosen right now. */
export interface EnemyAbilityContext {
  /** Distance to the target, metres. */
  distance: number;
  /** The enemy's own HP as a fraction 0..1. */
  hpFraction: number;
  /** Phase index reached (0 for everything that is not a boss). */
  phase: number;
  /** True while the ability is still on cooldown. */
  onCooldown: (abilityId: string) => boolean;
  /** True once a `oncePerLife` ability has been used this life. */
  spent: (abilityId: string) => boolean;
}

/**
 * The abilities an enemy could use right now, in row order.
 *
 * THE selection gate, shared on purpose: the server picks from this list and
 * the panel's TTK calculator previews from the very same one, so an editor can
 * never be shown a rotation the game will not actually play (the same
 * anti-drift rule the movement step and the damage formula follow).
 */
export const selectableEnemyAbilities = (
  abilities: readonly EnemyAbilityDef[],
  ctx: EnemyAbilityContext,
): readonly EnemyAbilityDef[] =>
  abilities.filter(
    (ability) =>
      ability.phase <= ctx.phase &&
      ctx.distance >= ability.rangeMin &&
      ctx.distance <= ability.rangeMax &&
      ctx.hpFraction * 100 <= ability.hpThresholdPct &&
      !ctx.onCooldown(ability.id) &&
      !(ability.oncePerLife && ctx.spent(ability.id)),
  );

/**
 * Weighted pick over an already-filtered list. Deterministic for a given roll
 * in 0..1, which is what lets the panel simulate a rotation reproducibly.
 */
export const pickEnemyAbility = (
  ready: readonly EnemyAbilityDef[],
  roll: number,
): EnemyAbilityDef | null => {
  if (ready.length === 0) return null;
  let total = 0;
  for (const ability of ready) total += ability.weight;
  if (total <= 0) return ready[0]!;
  let cursor = roll * total;
  for (const ability of ready) {
    cursor -= ability.weight;
    if (cursor <= 0) return ability;
  }
  return ready[ready.length - 1]!;
};

/** Rows must satisfy levelMin ≤ levelMax; zod refinement kept separate for form UX. */
export const validateEnemyDef = (def: EnemyDef): string[] => {
  const problems: string[] = [];
  if (def.levelMin > def.levelMax) problems.push('levelMin must be ≤ levelMax');
  if (def.archetype !== 'dummy' && def.abilities.length === 0) {
    problems.push('non-dummy enemies need at least one ability');
  }
  const seen = new Set<string>();
  for (const ability of def.abilities) {
    if (ability.rangeMin > ability.rangeMax) {
      problems.push(`ability ${ability.id}: rangeMin must be ≤ rangeMax`);
    }
    // Ids key cooldowns and once-per-life state at runtime; duplicates would
    // silently share both and make a rotation unplayable.
    if (seen.has(ability.id)) problems.push(`ability ${ability.id}: duplicate id`);
    seen.add(ability.id);
    // A charge must be able to overshoot its target, or the punish window the
    // archetype is built around never opens (§1).
    if (ability.kind === 'charge_rect' && ability.chargeDistance <= ability.rangeMax) {
      problems.push(
        `ability ${ability.id}: chargeDistance must exceed rangeMax so the charge overshoots`,
      );
    }
    // Casts are the Caster's counterplay; a cast nobody can react to is a lie.
    if (ability.cast && ability.windupMs < 800) {
      problems.push(`ability ${ability.id}: a cast needs windupMs ≥ 800 to be interruptible`);
    }
    if (ability.kind === 'self_shield' && ability.shieldPct <= 0) {
      problems.push(`ability ${ability.id}: self_shield needs shieldPct > 0`);
    }
    if (ability.phase > def.phases.length) {
      problems.push(
        `ability ${ability.id}: gated behind phase ${ability.phase}, but only ` +
          `${def.phases.length} phase(s) are declared — it could never fire`,
      );
    }
  }
  const thresholds = def.phases.map((phase) => phase.atHpPct);
  if (new Set(thresholds).size !== thresholds.length) {
    problems.push('phases: two phases share an atHpPct threshold');
  }
  if (def.phases.length > 0 && def.rank !== 'zone_boss' && def.rank !== 'world_boss') {
    problems.push('phases are a boss feature — set rank to zone_boss or world_boss');
  }
  if (def.loot && def.loot.goldMax < def.loot.goldMin) {
    problems.push('loot: goldMax must be ≥ goldMin');
  }
  return problems;
};
