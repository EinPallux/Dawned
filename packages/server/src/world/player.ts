/**
 * A player entity in the authoritative world.
 *
 * The server owns this state completely; the client's messages are *requests*
 * (docs/tech/SECURITY.md §2). Nothing here is ever set directly from a packet.
 */

import {
  EntityFlag,
  InputButton,
  createMovementState,
  type MovementIntent,
  type MovementState,
} from '@dawned/shared';

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

export class ServerPlayer {
  readonly movement: MovementState;

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

  constructor(
    readonly id: number,
    readonly name: string,
    spawnX: number,
    spawnY: number,
    spawnZ: number,
  ) {
    this.movement = createMovementState(spawnX, spawnY, spawnZ);
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
    return flags;
  }
}
