/**
 * A player entity in the authoritative world.
 *
 * The server owns this state completely; the client's messages are *requests*
 * (docs/tech/SECURITY.md §2). Nothing here is ever set directly from a packet.
 */

import {
  EntityFlag,
  InputButton,
  createAbilityMachine,
  createMovementState,
  createResourceState,
  isDodgeInvulnerable,
  playerStats,
  type AbilityDef,
  type Appearance,
  type ClassId,
  type CombatStats,
  type MovementIntent,
  type MovementState,
  type ResourceState,
} from '@dawned/shared';
import type { ActiveEffect } from './effects.js';

/** A committed instant ability waiting for its contact frame. */
export interface PendingAbility {
  def: AbilityDef;
  action: number;
  atMs: number;
  aimYaw: number;
  aimPitch: number;
  targetId: number;
  comboPointsSpent: number;
  /** PBAoE pulse train remaining (Whirlwind ×2); 1 for single resolves. */
  pulsesLeft: number;
}
import { PositionHistory } from './history.js';

/** Inputs buffered beyond this are dropped — bounds jitter and input hoarding. */
const MAX_QUEUED_INPUTS = 10;
/** At most this many inputs are consumed per tick when a client is behind. */
const MAX_INPUTS_PER_TICK = 2;
/** Queue length above which we start catching up. */
const CATCHUP_THRESHOLD = 3;
/** Consecutive starved ticks (500 ms at 20 Hz) after which movement is zeroed. */
const STARVATION_ZERO_AFTER_TICKS = 10;

const NEUTRAL_INTENT: MovementIntent = { moveX: 0, moveZ: 0, yaw: 0, buttons: 0 };
/** Buttons that must fire once per press, never on a repeated (starved) intent. */
const ONE_SHOT_BUTTONS = InputButton.Jump | InputButton.Dodge;

export interface QueuedInput extends MovementIntent {
  seq: number;
}

/** A basic-attack press waiting to enter the tick pipeline. */
export interface QueuedAttack {
  seq: number;
  action: number;
  aimYaw: number;
  aimPitch: number;
  /** Soft-target at press (0 = none) — slot abilities only (v7). */
  targetId: number;
}

/** A committed combo step waiting for its contact moment. */
export interface PendingContact {
  step: number;
  atMs: number;
  aimYaw: number;
  aimPitch: number;
}

/** Attack requests buffered beyond this are dropped (spam guard). */
const MAX_QUEUED_ATTACKS = 4;

export class ServerPlayer {
  readonly movement: MovementState;

  // --- combat (P4) ---------------------------------------------------------
  readonly stats: CombatStats;
  /** Float internally for smooth regen; rounded at the wire. */
  hp: number;
  readonly maxHp: number;
  /** Class resource + combo points (P5) — ticked by the ability system. */
  readonly resource: ResourceState;
  /** Slot-ability timing/validation (P5) — same machine the client predicts. */
  readonly abilityMachine = createAbilityMachine();
  /** Committed instant awaiting its contact frame (and PBAoE pulse train). */
  pendingAbility: PendingAbility | null = null;
  /** Dash origin (Charge sweep resolves start → current position). */
  dashStartX = 0;
  dashStartZ = 0;
  /** Live buffs/debuffs (EffectHost contract — world/effects.ts). */
  effects: ActiveEffect[] = [];
  effectsDirty = false;
  /** Ambusher CP-on-crit internal cooldown marker (CLASSES.md §3). */
  ambusherCpReadyAtMs = 0;
  /** RMB stance (P5): shield up (Warrior/Cleric) this tick. */
  blocking = false;
  /** When the shield came up — the perfect-block window reference. */
  blockRaisedAtMs = 0;
  dead = false;
  /** Combo chain: current step (−1 = none) and when it started. */
  comboStep = -1;
  comboStartedAtMs = 0;
  gcdUntilMs = 0;
  pendingContact: PendingContact | null = null;
  /** "Dawned" respawn debuff (−15% damage dealt) until this ms. */
  dawnedUntilMs = 0;
  /** Last damage given or taken — drives out-of-combat regen (COMBAT.md §6.6). */
  lastCombatAtMs = 0;
  /** Server-measured round trip (ping echo) — feeds the rewind window. */
  rttMs = 0;
  readonly history = new PositionHistory();
  private readonly attackQueue: QueuedAttack[] = [];

  private readonly inputQueue: QueuedInput[] = [];
  private lastIntent: MovementIntent = { ...NEUTRAL_INTENT };

  /** Highest input sequence actually simulated — echoed to the client for reconciliation. */
  lastProcessedSeq = 0;
  /** Total ticks where the client's input arrived too late (network jitter indicator). */
  starvedTicks = 0;
  /** Starved ticks since the last real input — drives the runaway guard below. */
  private consecutiveStarvedTicks = 0;
  /** Anti-cheat counters (docs/tech/SECURITY.md §4). */
  violations = 0;

  /** Wall-clock of the last position flush (playtime accounting). */
  lastPersistedAt = Date.now();
  /** Entity ids currently inside this player's AOI (world.entitiesFor). */
  readonly visible = new Set<number>();
  /** Last accepted /stuck teleport (60 s cooldown, gateway.handleChat). */
  lastStuckAt = 0;

  constructor(
    readonly id: number,
    readonly characterId: number,
    readonly accountId: number,
    readonly name: string,
    readonly classId: ClassId,
    readonly level: number,
    readonly appearance: Appearance,
    spawnX: number,
    spawnY: number,
    spawnZ: number,
    yaw: number,
    /** Persisted HP; null = full (fresh character or post-respawn save). */
    persistedHp: number | null = null,
  ) {
    this.stats = playerStats(classId, level);
    this.maxHp = this.stats.maxHp;
    this.hp = persistedHp !== null ? Math.min(Math.max(persistedHp, 1), this.maxHp) : this.maxHp;
    this.resource = createResourceState(classId, this.stats.int);
    this.movement = createMovementState(spawnX, spawnY, spawnZ, this.stats.maxStamina);
    this.movement.yaw = yaw;
  }

  /** Buffer a basic-attack/respawn request from the gateway. */
  queueAttack(request: QueuedAttack): void {
    if (this.attackQueue.length >= MAX_QUEUED_ATTACKS) {
      this.violations++;
      return;
    }
    this.attackQueue.push(request);
  }

  /** Drain queued attack requests for this tick (world.step consumes). */
  takeAttackRequests(): QueuedAttack[] {
    if (this.attackQueue.length === 0) return this.attackQueue;
    return this.attackQueue.splice(0, this.attackQueue.length);
  }

  /** Buffer a validated intent from the client. */
  queueInput(input: QueuedInput): void {
    if (this.inputQueue.length >= MAX_QUEUED_INPUTS) {
      // Client is flooding or badly behind: keep the newest, drop the stalest.
      this.inputQueue.shift();
      this.violations++;
    }
    this.inputQueue.push(input);
  }

  /**
   * Pull the intents to simulate this tick.
   *
   * One per tick normally; up to {@link MAX_INPUTS_PER_TICK} when the client is
   * behind (bounded so buffering inputs can never buy extra movement); the last
   * intent repeats when nothing arrived, minus one-shot buttons — but only briefly:
   * after {@link STARVATION_ZERO_AFTER_TICKS} the movement axes are zeroed, so a
   * hidden tab or a dying connection stops the character instead of walking it in
   * a straight line to the world border.
   */
  takeInputsForTick(): MovementIntent[] {
    const available = this.inputQueue.length;
    if (available === 0) {
      this.starvedTicks++;
      this.consecutiveStarvedTicks++;
      const starvedOut = this.consecutiveStarvedTicks > STARVATION_ZERO_AFTER_TICKS;
      const repeat: MovementIntent = {
        moveX: starvedOut ? 0 : this.lastIntent.moveX,
        moveZ: starvedOut ? 0 : this.lastIntent.moveZ,
        yaw: this.lastIntent.yaw,
        buttons: starvedOut ? 0 : this.lastIntent.buttons & ~ONE_SHOT_BUTTONS,
      };
      this.lastIntent = repeat;
      return [repeat];
    }

    this.consecutiveStarvedTicks = 0;
    const count = available > CATCHUP_THRESHOLD ? Math.min(MAX_INPUTS_PER_TICK, available) : 1;
    const intents: MovementIntent[] = [];
    for (let i = 0; i < count; i++) {
      const input = this.inputQueue.shift();
      if (!input) break;
      this.lastProcessedSeq = input.seq;
      this.lastIntent = {
        moveX: input.moveX,
        moveZ: input.moveZ,
        yaw: input.yaw,
        buttons: input.buttons,
      };
      intents.push(this.lastIntent);
    }
    return intents;
  }

  /** Snapshot flag bitfield for this player's current state. */
  get flags(): number {
    const m = this.movement;
    let flags = 0;
    if (m.grounded) flags |= EntityFlag.Grounded;
    if (m.sprinting) flags |= EntityFlag.Sprinting;
    if (Math.abs(m.vx) > 0.1 || Math.abs(m.vz) > 0.1) flags |= EntityFlag.Moving;
    if (m.swimming) flags |= EntityFlag.Swimming;
    if (m.rollTimeLeft > 0) flags |= EntityFlag.Dodging;
    if (this.dead) flags |= EntityFlag.Dead;
    return flags;
  }

  /** Record this tick's post-step position + i-frame state for lag rewind. */
  recordHistory(): void {
    const m = this.movement;
    this.history.record(m.x, m.y, m.z, isDodgeInvulnerable(m));
  }
}
