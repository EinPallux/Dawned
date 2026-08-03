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

import type { AbilityEffectMods } from '@dawned/shared';

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
  tickSchool: 'physical' | 'magic';
  harmful: boolean;
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
  tickDamage?: number;
  tickSchool?: 'physical' | 'magic';
  tickEveryMs?: number;
  markPct?: number;
  onKillEnergy?: number;
  onKillResetAbility?: string | null;
}

/**
 * Apply or stack an effect. Same effectId FROM THE SAME CASTER stacks up to
 * stacksMax and refreshes the duration (poison model); different casters keep
 * separate instances (two rogues' poisons both tick).
 */
export const applyEffect = (host: EffectHost, input: ApplyEffectInput, nowMs: number): void => {
  const existing = host.effects.find(
    (effect) => effect.effectId === input.effectId && effect.casterId === input.casterId,
  );
  if (existing) {
    existing.stacks = Math.min(existing.stacksMax, existing.stacks + 1);
    existing.expiresAtMs = nowMs + input.durationMs;
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
    tickSchool: input.tickSchool ?? 'physical',
    harmful: input.harmful,
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
  /** Damage for this tick (stacks folded in). */
  damage: number;
}

/**
 * Advance expiry + collect due periodic ticks (caller runs them through the
 * real damage pipeline so mitigation/threat/death stay in one place).
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
      if (effect.tickDamage > 0) {
        out.push({ effect, damage: effect.tickDamage * effect.stacks });
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

/** Damage this entity DEALS, folded across buffs (× Dawned externally). */
export const damageDealtMultOf = (host: EffectHost): number => {
  let mult = 1;
  for (const effect of host.effects) {
    if (effect.mods.damageDealtPct) mult *= pctToMult(effect.mods.damageDealtPct);
  }
  return mult;
};

/**
 * Damage this entity TAKES from `attackerId` — folds general damageTaken
 * modifiers plus caster-scoped marks (Death Mark).
 */
export const damageTakenMultOf = (host: EffectHost, attackerId: number): number => {
  let mult = 1;
  for (const effect of host.effects) {
    if (effect.mods.damageTakenPct) mult *= pctToMult(effect.mods.damageTakenPct);
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
