/**
 * Buff/debuff runtime (P5, COMBAT.md §4 effects): live effect instances on
 * players and enemies — stat modifiers, periodic damage (bleeds/poisons),
 * marks, next-attack riders. Content declares them (AbilityEffectMods); this
 * module owns stacking, expiry, ticking and the aggregate multipliers the
 * damage/movement paths read.
 *
 * Design: tiny arrays per entity (a fight carries 1–5 effects), scanned
 * linearly; aggregates recomputed on read (cheap at our scale, zero cache
 * invalidation bugs).
 */

import {
  MOVEMENT_CATEGORIES,
  armorMitigation,
  levelModifier,
  type AbilityDef,
  type AbilityEffectMods,
  type EffectCategory,
} from '@dawned/shared';

/** Synced self-effect id: Archmage's next-cast-instant window (P7). */
export const ARCANE_SURGE_EFFECT = 'arcane_surge';
/** Synced self-effect id: Flurry's empowered-basics window (P7). */
export const FLURRY_EFFECT = 'flurry';

export interface ActiveEffect {
  effectId: string;
  /** Who applied it (marks scope their bonus to this caster; DoT credit). */
  casterId: number;
  stacks: number;
  stacksMax: number;
  expiresAtMs: number;
  durationMs: number;
  mods: AbilityEffectMods;
  /** Next periodic tick, 0 = no periodic component. */
  nextTickAtMs: number;
  /** Damage each periodic tick deals PER STACK (precomputed at apply). */
  tickDamage: number;
  /** Heal each periodic tick restores PER STACK (HoTs — Sanctuary/Overflow). */
  tickHeal: number;
  tickSchool: 'physical' | 'magic';
  harmful: boolean;
  /** Status family (P6): cleanse filters, DR lanes, bonusVs checks. */
  category: EffectCategory;
  /** Absorb pool remaining (P6 shields, Aegis) — 0 = not a shield. */
  shieldPool: number;
  /** Mark rider: extra % damage taken from casterId only. */
  markPct: number;
  onKillEnergy: number;
  onKillResetAbility: string | null;
}

export interface EffectHost {
  effects: ActiveEffect[];
  /** Set when the list changes — gateway flushes EffectSync to viewers. */
  effectsDirty: boolean;
}

export interface ApplyEffectInput {
  effectId: string;
  casterId: number;
  durationMs: number;
  stacksMax: number;
  mods: AbilityEffectMods;
  harmful: boolean;
  /** Precomputed damage per periodic tick per stack (0 = none). */
  tickDamage?: number | undefined;
  /** Precomputed heal per periodic tick per stack (0 = none). */
  tickHeal?: number | undefined;
  tickSchool?: 'physical' | 'magic' | undefined;
  tickEveryMs?: number | undefined;
  category?: EffectCategory | undefined;
  /** Absorb pool for shield effects (recast replaces the pool). */
  shieldPool?: number | undefined;
  markPct?: number | undefined;
  onKillEnergy?: number | undefined;
  onKillResetAbility?: string | null | undefined;
}

/**
 * Apply or stack an effect. Same effectId FROM THE SAME CASTER stacks up to
 * stacksMax and refreshes the duration (poison model); different casters keep
 * separate instances (two rogues' poisons both tick). Reapplied shields
 * REPLACE their pool (Aegis recast = fresh absorb, never additive).
 */
export const applyEffect = (host: EffectHost, input: ApplyEffectInput, nowMs: number): void => {
  const existing = host.effects.find(
    (effect) => effect.effectId === input.effectId && effect.casterId === input.casterId,
  );
  if (existing) {
    existing.stacks = Math.min(existing.stacksMax, existing.stacks + 1);
    existing.expiresAtMs = nowMs + input.durationMs;
    if (input.shieldPool !== undefined) existing.shieldPool = input.shieldPool;
    host.effectsDirty = true;
    return;
  }
  host.effects.push({
    effectId: input.effectId,
    casterId: input.casterId,
    stacks: 1,
    stacksMax: input.stacksMax,
    expiresAtMs: nowMs + input.durationMs,
    durationMs: input.durationMs,
    mods: input.mods,
    nextTickAtMs: input.tickEveryMs ? nowMs + input.tickEveryMs : 0,
    tickDamage: input.tickDamage ?? 0,
    tickHeal: input.tickHeal ?? 0,
    tickSchool: input.tickSchool ?? 'physical',
    harmful: input.harmful,
    category: input.category ?? 'buff',
    shieldPool: input.shieldPool ?? 0,
    markPct: input.markPct ?? 0,
    onKillEnergy: input.onKillEnergy ?? 0,
    onKillResetAbility: input.onKillResetAbility ?? null,
  });
  host.effectsDirty = true;
};

export const removeEffect = (host: EffectHost, effectId: string, casterId?: number): void => {
  const before = host.effects.length;
  host.effects = host.effects.filter(
    (effect) =>
      effect.effectId !== effectId || (casterId !== undefined && effect.casterId !== casterId),
  );
  if (host.effects.length !== before) host.effectsDirty = true;
};

export const clearAllEffects = (host: EffectHost): void => {
  if (host.effects.length === 0) return;
  host.effects = [];
  host.effectsDirty = true;
};

export interface PeriodicTick {
  effect: ActiveEffect;
  /** Damage for this tick (stacks folded in; 0 for heal ticks). */
  damage: number;
  /** Heal for this tick (stacks folded in; 0 for damage ticks). */
  heal: number;
}

/**
 * Advance expiry + collect due periodic ticks (caller runs them through the
 * real damage/heal pipelines so mitigation/threat/death stay in one place).
 */
export const tickEffects = (host: EffectHost, nowMs: number, out: PeriodicTick[]): void => {
  let changed = false;
  for (let i = host.effects.length - 1; i >= 0; i--) {
    const effect = host.effects[i]!;
    if (nowMs >= effect.expiresAtMs) {
      host.effects.splice(i, 1);
      changed = true;
      continue;
    }
    if (effect.nextTickAtMs > 0 && nowMs >= effect.nextTickAtMs) {
      // One tick per frame at most (50 ms sim never falls a full interval behind).
      effect.nextTickAtMs += tickIntervalOf(effect);
      if (effect.tickDamage > 0 || effect.tickHeal > 0) {
        out.push({
          effect,
          damage: effect.tickDamage * effect.stacks,
          heal: effect.tickHeal * effect.stacks,
        });
      }
    }
  }
  if (changed) host.effectsDirty = true;
};

const tickIntervalOf = (effect: ActiveEffect): number => {
  const periodic = effect.mods.periodic ?? effect.mods.onHitApply?.periodic;
  return periodic?.tickEveryMs ?? 1000;
};

// ---------------------------------------------------------------------------
// Aggregates (read by damage/movement paths)
// ---------------------------------------------------------------------------

const pctToMult = (pct: number): number => 1 + pct / 100;

/** Damage this entity DEALS, folded across buffs ×stacks (× Dawned externally). */
export const damageDealtMultOf = (host: EffectHost): number => {
  let mult = 1;
  for (const effect of host.effects) {
    if (effect.mods.damageDealtPct) {
      mult *= pctToMult(effect.mods.damageDealtPct * effect.stacks);
    }
  }
  return mult;
};

/**
 * Damage this entity TAKES from `attackerId` — folds general damageTaken
 * modifiers (×stacks — Winter's Grasp stacks its −5%) plus caster-scoped
 * marks (Death Mark).
 */
export const damageTakenMultOf = (host: EffectHost, attackerId: number): number => {
  let mult = 1;
  for (const effect of host.effects) {
    if (effect.mods.damageTakenPct) {
      mult *= pctToMult(effect.mods.damageTakenPct * effect.stacks);
    }
    if (effect.markPct > 0 && effect.casterId === attackerId) mult *= pctToMult(effect.markPct);
  }
  return mult;
};

export const moveSpeedMultOf = (host: EffectHost): number => {
  let mult = 1;
  for (const effect of host.effects) {
    if (effect.mods.moveSpeedPct) mult *= pctToMult(effect.mods.moveSpeedPct);
  }
  return Math.max(0.1, mult);
};

export const critBonusOf = (host: EffectHost): number => {
  let bonus = 0;
  for (const effect of host.effects) {
    if (effect.mods.critPct) bonus += effect.mods.critPct;
  }
  return bonus;
};

/** Armor multiplier from live effects ×stacks (P7: Colossus, Beacon). */
export const armorMultOf = (host: EffectHost): number => {
  let mult = 1;
  for (const effect of host.effects) {
    if (effect.mods.armorPct) mult *= 1 + (effect.mods.armorPct * effect.stacks) / 100;
  }
  return Math.max(0, mult);
};

/** Basic-swing speed multiplier (P7: Killer's Rhythm, Flurry). */
export const attackSpeedMultOf = (host: EffectHost): number => {
  let mult = 1;
  for (const effect of host.effects) {
    if (effect.mods.attackSpeedPct) mult *= 1 + effect.mods.attackSpeedPct / 100;
  }
  return Math.max(0.25, mult);
};

export const isKnockbackImmune = (host: EffectHost): boolean =>
  host.effects.some((effect) => effect.mods.knockbackImmune === true);

export const hasThreatDrop = (host: EffectHost): boolean =>
  host.effects.some((effect) => effect.mods.threatDrop === true);

/**
 * Consume the strongest next-attack rider (Shadowstep/Smoke Veil "+X% on
 * your next attack") — returns the multiplier and removes the effect.
 */
export const consumeNextAttackBonus = (host: EffectHost): number => {
  let bestIndex = -1;
  let bestPct = 0;
  for (let i = 0; i < host.effects.length; i++) {
    const pct = host.effects[i]!.mods.nextAttackPct ?? 0;
    if (pct > bestPct) {
      bestPct = pct;
      bestIndex = i;
    }
  }
  if (bestIndex < 0) return 1;
  host.effects.splice(bestIndex, 1);
  host.effectsDirty = true;
  return pctToMult(bestPct);
};

/** On-death riders for the killer (Death Mark: energy refund + CD reset). */
export const collectOnKillRiders = (
  host: EffectHost,
  killerId: number,
): { energy: number; resetAbilities: string[] } => {
  let energy = 0;
  const resetAbilities: string[] = [];
  for (const effect of host.effects) {
    if (effect.casterId !== killerId) continue;
    energy += effect.onKillEnergy;
    if (effect.onKillResetAbility) resetAbilities.push(effect.onKillResetAbility);
  }
  return { energy, resetAbilities };
};

// ---------------------------------------------------------------------------
// P6 status system: categories, cleanse, absorbs
// ---------------------------------------------------------------------------

/** Does the host carry any effect of these categories? (Ice Lance bonusVs.) */
export const hasCategory = (host: EffectHost, categories: readonly EffectCategory[]): boolean =>
  host.effects.some((effect) => categories.includes(effect.category));

/**
 * Strip effects (Purify / Blink / Dawnlight). `filter: movement` removes only
 * root/slow/chill; 'any' removes harmful effects of every category. Newest
 * first — cleansing pops what just landed on you. Returns how many left.
 */
export const cleanseEffects = (
  host: EffectHost,
  filter: 'any' | 'movement',
  count: number,
  all: boolean,
): number => {
  let removed = 0;
  for (let i = host.effects.length - 1; i >= 0; i--) {
    if (!all && removed >= count) break;
    const effect = host.effects[i]!;
    if (!effect.harmful) continue;
    if (filter === 'movement' && !MOVEMENT_CATEGORIES.includes(effect.category)) continue;
    host.effects.splice(i, 1);
    removed += 1;
  }
  if (removed > 0) host.effectsDirty = true;
  return removed;
};

/**
 * Drain absorb shields for incoming damage, oldest shield first. Returns how
 * much was absorbed; a shield whose pool ran dry drops off the bar
 * immediately. (Mana Shield drains MANA, not a pool — the damage path handles
 * it separately via {@link manaShieldRateOf}.)
 */
export const absorbFromShields = (host: EffectHost, amount: number): number => {
  let remaining = amount;
  let changed = false;
  const spent: ActiveEffect[] = [];
  for (const effect of host.effects) {
    if (remaining <= 0) break;
    if (effect.shieldPool <= 0) continue;
    const absorbed = Math.min(effect.shieldPool, remaining);
    effect.shieldPool -= absorbed;
    remaining -= absorbed;
    changed = true;
    if (effect.shieldPool <= 0) spent.push(effect);
  }
  if (spent.length > 0) {
    host.effects = host.effects.filter((effect) => !spent.includes(effect));
  }
  if (changed) host.effectsDirty = true;
  return amount - remaining;
};

/** Mana Shield rate if one is up (Mage): mana drained per damage point. */
export const manaShieldRateOf = (host: EffectHost): number | null => {
  for (const effect of host.effects) {
    if (effect.mods.manaShieldPerPoint !== undefined) return effect.mods.manaShieldPerPoint;
  }
  return null;
};

/** Drop the mana-shield buff (its pool ran dry). */
export const dropManaShield = (host: EffectHost): void => {
  const before = host.effects.length;
  host.effects = host.effects.filter((effect) => effect.mods.manaShieldPerPoint === undefined);
  if (host.effects.length !== before) host.effectsDirty = true;
};

export const isUntargetable = (host: EffectHost): boolean =>
  host.effects.some((effect) => effect.mods.untargetable === true);

/** Aggregate dodge stamina delta from effects (Evasive-style buffs). */
export const dodgeCostDeltaOf = (host: EffectHost): number => {
  let delta = 0;
  for (const effect of host.effects) {
    if (effect.mods.dodgeCostDelta) delta += effect.mods.dodgeCostDelta;
  }
  return delta;
};

/** Damage inputs a projectile carries (the caster may be gone at impact). */
export interface BoltDamageInputs {
  casterId: number;
  casterLevel: number;
  power: number;
  weaponMin: number;
  weaponMax: number;
  damageDealtMult: number;
}

/**
 * Apply a slot bolt's ON-HIT riders at impact (P6): the def's `apply_effect
 * target:'hit'` entries land on the struck enemy — Fireball's burn, Ice
 * Lance's chill — with DoT budgets computed from the inputs captured at fire
 * time, exactly like the melee apply path (mitigated once, split over ticks).
 */
export const applyBoltRiders = (
  def: AbilityDef,
  target: EffectHost & { armor: number; magicResistPct: number; level: number },
  inputs: BoltDamageInputs,
  nowMs: number,
): void => {
  for (const effect of def.effects) {
    if (effect.kind !== 'apply_effect' || effect.target !== 'hit') continue;
    const periodic = effect.mods.periodic;
    const tickCount = periodic
      ? Math.max(1, Math.floor(effect.durationMs / periodic.tickEveryMs))
      : 0;
    const dotBudget = periodic
      ? periodic.coefTotal *
        ((inputs.weaponMin + inputs.weaponMax) / 2 + inputs.power) *
        inputs.damageDealtMult
      : 0;
    const mitigated =
      periodic?.kind === 'damage'
        ? Math.max(
            1,
            Math.round(
              (dotBudget *
                (1 -
                  (periodic.school === 'physical'
                    ? armorMitigation(target.armor, inputs.casterLevel)
                    : target.magicResistPct / 100)) *
                levelModifier(inputs.casterLevel, target.level)) /
                tickCount,
            ),
          )
        : 0;
    applyEffect(
      target,
      {
        effectId: effect.effectId,
        casterId: inputs.casterId,
        durationMs: effect.durationMs,
        stacksMax: effect.stacksMax,
        mods: effect.mods,
        harmful: true,
        category: effect.category,
        tickDamage: mitigated,
        tickSchool: periodic?.school ?? 'physical',
        tickEveryMs: periodic?.tickEveryMs,
      },
      nowMs,
    );
  }
};
