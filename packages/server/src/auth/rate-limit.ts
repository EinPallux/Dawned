/**
 * Auth rate limiting (docs/tech/SECURITY.md §1):
 *  - per-IP login attempts: 10/min
 *  - per-account failure lockout: 5 fails → 1 min, doubling per further fail, 1 h cap,
 *    cleared by a successful login
 *  - per-IP registrations: 3/day
 *
 * In-memory by design — one server process owns all logins. Entries are pruned
 * periodically so idle IPs don't accumulate forever.
 */

interface WindowCounter {
  windowStart: number;
  count: number;
}

interface LockoutState {
  fails: number;
  lockedUntil: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCKOUT_BASE_MS = MINUTE_MS;
const LOCKOUT_CAP_MS = 60 * MINUTE_MS;
const LOCKOUT_THRESHOLD = 5;

export class AuthThrottle {
  private readonly loginByIp = new Map<string, WindowCounter>();
  private readonly registerByIp = new Map<string, WindowCounter>();
  private readonly lockoutByAccount = new Map<string, LockoutState>();
  private lastPruneAt = Date.now();

  /** True when this IP may attempt a login right now (counts the attempt). */
  allowLoginAttempt(ip: string, now = Date.now()): boolean {
    this.pruneIfDue(now);
    return this.countWindow(this.loginByIp, ip, now, MINUTE_MS, 10);
  }

  /** True when this IP may register another account today (counts it). */
  allowRegistration(ip: string, now = Date.now()): boolean {
    this.pruneIfDue(now);
    return this.countWindow(this.registerByIp, ip, now, DAY_MS, 3);
  }

  /** Milliseconds until the account may try again; 0 = not locked. */
  lockoutRemainingMs(accountKey: string, now = Date.now()): number {
    const state = this.lockoutByAccount.get(accountKey.toLowerCase());
    if (!state) return 0;
    return Math.max(0, state.lockedUntil - now);
  }

  recordLoginFailure(accountKey: string, now = Date.now()): void {
    const key = accountKey.toLowerCase();
    const state = this.lockoutByAccount.get(key) ?? { fails: 0, lockedUntil: 0 };
    state.fails++;
    if (state.fails >= LOCKOUT_THRESHOLD) {
      const exponent = state.fails - LOCKOUT_THRESHOLD;
      const duration = Math.min(LOCKOUT_BASE_MS * 2 ** exponent, LOCKOUT_CAP_MS);
      state.lockedUntil = now + duration;
    }
    this.lockoutByAccount.set(key, state);
  }

  recordLoginSuccess(accountKey: string): void {
    this.lockoutByAccount.delete(accountKey.toLowerCase());
  }

  private countWindow(
    map: Map<string, WindowCounter>,
    key: string,
    now: number,
    windowMs: number,
    limit: number,
  ): boolean {
    const entry = map.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      map.set(key, { windowStart: now, count: 1 });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count++;
    return true;
  }

  private pruneIfDue(now: number): void {
    if (now - this.lastPruneAt < 10 * MINUTE_MS) return;
    this.lastPruneAt = now;
    for (const [key, entry] of this.loginByIp) {
      if (now - entry.windowStart >= MINUTE_MS) this.loginByIp.delete(key);
    }
    for (const [key, entry] of this.registerByIp) {
      if (now - entry.windowStart >= DAY_MS) this.registerByIp.delete(key);
    }
    for (const [key, state] of this.lockoutByAccount) {
      if (state.lockedUntil !== 0 && state.lockedUntil < now) this.lockoutByAccount.delete(key);
    }
  }
}
