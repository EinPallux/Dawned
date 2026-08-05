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
  unique,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** Case-insensitive text (PostgreSQL citext — trusted extension, created in migration 0000). */
const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

/**
 * Raw bytes (A2 map drafts). Height fields and splat maps are binary artifacts
 * — storing them as base64 text would cost a third more space and an encode on
 * every autosave, and the editor autosaves constantly.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
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

/**
 * Allocated skill-tree ranks (DATABASE.md §2, P7). One row per node a
 * character has points in; `nodeId` references `content_skill_nodes` slugs
 * (content refs are validated at allocation time, not by FK — content rows
 * live on the draft/published axis). Respec deletes the character's rows.
 */
export const characterSkills = pgTable(
  'character_skills',
  {
    characterId: bigint('character_id', { mode: 'number' })
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    ranks: smallint('ranks').notNull().default(1),
  },
  (table) => [primaryKey({ columns: [table.characterId, table.nodeId] })],
);

/**
 * First-time discoveries (DATABASE.md §2, P7): zone entries now, POIs/
 * shrines/codex entries as their phases land. The primary key IS the
 * dedupe — discovery XP can never double-pay.
 */
export const characterDiscoveries = pgTable(
  'character_discoveries',
  {
    characterId: bigint('character_id', { mode: 'number' })
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['zone', 'poi', 'shrine', 'codex'] }).notNull(),
    refId: text('ref_id').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.characterId, table.kind, table.refId] })],
);

/**
 * Owned items (DATABASE.md §2, P8). One row per stack, addressed by the cell
 * it sits in: `container` says bag or paper-doll, `slot` is the grid index
 * (0..47) or the equip-slot index (EQUIP_SLOTS order). The UNIQUE(character,
 * container, slot) constraint is the structural half of the dupe defence —
 * two stacks can never claim one cell, whatever a racing client sends.
 */
export const characterItems = pgTable(
  'character_items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    characterId: bigint('character_id', { mode: 'number' })
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    /** Content ref (`item_weapon_sword_dawnsteel`). */
    itemId: text('item_id').notNull(),
    container: text('container', { enum: ['inventory', 'equipment'] }).notNull(),
    slot: smallint('slot').notNull(),
    qty: integer('qty').notNull().default(1),
    /** Rolled attributes for gear ({str:2,…}); null for stackables. */
    rolledStats: jsonb('rolled_stats'),
    /** GM/system tag for granted items (audit trail). */
    grantedBy: text('granted_by'),
  },
  (table) => [
    unique('character_items_cell_uq').on(table.characterId, table.container, table.slot),
    index('character_items_character_idx').on(table.characterId),
  ],
);

/** Item definitions (ITEMS_LOOT.md) — authored in Dawned-Admin (P8). */
export const contentItems = pgTable(
  'content_items',
  {
    /** Content slug (`item_weapon_sword_dawnsteel`). */
    id: text('id').notNull(),
    status: text('status', { enum: ['draft', 'published'] }).notNull(),
    /** ItemDef (shared/src/content/items.ts). */
    def: jsonb('def').notNull(),
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => accounts.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id, table.status] })],
);

/** Loot tables (ITEMS_LOOT.md §4) — nested, weighted drop pools (P8). */
export const contentLootTables = pgTable(
  'content_loot_tables',
  {
    id: text('id').notNull(),
    status: text('status', { enum: ['draft', 'published'] }).notNull(),
    /** LootTableDef (shared/src/content/loot.ts). */
    def: jsonb('def').notNull(),
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => accounts.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id, table.status] })],
);

/** Vendors (ITEMS_LOOT.md §6) — stock, multiples, world anchor (P8). */
export const contentVendors = pgTable(
  'content_vendors',
  {
    id: text('id').notNull(),
    status: text('status', { enum: ['draft', 'published'] }).notNull(),
    /** VendorDef (shared/src/content/vendors.ts). */
    def: jsonb('def').notNull(),
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => accounts.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id, table.status] })],
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

export const contentAbilities = pgTable(
  'content_abilities',
  {
    /** Content slug (`ability_warrior_crushing_blow`). */
    id: text('id').notNull(),
    status: text('status', { enum: ['draft', 'published'] }).notNull(),
    /** AbilityDef (shared/src/content/abilities.ts). */
    def: jsonb('def').notNull(),
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => accounts.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id, table.status] })],
);

/**
 * XP curve rows (P7): one row per level, def = { level, xpToNext } validated
 * by shared/src/content/xp-curve.ts. Publish cross-checks completeness
 * (levels 1..29 exactly once) the same way abilities cross-check slots.
 */
export const contentXpCurve = pgTable(
  'content_xp_curve',
  {
    /** Content slug (`xp_l01`..`xp_l29`). */
    id: text('id').notNull(),
    status: text('status', { enum: ['draft', 'published'] }).notNull(),
    /** XpCurveEntry (shared/src/content/xp-curve.ts). */
    def: jsonb('def').notNull(),
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => accounts.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id, table.status] })],
);

/**
 * Skill-tree nodes (P7): one row per node (96 in 0.1.0), def validated by
 * shared/src/content/skill-nodes.ts — branch/tier/ranks plus the per-rank
 * effect lists the server folds into stats/abilities.
 */
export const contentSkillNodes = pgTable(
  'content_skill_nodes',
  {
    /** Content slug (`node_warrior_bulwark_toughened`). */
    id: text('id').notNull(),
    status: text('status', { enum: ['draft', 'published'] }).notNull(),
    /** SkillNodeDef (shared/src/content/skill-nodes.ts). */
    def: jsonb('def').notNull(),
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => accounts.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id, table.status] })],
);

// ---------------------------------------------------------------------------
// Map editor drafts (A2/A3 — docs/MAP_EDITOR.md)
// ---------------------------------------------------------------------------

/**
 * One draft terrain chunk. Chunk-granular on purpose: the editor autosaves 2 s
 * after a stroke settles and a stroke usually touches one to four chunks, so
 * saving is a handful of ~25 kB upserts rather than a whole-map write.
 *
 * `heights` and `splat` hold exactly the bytes `encodeChunk` would emit for
 * those fields, so publishing is a copy, not a conversion — nothing can be lost
 * in translation between what was painted and what ships.
 */
export const mapDraftChunks = pgTable(
  'map_draft_chunks',
  {
    cx: smallint('cx').notNull(),
    cy: smallint('cy').notNull(),
    /** 65×65 little-endian f32 heights. */
    heights: bytea('heights').notNull(),
    /** Two RGBA 32×32 splat weight maps. */
    splat: bytea('splat').notNull(),
    /** Per-chunk water surface, or null for "sea level only". */
    waterLevel: real('water_level'),
    /** False = ocean chunk: not emitted at bake, costs the client nothing. */
    enabled: boolean('enabled').notNull().default(true),
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => accounts.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.cx, table.cy] })],
);

/**
 * Everything that stands ON the terrain, one row per authored thing. Kept as
 * rows rather than one blob so the editor can save a single moved rock without
 * rewriting the world, and so "clear all props in this zone" is a DELETE.
 */
export const mapDraftObjects = pgTable(
  'map_draft_objects',
  {
    id: text('id').primaryKey(),
    /** Which editor layer owns it — also what "Clear layer…" filters on. */
    layer: text('layer', {
      enum: ['prop', 'scatter', 'spawner', 'node', 'npc', 'zone', 'poi', 'interactable'],
    }).notNull(),
    /** Row payload, validated by that layer's zod schema in shared. */
    def: jsonb('def').notNull(),
    /** Denormalised for fast viewport/region queries; null for zone polygons. */
    x: real('x'),
    z: real('z'),
    /** Owning chunk, so the editor can stream objects with the terrain. */
    cx: smallint('cx'),
    cy: smallint('cy'),
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => accounts.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('map_draft_objects_layer_idx').on(table.layer),
    index('map_draft_objects_chunk_idx').on(table.cx, table.cy),
  ],
);

/**
 * Named restore points ("before redoing Dawnhaven harbor"). A checkpoint is a
 * full snapshot of the draft, compressed into one row — the map is ~25 MB of
 * chunks at worst and checkpoints are rare, so simplicity beats cleverness.
 */
export const mapCheckpoints = pgTable('map_checkpoints', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull(),
  /** gzipped JSON: { chunks: [...], objects: [...] }. */
  payload: bytea('payload').notNull(),
  chunkCount: integer('chunk_count').notNull(),
  objectCount: integer('object_count').notNull(),
  createdBy: bigint('created_by', { mode: 'number' }).references(() => accounts.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Editor-side collections (Dawned-Admin MAP_EDITOR.md §2.2, §3) — named
 * selections and stampable prefabs.
 *
 * Nothing here reaches the game: a prefab flattens to plain placements the
 * moment it is stamped, and a selection is pure UI. They are in Postgres rather
 * than the browser because they are shared between the owner and any GM, and
 * because months of collected prefabs must not die with a cache clear.
 */
export const mapEditorCollections = pgTable(
  'map_editor_collections',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['selection', 'prefab'] }).notNull(),
    name: text('name').notNull(),
    /** Shape depends on `kind`; the panel validates it with zod on both sides. */
    data: jsonb('data').notNull(),
    createdBy: bigint('created_by', { mode: 'number' }).references(() => accounts.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('map_editor_collections_kind_idx').on(table.kind)],
);

/**
 * Single-writer lock (MAP_EDITOR.md §3). It is a friends team, so this is a
 * lease with a heartbeat rather than anything clever: one row, whoever holds it
 * edits, everyone else gets read-only and a "request takeover" button.
 */
export const mapLock = pgTable('map_lock', {
  /** Always 1 — a one-row table, enforced by the primary key. */
  id: smallint('id').primaryKey(),
  holderAccountId: bigint('holder_account_id', { mode: 'number' })
    .notNull()
    .references(() => accounts.id),
  holderName: text('holder_name').notNull(),
  /** Lease expiry; a browser that dies simply stops renewing. */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** Set by another user's "request takeover" — the holder sees it and can yield. */
  takeoverRequestedBy: text('takeover_requested_by'),
});

/** Published map versions — what the game is serving and what it came from. */
export const mapVersions = pgTable('map_versions', {
  version: text('version').primaryKey(),
  /** Bake summary: counts, timings, warnings. */
  summary: jsonb('summary').notNull(),
  publishedBy: bigint('published_by', { mode: 'number' }).references(() => accounts.id),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AccountRow = typeof accounts.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type CharacterRow = typeof characters.$inferSelect;
export type BanRow = typeof bans.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type ContentWorldSettingsRow = typeof contentWorldSettings.$inferSelect;
export type ContentEnemyRow = typeof contentEnemies.$inferSelect;
export type ContentSpawnerRow = typeof contentSpawners.$inferSelect;
export type ContentAbilityRow = typeof contentAbilities.$inferSelect;
export type CharacterSkillRow = typeof characterSkills.$inferSelect;
export type CharacterDiscoveryRow = typeof characterDiscoveries.$inferSelect;
export type ContentXpCurveRow = typeof contentXpCurve.$inferSelect;
export type ContentSkillNodeRow = typeof contentSkillNodes.$inferSelect;
export type CharacterItemRow = typeof characterItems.$inferSelect;
export type ContentItemRow = typeof contentItems.$inferSelect;
export type ContentLootTableRow = typeof contentLootTables.$inferSelect;
export type ContentVendorRow = typeof contentVendors.$inferSelect;
