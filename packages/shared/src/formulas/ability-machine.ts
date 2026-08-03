/**
 * Ability timing/validation machine (COMBAT.md §4) — the anti-desync core of
 * the class kits. One deterministic implementation runs on BOTH sides: the
 * client predicts against it at keypress, the server validates with it at
 * request receipt; identical rules mean rejects are rare and never surprising.
 *
 * Scope: hotbar slot abilities (cooldowns, charges, GCD, costs, casts).
 * Basics keep the P4 combo-window path; RMB stances are held state ticked by
 * the movement/combat step, not request/commit.
 */

import { GCD_MS } from '../constants.js';
import type { AbilityDef } from '../content/abilities.js';
import { AbilityRejectReason } from '../protocol/opcodes.js';
import { canAfford, payResource, type ResourceState } from './resources.js';

export { AbilityRejectReason };

interface SlotRuntime {
  /** Charges ready to spend (defs default to 1). */
  charges: number;
  /** When the NEXT charge refills (machine clock); 0 = full. */
  rechargeAtMs: number;
}

export interface ActiveCast {
  abilityId: string;
  startedAtMs: number;
  castMs: number;
  /** Captured at commit — resolve uses the press-time aim/target. */
  aimYaw: number;
  aimPitch: number;
  targetId: number;
  /** Whether movement cancel applies (def.castWhileMoving === false). */
  cancelOnMove: boolean;
  /** Accumulated movement time toward the 150 ms cancel grace. */
  movingForMs: number;
}

/**
 * A running channel (P6, Arcane Barrage): fires a release per tick instead of
 * one at the end. Aim/target captured at commit like casts; movement rules
 * come from castWhileMoving exactly the same way.
 */
export interface ActiveChannel {
  abilityId: string;
  startedAtMs: number;
  durationMs: number;
  tickEveryMs: number;
  /** Machine time the next tick fires. */
  nextTickAtMs: number;
  aimYaw: number;
  aimPitch: number;
  targetId: number;
  cancelOnMove: boolean;
  movingForMs: number;
}

export interface AbilityMachine {
  /** Machine-local clock (ms). Advanced only by tickAbilityMachine. */
  nowMs: number;
  gcdUntilMs: number;
  slots: Map<string, SlotRuntime>;
  cast: ActiveCast | null;
  channel: ActiveChannel | null;
}

export const createAbilityMachine = (): AbilityMachine => ({
  nowMs: 0,
  gcdUntilMs: 0,
  slots: new Map(),
  cast: null,
  channel: null,
});

const slotFor = (machine: AbilityMachine, def: AbilityDef): SlotRuntime => {
  let slot = machine.slots.get(def.id);
  if (!slot) {
    slot = { charges: def.charges, rechargeAtMs: 0 };
    machine.slots.set(def.id, slot);
  }
  return slot;
};

/** Movement-cancel grace while casting with castWhileMoving=false. */
export const CAST_MOVE_GRACE_MS = 150;

export interface CastRelease {
  abilityId: string;
  aimYaw: number;
  aimPitch: number;
  targetId: number;
}

export interface AbilityTickResult {
  /** A finished cast this tick (caller resolves effects/anim release). */
  released: CastRelease | null;
  /** Channel ticks that fired this tick, oldest first (one bolt each). */
  channelTicks: CastRelease[];
  /** True when the channel completed its full duration this tick. */
  channelEnded: boolean;
  moveCanceled: boolean;
}

/**
 * Advance the clock; refill charges; complete casts; fire channel ticks.
 * Returns everything that released this tick.
 */
export const tickAbilityMachine = (
  machine: AbilityMachine,
  dtMs: number,
  moving: boolean,
): AbilityTickResult => {
  machine.nowMs += dtMs;
  const result: AbilityTickResult = {
    released: null,
    channelTicks: [],
    channelEnded: false,
    moveCanceled: false,
  };

  for (const [, slot] of machine.slots) {
    if (slot.rechargeAtMs > 0 && machine.nowMs >= slot.rechargeAtMs) {
      slot.charges += 1;
      slot.rechargeAtMs = 0; // next charge starts recharging on next spend
    }
  }

  const channel = machine.channel;
  if (channel) {
    if (channel.cancelOnMove) {
      channel.movingForMs = moving ? channel.movingForMs + dtMs : 0;
      if (channel.movingForMs > CAST_MOVE_GRACE_MS) {
        machine.channel = null;
        result.moveCanceled = true;
        return result;
      }
    }
    const endAtMs = channel.startedAtMs + channel.durationMs;
    // Fire every tick the clock passed this step (a big dt catches up); ticks
    // never fire past the channel's end.
    while (channel.nextTickAtMs <= machine.nowMs && channel.nextTickAtMs <= endAtMs) {
      result.channelTicks.push({
        abilityId: channel.abilityId,
        aimYaw: channel.aimYaw,
        aimPitch: channel.aimPitch,
        targetId: channel.targetId,
      });
      channel.nextTickAtMs += channel.tickEveryMs;
    }
    if (machine.nowMs >= endAtMs) {
      machine.channel = null;
      result.channelEnded = true;
    }
  }

  const cast = machine.cast;
  if (!cast) return result;

  if (cast.cancelOnMove) {
    cast.movingForMs = moving ? cast.movingForMs + dtMs : 0;
    if (cast.movingForMs > CAST_MOVE_GRACE_MS) {
      machine.cast = null;
      result.moveCanceled = true;
      return result;
    }
  }

  if (machine.nowMs - cast.startedAtMs >= cast.castMs) {
    machine.cast = null;
    result.released = {
      abilityId: cast.abilityId,
      aimYaw: cast.aimYaw,
      aimPitch: cast.aimPitch,
      targetId: cast.targetId,
    };
  }
  return result;
};

export interface UseContext {
  level: number;
  alive: boolean;
  resource: ResourceState;
  /** Targeted kinds (single / blink_behind fallback rules are server-side —
   * the machine only enforces "some target given when strictly required"). */
  hasTarget: boolean;
}

export const evaluateUse = (
  machine: AbilityMachine,
  def: AbilityDef,
  ctx: UseContext,
): { ok: true } | { ok: false; reason: AbilityRejectReason } => {
  if (!ctx.alive) return { ok: false, reason: AbilityRejectReason.Dead };
  if (ctx.level < def.unlockLevel) return { ok: false, reason: AbilityRejectReason.Locked };
  if (machine.cast !== null || machine.channel !== null) {
    return { ok: false, reason: AbilityRejectReason.AlreadyCasting };
  }
  if (def.onGcd && machine.nowMs < machine.gcdUntilMs) {
    return { ok: false, reason: AbilityRejectReason.OnGcd };
  }
  const slot = slotFor(machine, def);
  if (slot.charges <= 0) return { ok: false, reason: AbilityRejectReason.OnCooldown };
  if (!canAfford(ctx.resource, def.cost.type, def.cost.amount)) {
    return { ok: false, reason: AbilityRejectReason.NoResource };
  }
  if (def.comboFinisher && ctx.resource.comboPoints <= 0) {
    return { ok: false, reason: AbilityRejectReason.NoComboPoints };
  }
  if (def.targeting.kind === 'single' && !ctx.hasTarget) {
    return { ok: false, reason: AbilityRejectReason.NoTarget };
  }
  return { ok: true };
};

export interface CommitResult {
  /** 'instant' resolves after the anim contact delay; 'cast' after the bar;
   * 'channel' fires a release per tick until its duration ends. */
  phase: 'instant' | 'cast' | 'channel';
  /** For instants: ms until the contact point (anim-driven). */
  contactDelayMs: number;
}

/**
 * Pay costs, burn a charge, start GCD/cooldown/cast. Caller must have
 * evaluateUse'd OK — commit never re-checks (the pair stays cheap and the
 * server treats an invalid commit attempt as a reject at evaluate).
 */
export const commitUse = (
  machine: AbilityMachine,
  def: AbilityDef,
  resource: ResourceState,
  aim: { yaw: number; pitch: number; targetId: number },
): CommitResult => {
  if (def.cost.type !== 'none' && def.cost.type !== 'stamina') {
    payResource(resource, def.cost.amount);
  }
  // Charges exist only for abilities that actually recharge: a zero-cooldown
  // ability is gated by GCD + resource alone. (Burning a charge here with no
  // recharge timer to refill it bricked every cd-0 spender after one use —
  // on BOTH sides, so the server agreed and never corrected. Round 7.)
  if (def.cooldownMs > 0) {
    const slot = slotFor(machine, def);
    slot.charges -= 1;
    if (slot.rechargeAtMs === 0) {
      slot.rechargeAtMs = machine.nowMs + def.cooldownMs;
    }
  }
  if (def.onGcd) machine.gcdUntilMs = machine.nowMs + GCD_MS;

  if (def.channel !== null) {
    machine.channel = {
      abilityId: def.id,
      startedAtMs: machine.nowMs,
      durationMs: def.channel.durationMs,
      tickEveryMs: def.channel.tickEveryMs,
      // First bolt after one full tick interval — the press is the wind-up.
      nextTickAtMs: machine.nowMs + def.channel.tickEveryMs,
      aimYaw: aim.yaw,
      aimPitch: aim.pitch,
      targetId: aim.targetId,
      cancelOnMove: def.castWhileMoving === false,
      movingForMs: 0,
    };
    return { phase: 'channel', contactDelayMs: def.channel.tickEveryMs };
  }
  if (def.castMs > 0) {
    machine.cast = {
      abilityId: def.id,
      startedAtMs: machine.nowMs,
      castMs: def.castMs,
      aimYaw: aim.yaw,
      aimPitch: aim.pitch,
      targetId: aim.targetId,
      cancelOnMove: def.castWhileMoving === false,
      movingForMs: 0,
    };
    return { phase: 'cast', contactDelayMs: def.castMs };
  }
  return {
    phase: 'instant',
    contactDelayMs: Math.round(def.anim.durationMs * def.anim.contactFraction),
  };
};

/**
 * Cancel the active cast OR channel (COMBAT.md §4.5). Dodge cancels refund
 * 50% of the cost; stun/death/move cancels lose it all. Returns the refund in
 * resource units (caller credits it — needs the def for the cost type).
 */
export const interruptCast = (
  machine: AbilityMachine,
  reason: 'dodge' | 'stun' | 'move' | 'death',
  costAmount: number,
): { hadCast: boolean; refund: number } => {
  if (!machine.cast && !machine.channel) return { hadCast: false, refund: 0 };
  machine.cast = null;
  machine.channel = null;
  return { hadCast: true, refund: reason === 'dodge' ? Math.floor(costAmount / 2) : 0 };
};

/** Remaining cooldown of an ability (0 = ready) — HUD radials + resume sync. */
export const cooldownRemainingMs = (machine: AbilityMachine, abilityId: string): number => {
  const slot = machine.slots.get(abilityId);
  if (!slot || slot.charges > 0 || slot.rechargeAtMs === 0) return 0;
  return Math.max(0, slot.rechargeAtMs - machine.nowMs);
};

/** Authoritative cooldown snapshot (join/resume + post-reject correction). */
export const exportCooldowns = (machine: AbilityMachine): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [id] of machine.slots) {
    const remaining = cooldownRemainingMs(machine, id);
    if (remaining > 0) out[id] = remaining;
  }
  return out;
};

/** Adopt an authoritative cooldown snapshot (client correction path). */
export const importCooldowns = (
  machine: AbilityMachine,
  cooldowns: Record<string, number>,
  defsById: ReadonlyMap<string, AbilityDef>,
): void => {
  for (const [id, remainingMs] of Object.entries(cooldowns)) {
    const def = defsById.get(id);
    if (!def) continue;
    machine.slots.set(id, {
      charges: Math.max(0, def.charges - 1),
      rechargeAtMs: machine.nowMs + remainingMs,
    });
  }
};
