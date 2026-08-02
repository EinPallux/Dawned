/**
 * One connected socket: lifecycle, per-opcode rate limiting and backpressure.
 *
 * Rate limits are part of the anti-abuse surface (docs/tech/SECURITY.md §2) and
 * apply to every client equally — GM powers are checked separately, later.
 */

import type { WebSocket } from 'ws';
import { BinaryWriter } from '@dawned/shared';
import type { ServerPlayer } from '../world/player.js';

/** Simple token bucket; refills continuously, never allocates. */
class TokenBucket {
  private tokens: number;
  private lastRefill = performance.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
  }

  tryConsume(count = 1): boolean {
    const now = performance.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
      this.lastRefill = now;
    }
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }
}

export type SessionState = 'handshaking' | 'authenticating' | 'playing' | 'closed';

/** Socket buffer above which we start shedding non-essential traffic. */
const BACKPRESSURE_SOFT_BYTES = 64 * 1024;
/** Socket buffer above which the client is considered gone. */
const BACKPRESSURE_HARD_BYTES = 512 * 1024;

export class Session {
  state: SessionState = 'handshaking';
  player: ServerPlayer | null = null;

  /** Reused across sends so the tick loop allocates nothing per client. */
  readonly writer = new BinaryWriter(2048);

  readonly connectedAt = Date.now();
  lastMessageAt = Date.now();

  private readonly inputLimit = new TokenBucket(60, 40);
  private readonly chatLimit = new TokenBucket(5, 2);
  private readonly genericLimit = new TokenBucket(40, 20);

  constructor(
    readonly id: string,
    private readonly socket: WebSocket,
    readonly ip: string,
    private readonly onBytesOut: (bytes: number) => void,
  ) {}

  /**
   * State check that survives control-flow narrowing: socket close events mutate
   * `state` concurrently with awaited handshake work, so callers re-checking after
   * an `await` must not let TypeScript "prove" the comparison constant.
   */
  isIn(state: SessionState): boolean {
    return this.state === state;
  }

  allowInput(): boolean {
    return this.inputLimit.tryConsume();
  }

  allowChat(): boolean {
    return this.chatLimit.tryConsume();
  }

  allowGeneric(): boolean {
    return this.genericLimit.tryConsume();
  }

  get backpressured(): boolean {
    return this.socket.bufferedAmount > BACKPRESSURE_SOFT_BYTES;
  }

  get overloaded(): boolean {
    return this.socket.bufferedAmount > BACKPRESSURE_HARD_BYTES;
  }

  send(data: Uint8Array): void {
    if (this.state === 'closed') return;
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(data);
    this.onBytesOut(data.byteLength);
  }

  close(code = 1000, reason = ''): void {
    this.state = 'closed';
    try {
      this.socket.close(code, reason);
    } catch {
      // Socket already torn down — nothing to do.
    }
  }
}
