/**
 * Drizzle schema — the single database definition for the whole project
 * (docs/tech/DATABASE.md). The game server and Dawned-Admin both compile against
 * THIS file; neither may declare tables of its own.
 *
 * Import via the `@dawned/shared/schema` subpath only (server/admin). The main
 * package export stays browser-safe and must never re-export this module.
 *
 * Conventions (DATABASE.md §0): snake_case, timestamptz, integers for money/xp,
 * soft deletes where names must be freed, FKs RESTRICT unless noted.
 */

import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** Case-insensitive text (PostgreSQL citext — trusted extension, created in migration 0000). */
const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

// ---------------------------------------------------------------------------
// Accounts & sessions
// ---------------------------------------------------------------------------

export const accounts = pgTable(
  'accounts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** 3–20 chars [A-Za-z0-9_]; uniqueness is case-insensitive via citext. */
    name: citext('name').notNull(),
    passHash: text('pass_hash').notNull(),
    role: text('role', { enum: ['player', 'gm', 'admin'] })
      .notNull()
      .default('player'),
    status: text('status', { enum: ['active', 'banned'] })
      .notNull()
      .default('active'),
    /** Set by an admin password reset; forces a change on next login (P-later UI). */
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    createdIp: text('created_ip'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    lastLoginIp: text('last_login_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('accounts_name_unique').on(table.name)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountId: bigint('account_id', { mode: 'number' })
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the opaque token — the raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    kind: text('kind', { enum: ['game', 'admin'] })
      .notNull()
      .default('game'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdIp: text('created_ip'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
    index('sessions_account_idx').on(table.accountId),
    index('sessions_expires_idx').on(table.expiresAt),
  ],
);

export const bans = pgTable(
  'bans',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountId: bigint('account_id', { mode: 'number' })
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    byAccountId: bigint('by_account_id', { mode: 'number' }).references(() => accounts.id),
    reason: text('reason').notNull().default(''),
    /** NULL = permanent. */
    until: timestamp('until', { withTimezone: true }),
    liftedAt: timestamp('lifted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('bans_account_idx').on(table.accountId)],
);

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

export const characters = pgTable(
  'characters',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountId: bigint('account_id', { mode: 'number' })
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** 2–16 chars, letters + single spaces; freed on soft delete via `~id` suffix. */
    name: citext('name').notNull(),
    classId: text('class_id', { enum: ['warrior', 'mage', 'rogue', 'cleric'] }).notNull(),

    // Appearance (chosen at creation; armor never changes the look — decided).
    body: text('body', { enum: ['m', 'f'] }).notNull(),
    skin: smallint('skin').notNull().default(0),
    outfit: text('outfit', { enum: ['ranger', 'peasant'] }).notNull(),
    outfitTint: smallint('outfit_tint').notNull().default(0),
    hair: text('hair').notNull().default('none'),
    hairColor: smallint('hair_color').notNull().default(0),
    beard: boolean('beard').notNull().default(false),

    // Progression (P7 consumes; columns are the schema of record from day one).
    level: smallint('level').notNull().default(1),
    xp: integer('xp').notNull().default(0),
    gold: integer('gold').notNull().default(25),
    statStr: smallint('stat_str').notNull().default(0),
    statAgi: smallint('stat_agi').notNull().default(0),
    statInt: smallint('stat_int').notNull().default(0),
    statVit: smallint('stat_vit').notNull().default(0),
    statEnd: smallint('stat_end').notNull().default(0),
    unspentStatPoints: smallint('unspent_stat_points').notNull().default(0),
    unspentSkillPoints: smallint('unspent_skill_points').notNull().default(0),

    // World state (NULL position = never spawned → server picks the spawn ring).
    posX: real('pos_x'),
    posY: real('pos_y'),
    posZ: real('pos_z'),
    yaw: real('yaw').notNull().default(0),
    zoneId: text('zone_id'),
    boundShrine: text('bound_shrine'),
    hp: integer('hp'),
    resource: integer('resource'),

    playtimeSeconds: integer('playtime_seconds').notNull().default(0),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('characters_name_unique').on(table.name),
    index('characters_account_idx').on(table.accountId),
  ],
);

// ---------------------------------------------------------------------------
// Ops trail (DATABASE.md §4) — append-only, written by both servers
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorAccountId: bigint('actor_account_id', { mode: 'number' })
      .notNull()
      .references(() => accounts.id),
    /** Which surface acted: in-game GM command or the admin panel. */
    surface: text('surface', { enum: ['gm', 'admin'] }).notNull(),
    /** Verb slug, e.g. 'auth.login', 'world_settings.save_draft', 'player.ban'. */
    action: text('action').notNull(),
    args: jsonb('args'),
    /** What was acted on (slug/account name/character name), when applicable. */
    target: text('target'),
    result: text('result', { enum: ['ok', 'denied', 'error'] }).notNull(),
    /** World position for in-game GM commands; null from the panel. */
    pos: jsonb('pos'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_log_actor_idx').on(table.actorAccountId),
    index('audit_log_at_idx').on(table.at),
  ],
);

// ---------------------------------------------------------------------------
// Content: world settings (DATABASE.md §3) — the first content table.
// Draft/published is a per-row status: editors write ONLY draft rows; the
// publish pipeline (A1) validates and copies draft → published. The game
// reads published rows exclusively.
// ---------------------------------------------------------------------------

export const contentWorldSettings = pgTable(
  'content_world_settings',
  {
    key: text('key').notNull(),
    status: text('status', { enum: ['draft', 'published'] }).notNull(),
    value: jsonb('value').notNull(),
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => accounts.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.key, table.status] })],
);

// ---------------------------------------------------------------------------
// Content: enemies + spawners (DATABASE.md §3, P4). Same draft/published
// row-status contract as world settings. The definition lives in one `def`
// jsonb validated by the shared zod schemas (content/enemies.ts, spawners.ts)
// at publish time and again at game-server boot — the admin editors (A1)
// generate their forms from those same schemas, so shapes cannot drift.
// ---------------------------------------------------------------------------

export const contentEnemies = pgTable(
  'content_enemies',
  {
    /** Content slug (`enemy_shore_glub`). */
    id: text('id').notNull(),
    status: text('status', { enum: ['draft', 'published'] }).notNull(),
    /** EnemyDef (shared/src/content/enemies.ts). */
    def: jsonb('def').notNull(),
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => accounts.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id, table.status] })],
);

export const contentSpawners = pgTable(
  'content_spawners',
  {
    id: text('id').notNull(),
    status: text('status', { enum: ['draft', 'published'] }).notNull(),
    /** SpawnerDef (shared/src/content/spawners.ts). */
    def: jsonb('def').notNull(),
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => accounts.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id, table.status] })],
);

export type AccountRow = typeof accounts.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type CharacterRow = typeof characters.$inferSelect;
export type BanRow = typeof bans.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type ContentWorldSettingsRow = typeof contentWorldSettings.$inferSelect;
export type ContentEnemyRow = typeof contentEnemies.$inferSelect;
export type ContentSpawnerRow = typeof contentSpawners.$inferSelect;
