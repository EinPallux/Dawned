/**
 * Ability content schema (COMBAT.md §4, CLASSES.md) — the data contract of the
 * class kits. Rows live in `content_abilities` (PK (id, status), def jsonb,
 * same pattern as enemies), are authored in Dawned-Admin, validated here at
 * every boundary (editor save, publish, server boot), and interpreted by ONE
 * executor: the shared ability machine (timing/validation) + the server
 * effect appliers. Nothing about a kit is hardcoded — a coefficient, a cone
 * angle, an animation clip are all one panel edit away.
 *
 * The schema is a SUPERSET of what P5 ships (Warrior/Rogue): mana costs,
 * casts/channels, heals/shields and ally targeting are already expressible so
 * the Mage/Cleric kits (P6) are data-only additions, not schema churn.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** Content ids: slugs like `ability_warrior_crushing_blow`. */
const abilityIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^ability_[a-z0-9_]+$/, 'ability ids look like ability_<class>_<name>');

/**
 * Status categories (P6, COMBAT.md §6.4): the handle for cleanse filters,
 * CC diminishing returns (stun/root/slow share DR within their category) and
 * conditional damage (Ice Lance vs chilled). `chill` IS a slow for DR/cleanse
 * purposes but keeps its own tag for kit synergies.
 */
export const effectCategorySchema = z.enum([
  'stun',
  'root',
  'slow',
  'chill',
  'burn',
  'poison',
  'bleed',
  'buff',
]);
export type EffectCategory = z.infer<typeof effectCategorySchema>;

/** Categories the CC diminishing-returns tracker cares about (players). */
export const CC_DR_CATEGORIES = ['stun', 'root', 'slow'] as const;

/** What "cleanse movement impairment" strips (Blink breaks roots/slows). */
export const MOVEMENT_CATEGORIES: readonly EffectCategory[] = ['root', 'slow', 'chill'];

/** Mirrors the canonical ClassId union (data/appearance.ts) for zod parsing. */
export const classIdSchema = z.enum(['warrior', 'mage', 'rogue', 'cleric']);

/**
 * Where an ability lives on the character:
 * - `slot`   — hotbar 1..8 (8 = ultimate; unlock levels per CLASSES.md).
 * - `basic`  — a step of the LMB combo chain (migrated from shared data, P4).
 * - `rmb`    — the held class action (Block / Evasive Stance / Focus-Aim).
 */
const bindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slot'), slot: z.number().int().min(1).max(8) }),
  z.object({ kind: z.literal('basic'), step: z.number().int().min(1).max(3) }),
  z.object({ kind: z.literal('rmb') }),
]);

/** Resource costs. Amounts are integers (project rule: no float currencies). */
const costSchema = z.object({
  type: z.enum(['rage', 'mana', 'energy', 'stamina', 'none']),
  amount: z.number().int().min(0).default(0),
});

/**
 * Hit geometry / target acquisition (COMBAT.md §5). The SERVER resolves these
 * against rewound positions; telegraphs and client previews draw the exact
 * same numbers.
 */
const targetingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self') }),
  z.object({
    kind: z.literal('melee_arc'),
    angleDeg: z.number().min(10).max(360),
    reach: z.number().min(0.5).max(12),
    maxTargets: z.number().int().min(1).max(20).default(5),
  }),
  z.object({
    kind: z.literal('cone'),
    angleDeg: z.number().min(10).max(360),
    reach: z.number().min(1).max(30),
    maxTargets: z.number().int().min(1).max(20).default(10),
    /** Cosmetic projectile fan (Fan of Knives) — hit test stays the cone. */
    visual: z.enum(['sweep', 'knives']).default('sweep'),
  }),
  z.object({
    kind: z.literal('pbaoe'),
    radius: z.number().min(1).max(20),
    /** Repeated pulses (Whirlwind ×2). Single burst = count 1. */
    ticks: z
      .object({ count: z.number().int().min(1).max(10), everyMs: z.number().int().min(100) })
      .default({ count: 1, everyMs: 500 }),
    maxTargets: z.number().int().min(1).max(20).default(10),
  }),
  z.object({
    kind: z.literal('projectile'),
    speed: z.number().min(5).max(80),
    radius: z.number().min(0.05).max(2),
    maxRange: z.number().min(3).max(60),
    pierce: z.boolean().default(false),
    /** Curve toward the press-time soft-target (Arcane Barrage bolts). */
    homing: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('dash'),
    /** Forward rush along aim (Charge): capsule sweep, impact on contact. */
    distance: z.number().min(2).max(20),
    speed: z.number().min(8).max(40),
    stopOnHit: z.boolean().default(true),
  }),
  z.object({
    /** Shadowstep: teleport behind the soft-target (fallback: aim, capped). */
    kind: z.literal('blink_behind'),
    maxRange: z.number().min(3).max(20),
  }),
  z.object({
    kind: z.literal('single'),
    maxRange: z.number().min(2).max(30),
  }),
  z.object({
    kind: z.literal('ally_soft'),
    range: z.number().min(3).max(40),
    fallbackSelf: z.boolean().default(true),
  }),
  z.object({
    /**
     * Ground-target circle at the crosshair's terrain point, range-clamped
     * (Meteor, Sanctuary). telegraphMs > 0 shows the decal and delays the
     * resolve (dodgeable); 0 resolves at contact like any instant.
     */
    kind: z.literal('ground_aoe'),
    radius: z.number().min(1).max(12),
    maxRange: z.number().min(5).max(40),
    telegraphMs: z.number().int().min(0).max(4000).default(0),
    maxTargets: z.number().int().min(1).max(20).default(10),
  }),
  z.object({
    /** Forward teleport along aim (Mage Blink) — walkability decides landing. */
    kind: z.literal('teleport'),
    distance: z.number().min(3).max(20),
  }),
]);

/**
 * Stat/behavior modifiers a buff or debuff can carry. All percentages are
 * SIGNED integers (−50 = half damage taken; +10 = 10% faster). Periodic
 * damage/heal rides the same envelope (bleeds, poisons, HoTs).
 */
const effectModsSchema = z
  .object({
    damageDealtPct: z.number().int().min(-90).max(200).optional(),
    damageTakenPct: z.number().int().min(-90).max(200).optional(),
    moveSpeedPct: z.number().int().min(-90).max(100).optional(),
    armorPct: z.number().int().min(-90).max(200).optional(),
    critPct: z.number().int().min(-50).max(100).optional(),
    knockbackImmune: z.boolean().optional(),
    /** Consumed by the caster's next damaging ability (Shadowstep/Smoke Veil). */
    nextAttackPct: z.number().int().min(0).max(200).optional(),
    /** Rogue Evasive-style: flat dodge stamina discount while active. */
    dodgeCostDelta: z.number().int().min(-25).max(0).optional(),
    /** Threat wipe-lite (Smoke Veil): AI retargets away for the duration. */
    threatDrop: z.boolean().optional(),
    /** AI drops target + soft-target skips the bearer (Blink's 0.3 s). */
    untargetable: z.boolean().optional(),
    /**
     * Mana Shield: incoming damage drains Mana at this rate per point instead
     * of HP, until Mana runs out (or the buff is recast/expires).
     */
    manaShieldPerPoint: z.number().min(0.5).max(10).optional(),
    /** Periodic damage/heal: total coefficient spread across the duration. */
    periodic: z
      .object({
        kind: z.enum(['damage', 'heal']),
        coefTotal: z.number().min(0).max(10),
        school: z.enum(['physical', 'magic']).default('physical'),
        tickEveryMs: z.number().int().min(250),
      })
      .optional(),
    /** Attacks apply this debuff to victims while the buff runs (Poisoned Blades). */
    onHitApply: z
      .object({
        effectId: z.string().min(1).max(64),
        durationMs: z.number().int().min(500),
        stacksMax: z.number().int().min(1).max(10).default(1),
        periodic: z.object({
          kind: z.literal('damage'),
          coefTotal: z.number().min(0).max(10),
          school: z.enum(['physical', 'magic']).default('physical'),
          tickEveryMs: z.number().int().min(250),
        }),
      })
      .optional(),
  })
  .strict();

/**
 * What happens at resolve. Ordered list; the server applies them in order to
 * every resolved target (or self, per `target`).
 */
const effectSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('damage'),
    coef: z.number().min(0).max(10),
    school: z.enum(['physical', 'magic']).default('physical'),
    /** Independent hit rolls per target (Twin Strike ×2). */
    hits: z.number().int().min(1).max(5).default(1),
    /** Extra stagger beyond the damage-derived gain (Crushing Blow +20). */
    staggerBonus: z.number().int().min(0).max(100).default(0),
    /** Finisher scaling: adds coef × combo points SPENT (Eviscerate). */
    coefPerComboPoint: z.number().min(0).max(3).default(0),
    /** Conditional bonus vs targets bearing a category (Ice Lance +50% vs chilled/rooted). */
    bonusVs: z
      .object({
        categories: z.array(effectCategorySchema).min(1).max(4),
        pct: z.number().int().min(5).max(200),
      })
      .optional(),
  }),
  z.object({ kind: z.literal('stun'), durationMs: z.number().int().min(200).max(4000) }),
  z.object({ kind: z.literal('knockdown'), durationMs: z.number().int().min(500).max(4000) }),
  z.object({
    /** Pin in place (movement zeroed, turning free) — Frost Nova. */
    kind: z.literal('root'),
    durationMs: z.number().int().min(500).max(6000),
  }),
  z.object({ kind: z.literal('interrupt') }),
  z.object({
    /**
     * Strip effects from the target (Purify 1 debuff; Blink's movement break;
     * Dawnlight all). `category: movement` = root/slow/chill only.
     */
    kind: z.literal('cleanse'),
    category: z.enum(['any', 'movement']).default('any'),
    count: z.number().int().min(1).max(10).default(1),
    all: z.boolean().default(false),
  }),
  z.object({
    /** Reset matching DoT durations on hit targets (Ember Wave refreshes burns). */
    kind: z.literal('refresh'),
    category: effectCategorySchema,
  }),
  z.object({
    /**
     * Persistent ground zone at the resolve point (Sanctuary): ticks its
     * effect on everyone of `team` inside. Requires ground_aoe targeting.
     */
    kind: z.literal('zone'),
    radius: z.number().min(1).max(12),
    durationMs: z.number().int().min(1000).max(20000),
    tickEveryMs: z.number().int().min(250),
    team: z.enum(['allies', 'enemies']),
    tick: z.object({
      kind: z.enum(['heal', 'damage']),
      coef: z.number().min(0).max(3),
      school: z.enum(['physical', 'magic']).default('magic'),
    }),
  }),
  z.object({
    kind: z.literal('taunt'),
    durationMs: z.number().int().min(1000).max(8000),
  }),
  z.object({
    kind: z.literal('resource'),
    resource: z.enum(['rage', 'mana', 'energy', 'stamina']),
    amount: z.number().int().min(-100).max(100),
    /** Grant combo points alongside (Twin Strike +1 CP). */
    comboPoints: z.number().int().min(0).max(5).default(0),
  }),
  z.object({
    kind: z.literal('apply_effect'),
    /** Buff on self or debuff on every hit target. */
    target: z.enum(['self', 'hit']),
    effectId: z.string().min(1).max(64),
    durationMs: z.number().int().min(500).max(60000),
    stacksMax: z.number().int().min(1).max(10).default(1),
    /** Status family — drives cleanse filters, CC DR and bonusVs checks. */
    category: effectCategorySchema.default('buff'),
    mods: effectModsSchema.default({}),
  }),
  z.object({
    kind: z.literal('mark'),
    durationMs: z.number().int().min(1000).max(20000),
    /** Extra damage taken FROM THE CASTER only (Death Mark +20%). */
    damageFromCasterPct: z.number().int().min(0).max(100),
    /** Rider when a marked target dies. */
    onKill: z
      .object({
        energy: z.number().int().min(0).max(100).default(0),
        resetCooldownOf: abilityIdSchema.optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal('heal'),
    coef: z.number().min(0).max(10),
  }),
  z.object({
    kind: z.literal('shield'),
    coef: z.number().min(0).max(10),
    durationMs: z.number().int().min(1000).max(30000),
  }),
]);

// ---------------------------------------------------------------------------
// The ability def
// ---------------------------------------------------------------------------

export const abilityDefSchema = z
  .object({
    id: abilityIdSchema,
    classId: classIdSchema,
    binding: bindingSchema,
    name: z.string().min(1).max(40),
    /** Icon id from the baked icon atlas (P5-D); empty = auto glyph. */
    icon: z.string().max(64).default(''),
    /** Player-facing template; #{n} slots filled from numbers at render. */
    description: z.string().max(300).default(''),
    unlockLevel: z.number().int().min(1).max(30).default(1),

    cost: costSchema.default({ type: 'none', amount: 0 }),
    /** Combo points: generated on use/hit, or spent as a finisher. */
    comboPointGain: z.number().int().min(0).max(5).default(0),
    comboFinisher: z.boolean().default(false),

    cooldownMs: z.number().int().min(0).max(300000).default(0),
    /** Participates in the global cooldown (COMBAT.md §4: default 400 ms). */
    onGcd: z.boolean().default(true),
    charges: z.number().int().min(1).max(3).default(1),

    castMs: z.number().int().min(0).max(10000).default(0),
    channel: z
      .object({
        durationMs: z.number().int().min(500).max(10000),
        tickEveryMs: z.number().int().min(200),
      })
      .nullable()
      .default(null),
    /** true = free movement; number = speed multiplier while casting. */
    castWhileMoving: z.union([z.boolean(), z.number().min(0.1).max(1)]).default(true),

    targeting: targetingSchema,
    effects: z.array(effectSchema).min(1).max(8),

    anim: z.object({
      /** UAL clip name (baked); dual-wield retargets share the name. */
      clip: z.string().min(1).max(64),
      /** Native clip length (s) — timeScale = clipSeconds / durationS. */
      clipSeconds: z.number().min(0.1).max(5),
      /** Swing time for instants; casts use castMs and this for the release. */
      durationMs: z.number().int().min(150).max(5000),
      /** When inside the swing the hit resolves (0..1 of durationMs). */
      contactFraction: z.number().min(0).max(1).default(0.55),
      /** Movement lock while swinging (0 = move freely, COMBAT.md §1). */
      moveLockMs: z.number().int().min(0).max(3000).default(0),
      moveSpeedMult: z.number().min(0.1).max(1).default(1),
    }),
    /** VFX/SFX slot ids (temp-synth SFX until P14; pooled VFX at P5-D). */
    vfx: z.string().max(64).default(''),
    sfx: z.string().max(64).default(''),

    threatMult: z.number().min(0).max(5).default(1),
  })
  .strict()
  .superRefine((def, ctx) => {
    // Cross-field sanity the type system can't see. Fail at author time, loud.
    if (def.comboFinisher && def.classId !== 'rogue') {
      ctx.addIssue({ code: 'custom', message: 'combo finishers are Rogue-only (CP resource)' });
    }
    if (def.comboPointGain > 0 && def.classId !== 'rogue') {
      ctx.addIssue({ code: 'custom', message: 'combo point generation is Rogue-only' });
    }
    if (def.cost.type === 'rage' && def.classId !== 'warrior') {
      ctx.addIssue({ code: 'custom', message: 'rage costs are Warrior-only' });
    }
    if (def.cost.type === 'energy' && def.classId !== 'rogue') {
      ctx.addIssue({ code: 'custom', message: 'energy costs are Rogue-only' });
    }
    if (def.cost.type === 'mana' && def.classId !== 'mage' && def.classId !== 'cleric') {
      ctx.addIssue({ code: 'custom', message: 'mana costs are Mage/Cleric-only' });
    }
    if (
      def.effects.some((effect) => effect.kind === 'zone') &&
      def.targeting.kind !== 'ground_aoe'
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'zone effects need ground_aoe targeting (the zone spawns at the ground point)',
      });
    }
    if (def.channel !== null && def.castMs > 0) {
      ctx.addIssue({ code: 'custom', message: 'an ability is a cast OR a channel, not both' });
    }
    if (def.binding.kind === 'basic' && (def.cooldownMs > 0 || def.cost.amount > 0)) {
      ctx.addIssue({
        code: 'custom',
        message: 'basics are never resource-gated or cooldown-gated (COMBAT.md §3)',
      });
    }
    const hasFinisherCoef = def.effects.some(
      (effect) => effect.kind === 'damage' && effect.coefPerComboPoint > 0,
    );
    if (hasFinisherCoef && !def.comboFinisher) {
      ctx.addIssue({
        code: 'custom',
        message: 'coefPerComboPoint needs comboFinisher: true (it scales with CP spent)',
      });
    }
  });

export type AbilityDef = z.infer<typeof abilityDefSchema>;
export type AbilityTargeting = z.infer<typeof targetingSchema>;
export type AbilityEffect = z.infer<typeof effectSchema>;
export type AbilityEffectMods = z.infer<typeof effectModsSchema>;

/** Parse + throw with the row id in the message (boot/publish validation). */
export const validateAbilityDef = (raw: unknown): AbilityDef => {
  const result = abilityDefSchema.safeParse(raw);
  if (!result.success) {
    const id = typeof raw === 'object' && raw !== null && 'id' in raw ? String(raw.id) : '<no id>';
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`ability def ${id} invalid: ${issues}`);
  }
  return result.data;
};
