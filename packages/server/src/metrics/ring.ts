/**
 * In-process metrics ring (docs/tech/TECH_STACK.md — no Prometheus on a 1-core box).
 *
 * Fixed-size typed arrays, zero allocation per sample. The admin panel and the
 * `/perf` GM command read these.
 */

export interface MetricsSnapshot {
  tickP50Ms: number;
  tickP95Ms: number;
  tickMaxMs: number;
  players: number;
  entities: number;
  bytesOutPerSec: number;
  bytesInPerSec: number;
  rssMb: number;
  uptimeSec: number;
  ticks: number;
}

export class MetricsRing {
  private readonly tickTimes: Float32Array;
  private readonly capacity: number;
  private writeIndex = 0;
  private filled = 0;

  private bytesOut = 0;
  private bytesIn = 0;
  private windowStart = performance.now();
  private lastBytesOutRate = 0;
  private lastBytesInRate = 0;

  private readonly startedAt = Date.now();
  private totalTicks = 0;

  constructor(capacity = 1200) {
    this.capacity = capacity;
    this.tickTimes = new Float32Array(capacity);
  }

  recordTick(durationMs: number): void {
    this.tickTimes[this.writeIndex] = durationMs;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
    this.totalTicks++;

    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed >= 1000) {
      const seconds = elapsed / 1000;
      this.lastBytesOutRate = this.bytesOut / seconds;
      this.lastBytesInRate = this.bytesIn / seconds;
      this.bytesOut = 0;
      this.bytesIn = 0;
      this.windowStart = now;
    }
  }

  recordBytesOut(count: number): void {
    this.bytesOut += count;
  }

  recordBytesIn(count: number): void {
    this.bytesIn += count;
  }

  snapshot(players: number, entities: number): MetricsSnapshot {
    const samples = Array.from(this.tickTimes.subarray(0, this.filled)).sort((a, b) => a - b);
    const percentile = (p: number): number => {
      if (samples.length === 0) return 0;
      const index = Math.min(samples.length - 1, Math.floor(samples.length * p));
      return samples[index] ?? 0;
    };

    return {
      tickP50Ms: Number(percentile(0.5).toFixed(3)),
      tickP95Ms: Number(percentile(0.95).toFixed(3)),
      tickMaxMs: Number((samples[samples.length - 1] ?? 0).toFixed(3)),
      players,
      entities,
      bytesOutPerSec: Math.round(this.lastBytesOutRate),
      bytesInPerSec: Math.round(this.lastBytesInRate),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      ticks: this.totalTicks,
    };
  }
}
