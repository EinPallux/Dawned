/**
 * Fixed-rate tick loop with drift correction.
 *
 * setTimeout drifts; accumulating the *scheduled* time instead of "now + interval"
 * keeps the long-run rate exact. If the process stalls (GC, a slow tick), we skip
 * ahead rather than spiral trying to catch up.
 */

import { TICK_MS } from '@dawned/shared';

export class TickLoop {
  private timer: NodeJS.Timeout | null = null;
  private nextTickAt = 0;
  private running = false;

  constructor(
    private readonly onTick: (tickIndex: number) => void,
    private readonly onTickDuration: (durationMs: number) => void,
    private readonly intervalMs: number = TICK_MS,
  ) {}

  private tickIndex = 0;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.nextTickAt = performance.now() + this.intervalMs;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (!this.running) return;
    const delay = Math.max(0, this.nextTickAt - performance.now());
    this.timer = setTimeout(() => {
      this.run();
    }, delay);
  }

  private run(): void {
    if (!this.running) return;
    const started = performance.now();

    this.nextTickAt += this.intervalMs;
    // Fell more than 5 ticks behind (suspend/resume, long GC): resync instead of
    // running a burst of catch-up ticks that would teleport everyone.
    if (started - this.nextTickAt > this.intervalMs * 5) {
      this.nextTickAt = started + this.intervalMs;
    }

    try {
      this.onTick(this.tickIndex);
    } finally {
      this.tickIndex = (this.tickIndex + 1) & 0xffff;
      this.onTickDuration(performance.now() - started);
      this.schedule();
    }
  }
}
