/**
 * Position history rings for lag compensation (docs/tech/NETWORKING.md §4).
 *
 * Every combat-relevant entity records its post-step position each tick; hit
 * resolution rewinds VICTIMS to what the attacker saw. Players additionally
 * record their dodge i-frame state so "it was rolling on my screen" counts.
 * Typed arrays, preallocated — zero garbage on the tick path (§7).
 */

import { REWIND_HISTORY_TICKS } from '@dawned/shared';

export class PositionHistory {
  private readonly xs = new Float32Array(REWIND_HISTORY_TICKS);
  private readonly ys = new Float32Array(REWIND_HISTORY_TICKS);
  private readonly zs = new Float32Array(REWIND_HISTORY_TICKS);
  private readonly invulnerable = new Uint8Array(REWIND_HISTORY_TICKS);
  private head = -1;
  private filled = 0;

  record(x: number, y: number, z: number, iframe: boolean): void {
    this.head = (this.head + 1) % REWIND_HISTORY_TICKS;
    this.xs[this.head] = x;
    this.ys[this.head] = y;
    this.zs[this.head] = z;
    this.invulnerable[this.head] = iframe ? 1 : 0;
    if (this.filled < REWIND_HISTORY_TICKS) this.filled++;
  }

  /**
   * Position `ticksBack` ticks ago (0 = the latest recorded). Clamped to what
   * exists — a fresh entity answers with its earliest known position.
   */
  at(ticksBack: number, out: { x: number; y: number; z: number }): boolean {
    if (this.filled === 0) return false;
    const back = Math.min(Math.max(0, Math.floor(ticksBack)), this.filled - 1);
    const index = (this.head - back + REWIND_HISTORY_TICKS) % REWIND_HISTORY_TICKS;
    out.x = this.xs[index]!;
    out.y = this.ys[index]!;
    out.z = this.zs[index]!;
    return true;
  }

  /** Whether the entity was inside its dodge i-frames `ticksBack` ticks ago. */
  wasInvulnerable(ticksBack: number): boolean {
    if (this.filled === 0) return false;
    const back = Math.min(Math.max(0, Math.floor(ticksBack)), this.filled - 1);
    const index = (this.head - back + REWIND_HISTORY_TICKS) % REWIND_HISTORY_TICKS;
    return this.invulnerable[index] === 1;
  }
}
