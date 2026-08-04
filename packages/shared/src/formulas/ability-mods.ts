/**
 * Skill-node ability_mod fold (P7): rewrite an authored AbilityDef into the
 * EFFECTIVE def a specific character plays with. Pure and deterministic —
 * the server folds at load/allocation and the client folds the same from its
 * synced node ranks, so machine-relevant numbers (cost, cooldown, cast,
 * channel) predict exactly.
 *
 * Scope: numeric def rewrites + unconditional appended effects. Reactive
 * riders (resetCooldownOf, onUseGrant, empowerBasics, consumeBonus, critVs,
 * guaranteedCritAtCp, epicenterStun, overhealToHot, everyNBonusBolt,
 * breakMovementOnUse, alsoCastFree, zoneAllyMods, and addEffects gated by
 * addEffectsRequireCategories) do NOT rewrite the def — the server applies
 * them at commit/resolve from the character's aggregated mods.
 */

import type { AbilityDef } from '../content/abilities.js';
import type { AbilityMods } from '../content/skill-nodes.js';

const clampMin = (value: number, min: number): number => Math.max(min, value);

/** Deep-enough clone: targeting/effects/channel copied, the rest shared. */
const cloneDef = (def: AbilityDef): AbilityDef => ({
  ...def,
  cost: { ...def.cost },
  channel: def.channel ? { ...def.channel } : null,
  targeting: { ...def.targeting },
  effects: def.effects.map((effect) => structuredClone(effect)),
  anim: { ...def.anim },
});

/** Apply one mods bundle in place (def already cloned). */
const applyOne = (def: AbilityDef, mods: AbilityMods): void => {
  // --- machine-relevant timing/costs ---------------------------------------
  if (mods.cooldownDeltaMs) def.cooldownMs = clampMin(def.cooldownMs + mods.cooldownDeltaMs, 0);
  if (mods.castDeltaMs && def.castMs > 0) def.castMs = clampMin(def.castMs + mods.castDeltaMs, 200);
  if (mods.costDelta) def.cost.amount = clampMin(def.cost.amount + mods.costDelta, 0);
  if (mods.channelDeltaMs && def.channel) {
    // Keep the bolt count: the tick interval scales with the new duration
    // (Quickened Barrage fires the same 6 bolts, faster).
    const oldDuration = def.channel.durationMs;
    const newDuration = clampMin(oldDuration + mods.channelDeltaMs, 500);
    def.channel.durationMs = newDuration;
    def.channel.tickEveryMs = clampMin(
      Math.round(def.channel.tickEveryMs * (newDuration / oldDuration)),
      100,
    );
  }

  // --- targeting geometry ----------------------------------------------------
  const t = def.targeting;
  if (mods.radiusDelta) {
    if (t.kind === 'pbaoe' || t.kind === 'ground_aoe')
      t.radius = clampMin(t.radius + mods.radiusDelta, 0.5);
  }
  if (mods.rangeDelta) {
    if (t.kind === 'teleport' || t.kind === 'dash')
      t.distance = clampMin(t.distance + mods.rangeDelta, 1);
    else if (t.kind === 'blink_behind' || t.kind === 'single' || t.kind === 'projectile') {
      t.maxRange = clampMin(t.maxRange + mods.rangeDelta, 2);
    } else if (t.kind === 'ally_soft') t.range = clampMin(t.range + mods.rangeDelta, 2);
    else if (t.kind === 'ground_aoe') t.maxRange = clampMin(t.maxRange + mods.rangeDelta, 5);
    else if (t.kind === 'melee_arc' || t.kind === 'cone')
      t.reach = clampMin(t.reach + mods.rangeDelta, 0.5);
  }
  if (mods.arcDeltaDeg && (t.kind === 'melee_arc' || t.kind === 'cone')) {
    t.angleDeg = Math.min(360, clampMin(t.angleDeg + mods.arcDeltaDeg, 10));
  }
  if (mods.maxTargetsDelta && 'maxTargets' in t) {
    t.maxTargets = clampMin(t.maxTargets + mods.maxTargetsDelta, 1);
  }
  if (mods.ticksDelta && t.kind === 'pbaoe') {
    t.ticks = { ...t.ticks, count: clampMin(t.ticks.count + mods.ticksDelta, 1) };
  }

  // --- effect list rewrites --------------------------------------------------
  for (const effect of def.effects) {
    switch (effect.kind) {
      case 'damage': {
        if (mods.damagePct) effect.coef *= 1 + mods.damagePct / 100;
        if (mods.coefDelta) effect.coef = clampMin(effect.coef + mods.coefDelta, 0);
        if (mods.coefPerComboPointDelta) effect.coefPerComboPoint += mods.coefPerComboPointDelta;
        break;
      }
      case 'heal': {
        if (mods.healPct) effect.coef *= 1 + mods.healPct / 100;
        if (mods.healCoefDelta) effect.coef = clampMin(effect.coef + mods.healCoefDelta, 0);
        break;
      }
      case 'shield': {
        if (mods.shieldPct) effect.coef *= 1 + mods.shieldPct / 100;
        break;
      }
      case 'stun':
      case 'knockdown':
      case 'root': {
        if (mods.ccDurationDeltaMs) {
          effect.durationMs = clampMin(effect.durationMs + mods.ccDurationDeltaMs, 200);
        }
        break;
      }
      case 'zone': {
        if (mods.zoneDurationDeltaMs) {
          effect.durationMs = clampMin(effect.durationMs + mods.zoneDurationDeltaMs, 1000);
        }
        if (mods.zoneRadiusDelta) effect.radius = clampMin(effect.radius + mods.zoneRadiusDelta, 1);
        break;
      }
      case 'mark': {
        if (mods.markDamagePctDelta) effect.damageFromCasterPct += mods.markDamagePctDelta;
        break;
      }
      case 'apply_effect': {
        const periodic = effect.mods.periodic;
        if (periodic?.kind === 'damage') {
          // DoT rider (Deep Wounds): budget % + extra duration.
          if (mods.dotDamagePct) periodic.coefTotal *= 1 + mods.dotDamagePct / 100;
          if (mods.dotDurationDeltaMs) {
            effect.durationMs = clampMin(effect.durationMs + mods.dotDurationDeltaMs, 500);
          }
        } else if (mods.buffDurationDeltaMs) {
          // Non-periodic buff/debuff duration (Unbreakable, Smoke Trickery).
          effect.durationMs = clampMin(effect.durationMs + mods.buffDurationDeltaMs, 500);
        }
        if (mods.appliedMoveSpeedDeltaPct && (effect.mods.moveSpeedPct ?? 0) < 0) {
          // Slow magnitude (Cripple Mastery): −40% becomes −48%.
          effect.mods.moveSpeedPct = Math.max(
            -90,
            (effect.mods.moveSpeedPct ?? 0) + mods.appliedMoveSpeedDeltaPct,
          );
        }
        if (mods.manaShieldPerPoint && effect.mods.manaShieldPerPoint !== undefined) {
          // Barrier Tuning: cumulative per-rank OVERRIDE, not a delta.
          effect.mods.manaShieldPerPoint = mods.manaShieldPerPoint;
        }
        if (mods.dotDamagePct && effect.mods.onHitApply) {
          effect.mods.onHitApply.periodic.coefTotal *= 1 + mods.dotDamagePct / 100;
        }
        break;
      }
      default:
        break;
    }
  }

  // Unconditional appended effects (Searing Smite's DoT, Scorched Ground's
  // field, Momentum/Battle Roar self-buffs, Immovable's heal-over-duration).
  // Category-gated appends stay runtime-applied (Winter's Grasp).
  if (mods.addEffects && !mods.addEffectsRequireCategories) {
    def.effects = [...def.effects, ...mods.addEffects.map((effect) => structuredClone(effect))];
  }
};

/**
 * Fold a character's ability_mod bundles into an authored def. Returns the
 * original object untouched when nothing applies (steady-state fast path).
 */
export const applyAbilityMods = (
  def: AbilityDef,
  modsList: readonly AbilityMods[] | undefined,
): AbilityDef => {
  if (!modsList || modsList.length === 0) return def;
  const out = cloneDef(def);
  for (const mods of modsList) applyOne(out, mods);
  return out;
};

/**
 * Build the full effective-def map for a character: every ability touched by
 * their allocated nodes gets a rewritten entry; untouched abilities resolve
 * to the authored def at lookup (keep the map small).
 */
export const buildEffectiveDefs = (
  authored: ReadonlyMap<string, AbilityDef>,
  abilityMods: ReadonlyMap<string, readonly AbilityMods[]>,
): Map<string, AbilityDef> => {
  const out = new Map<string, AbilityDef>();
  for (const [abilityId, modsList] of abilityMods) {
    const def = authored.get(abilityId);
    if (def) out.set(abilityId, applyAbilityMods(def, modsList));
  }
  return out;
};
