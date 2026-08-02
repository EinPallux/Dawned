/**
 * Integration tests for the auth + character stack against a REAL PostgreSQL
 * (docs/tech/SECURITY.md §7-P1 gate). Skipped with a loud warning when no
 * database is reachable; CI provides one as a service container.
 *
 * Rows created here are namespaced (zz_test_*) and removed afterwards.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { DEFAULT_APPEARANCE, MAX_CHARACTERS_PER_ACCOUNT } from '@dawned/shared';
import { createDb, type DbHandle } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { AuthService } from './service.js';
import { CharacterService } from '../characters/service.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://dawned:dawned@127.0.0.1:5432/dawned';

const PREFIX = 'zz_test_';
const uniqueName = (base: string): string =>
  `${PREFIX}${base}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`.slice(
    0,
    20,
  );

let handle: DbHandle | null = null;
let reachable = false;

beforeAll(async () => {
  try {
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    await handle.pool.query('SELECT 1');
    reachable = true;
  } catch (error) {
    console.warn(
      `⚠️  auth integration tests SKIPPED — no PostgreSQL at ${DATABASE_URL} (${(error as Error).message})`,
    );
  }
}, 30_000);

afterAll(async () => {
  if (handle && reachable) {
    await handle.db.execute(sql`DELETE FROM accounts WHERE name::text LIKE ${`${PREFIX}%`}`);
    await handle.close();
  }
});

describe('auth + characters (integration)', () => {
  it('register → login → session → characters → delete, end to end', async ({ skip }) => {
    if (!reachable) return skip();
    const auth = new AuthService(handle!.db, undefined);
    const characters = new CharacterService(handle!.db);
    const name = uniqueName('flow');

    // Register (auto-login).
    const registered = await auth.register(name, 'correct horse battery', '10.0.0.1');
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(registered.value.token).toMatch(/^[0-9a-f]{32}$/);
    expect(registered.value.account.role).toBe('player');

    // Same name (case-insensitively) is taken.
    const dupe = await auth.register(name.toUpperCase(), 'irrelevant pass', '10.0.0.1');
    expect(dupe.ok).toBe(false);
    if (!dupe.ok) expect(dupe.code).toBe('name_taken');

    // Login with wrong then right password.
    const wrong = await auth.login(name, 'wrong password', '10.0.0.2');
    expect(wrong.ok).toBe(false);
    const login = await auth.login(name, 'correct horse battery', '10.0.0.2');
    expect(login.ok).toBe(true);
    if (!login.ok) return;

    // Session validates and resolves the account.
    const account = await auth.validateSession(login.value.token);
    expect(account?.name.toLowerCase()).toBe(name.toLowerCase());
    expect(await auth.validateSession('0'.repeat(32))).toBeNull();
    expect(await auth.validateSession('not-a-token')).toBeNull();

    // Characters: create, list, duplicate name, delete frees the name.
    const charName = uniqueName('hero')
      .replace(/[^A-Za-z]/g, 'a')
      .slice(0, 12);
    const created = await characters.create(account!.id, {
      name: charName,
      classId: 'warrior',
      appearance: DEFAULT_APPEARANCE,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.classId).toBe('warrior');
    expect(created.value.level).toBe(1);

    const conflict = await characters.create(account!.id, {
      name: charName.toUpperCase(),
      classId: 'mage',
      appearance: DEFAULT_APPEARANCE,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe('name_taken');

    const listed = await characters.list(account!.id);
    expect(listed).toHaveLength(1);
    expect(await characters.getOwned(account!.id, created.value.id)).not.toBeNull();
    expect(await characters.getOwned(account!.id + 999_999, created.value.id)).toBeNull();

    const deleted = await characters.softDelete(account!.id, created.value.id);
    expect(deleted.ok).toBe(true);
    expect(await characters.list(account!.id)).toHaveLength(0);
    expect(await characters.getOwned(account!.id, created.value.id)).toBeNull();

    // The freed name is usable again immediately.
    const recreated = await characters.create(account!.id, {
      name: charName,
      classId: 'cleric',
      appearance: DEFAULT_APPEARANCE,
    });
    expect(recreated.ok).toBe(true);

    // Logout kills the session.
    await auth.logout(login.value.token);
    expect(await auth.validateSession(login.value.token)).toBeNull();
  }, 60_000);

  it('rejects invalid names, weak passwords and reserved names', async ({ skip }) => {
    if (!reachable) return skip();
    const auth = new AuthService(handle!.db, undefined);
    expect((await auth.register('ab', 'longenoughpass', '10.0.0.3')).ok).toBe(false);
    expect((await auth.register('has spaces', 'longenoughpass', '10.0.0.3')).ok).toBe(false);
    expect((await auth.register('admin', 'longenoughpass', '10.0.0.3')).ok).toBe(false);
    expect((await auth.register(uniqueName('pw'), 'short', '10.0.0.3')).ok).toBe(false);
  });

  it('enforces the invite code only when configured', async ({ skip }) => {
    if (!reachable) return skip();
    const gated = new AuthService(handle!.db, 'sesame');
    const rejected = await gated.register(uniqueName('inv'), 'longenoughpass', '10.0.0.4');
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe('invite_required');
    const accepted = await gated.register(
      uniqueName('inv'),
      'longenoughpass',
      '10.0.0.4',
      'sesame',
    );
    expect(accepted.ok).toBe(true);
  });

  it('locks an account after repeated failures and clears on success', async ({ skip }) => {
    if (!reachable) return skip();
    const auth = new AuthService(handle!.db, undefined);
    const name = uniqueName('lock');
    const registered = await auth.register(name, 'the right password', '10.0.1.1');
    expect(registered.ok).toBe(true);

    // 5 failures trip the lockout (each from a fresh IP to isolate the per-account rule).
    for (let i = 0; i < 5; i++) {
      const result = await auth.login(name, 'wrong', `10.0.2.${i}`);
      expect(result.ok).toBe(false);
    }
    const locked = await auth.login(name, 'the right password', '10.0.3.1');
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.code).toBe('locked_out');

    // Manually expire the lockout and confirm success clears the state.
    auth.throttle.recordLoginSuccess(name);
    const recovered = await auth.login(name, 'the right password', '10.0.3.2');
    expect(recovered.ok).toBe(true);
  }, 60_000);

  it('caps character slots at the shared maximum', async ({ skip }) => {
    if (!reachable) return skip();
    const auth = new AuthService(handle!.db, undefined);
    const characters = new CharacterService(handle!.db);
    const registered = await auth.register(uniqueName('slots'), 'longenoughpass', '10.0.4.1');
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const accountId = registered.value.account.id;

    for (let i = 0; i < MAX_CHARACTERS_PER_ACCOUNT; i++) {
      const result = await characters.create(accountId, {
        name: `Slot${'abcde'[i]!.repeat(3)}${Date.now().toString(36).slice(-4)}`.replace(
          /[^A-Za-z]/g,
          'x',
        ),
        classId: 'rogue',
        appearance: DEFAULT_APPEARANCE,
      });
      expect(result.ok).toBe(true);
    }
    const overflow = await characters.create(accountId, {
      name: 'Overflow',
      classId: 'rogue',
      appearance: DEFAULT_APPEARANCE,
    });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.code).toBe('slots_full');
  }, 120_000);
});
