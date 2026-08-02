/**
 * Account + session service (docs/tech/SECURITY.md §1).
 *
 * Every public method returns a typed result instead of throwing for expected
 * failures — routes translate results into HTTP codes, and the gateway into
 * notice codes. Unexpected DB errors still throw.
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { accounts, bans, sessions, type AccountRow } from '@dawned/shared/schema';
import { accountNameSchema, passwordSchema, type AccountInfo } from '@dawned/shared';
import { isUniqueViolation, type Db } from '../db/client.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { AuthThrottle } from './rate-limit.js';

/** Game sessions: 30 days sliding (SECURITY.md §1). */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Bump last_seen/expiry at most this often — not on every request. */
const SESSION_TOUCH_INTERVAL_MS = 10 * 60 * 1000;

export type AuthResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code:
        | 'invalid_name'
        | 'invalid_password'
        | 'name_taken'
        | 'invalid_credentials'
        | 'rate_limited'
        | 'locked_out'
        | 'banned'
        | 'invite_required';
      message: string;
      retryAfterMs?: number;
    };

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

const toAccountInfo = (row: AccountRow): AccountInfo => ({
  id: row.id,
  name: row.name,
  role: row.role,
});

export class AuthService {
  readonly throttle = new AuthThrottle();

  constructor(
    private readonly db: Db,
    private readonly inviteCode: string | undefined,
  ) {}

  async register(
    name: string,
    password: string,
    ip: string,
    inviteCode?: string,
  ): Promise<AuthResult<{ token: string; account: AccountInfo }>> {
    const nameCheck = accountNameSchema.safeParse(name);
    if (!nameCheck.success) {
      return fail('invalid_name', nameCheck.error.issues[0]?.message ?? 'Invalid name.');
    }
    const passwordCheck = passwordSchema.safeParse(password);
    if (!passwordCheck.success) {
      return fail(
        'invalid_password',
        passwordCheck.error.issues[0]?.message ?? 'Invalid password.',
      );
    }
    if (this.inviteCode && inviteCode !== this.inviteCode) {
      return fail('invite_required', 'This server requires an invite code.');
    }
    if (!this.throttle.allowRegistration(ip)) {
      return fail('rate_limited', 'Too many new accounts from this address today.');
    }

    const passHash = await hashPassword(password);
    try {
      const [row] = await this.db
        .insert(accounts)
        .values({ name, passHash, createdIp: ip })
        .returning();
      const token = await this.createSession(row!.id, ip);
      return { ok: true, value: { token, account: toAccountInfo(row!) } };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return fail('name_taken', 'That account name is already taken.');
      }
      throw error;
    }
  }

  async login(
    name: string,
    password: string,
    ip: string,
  ): Promise<AuthResult<{ token: string; account: AccountInfo }>> {
    if (!this.throttle.allowLoginAttempt(ip)) {
      return fail('rate_limited', 'Too many login attempts — wait a minute.');
    }
    const lockedMs = this.throttle.lockoutRemainingMs(name);
    if (lockedMs > 0) {
      return {
        ok: false,
        code: 'locked_out',
        message: `Too many failed logins — try again in ${Math.ceil(lockedMs / 1000)} s.`,
        retryAfterMs: lockedMs,
      };
    }

    const row = await this.db.query.accounts.findFirst({ where: eq(accounts.name, name) });
    // Identical error for unknown name and wrong password (SECURITY.md §1) —
    // and we still burn a verify on unknown names so timing doesn't leak either.
    const valid = row
      ? await verifyPassword(row.passHash, password)
      : await verifyPassword(DUMMY_HASH, password).then(() => false);
    if (!row || !valid) {
      this.throttle.recordLoginFailure(name);
      return fail('invalid_credentials', 'Wrong account name or password.');
    }

    const ban = await this.activeBan(row.id);
    if (ban) {
      return fail(
        'banned',
        ban.until
          ? `This account is banned until ${ban.until.toISOString().slice(0, 16).replace('T', ' ')} UTC. Reason: ${ban.reason || 'unspecified'}.`
          : `This account is permanently banned. Reason: ${ban.reason || 'unspecified'}.`,
      );
    }

    this.throttle.recordLoginSuccess(name);
    await this.db
      .update(accounts)
      .set({ lastLoginAt: new Date(), lastLoginIp: ip })
      .where(eq(accounts.id, row.id));
    const token = await this.createSession(row.id, ip);
    return { ok: true, value: { token, account: toAccountInfo(row) } };
  }

  /** Resolve a bearer/Hello token to its account; null = invalid/expired/banned. */
  async validateSession(token: string): Promise<AccountRow | null> {
    if (!/^[0-9a-f]{32}$/.test(token)) return null;
    const tokenHash = sha256Hex(token);
    const now = new Date();
    const session = await this.db.query.sessions.findFirst({
      where: and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)),
    });
    if (!session) return null;

    const account = await this.db.query.accounts.findFirst({
      where: eq(accounts.id, session.accountId),
    });
    if (!account || account.status !== 'active') return null;
    if (await this.activeBan(account.id)) return null;

    // Sliding expiry, throttled to one write per 10 minutes per session.
    if (now.getTime() - session.lastSeenAt.getTime() > SESSION_TOUCH_INTERVAL_MS) {
      await this.db
        .update(sessions)
        .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
        .where(eq(sessions.id, session.id));
    }
    return account;
  }

  async logout(token: string): Promise<void> {
    if (!/^[0-9a-f]{32}$/.test(token)) return;
    await this.db.delete(sessions).where(eq(sessions.tokenHash, sha256Hex(token)));
  }

  /** Hourly housekeeping: drop expired sessions (index-assisted). */
  async purgeExpiredSessions(): Promise<number> {
    const result = await this.db
      .delete(sessions)
      .where(sql`${sessions.expiresAt} < now()`)
      .returning({ id: sessions.id });
    return result.length;
  }

  private async createSession(accountId: number, ip: string): Promise<string> {
    const token = randomBytes(16).toString('hex'); // 128-bit opaque token
    await this.db.insert(sessions).values({
      accountId,
      tokenHash: sha256Hex(token),
      kind: 'game',
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      createdIp: ip,
    });
    return token;
  }

  private async activeBan(accountId: number) {
    return this.db.query.bans.findFirst({
      where: and(
        eq(bans.accountId, accountId),
        isNull(bans.liftedAt),
        or(isNull(bans.until), gt(bans.until, new Date())),
      ),
    });
  }
}

const fail = (
  code: Extract<AuthResult<never>, { ok: false }>['code'],
  message: string,
): AuthResult<never> => ({ ok: false, code, message });

/** Valid argon2id hash of an unguessable value — burned on unknown-name logins. */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$ZHVtbXktc2FsdC1kYXduZWQ$K6skC0TZL8sIsIVU9DdrZ+wcz/CyaJ0FxSk3qBLgU2Q';
