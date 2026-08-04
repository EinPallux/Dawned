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
 * selection"). P4 ships the melee kinds the Grunt archetype uses; ranged/
 * caster kinds are already representable so P9 extends data, not schema.
 */
export const enemyAbilitySchema = z.object({
  id: contentSlug,
  /** Selection weight among currently-valid abilities. */
  weight: z.number().min(0).max(100).default(1),
  cooldownMs: z.number().int().min(0).max(120_000).default(0),
  /** Valid range band from the target, metres. */
  rangeMin: z.number().min(0).max(64).default(0),
  rangeMax: z.number().min(0.5).max(64).default(2.5),
  kind: z.enum(['melee_arc', 'projectile', 'ground_circle']),
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

export type EnemyAbilityDef = z.infer<typeof enemyAbilitySchema>;
export type EnemyDef = z.infer<typeof enemyDefSchema>;

/** Rows must satisfy levelMin ≤ levelMax; zod refinement kept separate for form UX. */
export const validateEnemyDef = (def: EnemyDef): string[] => {
  const problems: string[] = [];
  if (def.levelMin > def.levelMax) problems.push('levelMin must be ≤ levelMax');
  if (def.archetype !== 'dummy' && def.abilities.length === 0) {
    problems.push('non-dummy enemies need at least one ability');
  }
  for (const ability of def.abilities) {
    if (ability.rangeMin > ability.rangeMax) {
      problems.push(`ability ${ability.id}: rangeMin must be ≤ rangeMax`);
    }
  }
  if (def.loot && def.loot.goldMax < def.loot.goldMin) {
    problems.push('loot: goldMax must be ≥ goldMin');
  }
  return problems;
};
