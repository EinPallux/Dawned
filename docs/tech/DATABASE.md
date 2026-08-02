# Dawned — Database Design (PostgreSQL 16 + Drizzle)

> One database, two writers (game server, admin server), schema defined once in
> `@dawned/shared/src/schema` (Drizzle) so both repos compile against identical types.
> Migrations via drizzle-kit, applied by UPDATE.sh (see DEPLOYMENT.md). Conventions:
> snake_case tables, `id` PKs, `created_at/updated_at` timestamptz defaults, FKs ON DELETE
> RESTRICT unless noted, integers for money/xp, JSONB only where rows are truly document-shaped.

## 1. Domain Split

| Group                                                 | Written by                                                                              | Nature                     |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------- |
| **Account & character data** (`accounts…character_*`) | game server (admin: audited edits)                                                      | live gameplay truth        |
| **Content** (`content_*`)                             | admin server (drafts + publishes); game server read-only                                | versioned game definitions |
| **World baked artifacts**                             | admin bake pipeline (files under `/var/lib/dawned/published/`), PG holds versions/index | terrain, walkgrid, bundles |
| **Ops** (`audit_log`, `bans`, `metrics_snapshots`)    | both (append-only)                                                                      | operations trail           |

## 2. Account & Character Tables

```
accounts            id BIGSERIAL · name CITEXT UNIQUE (3–20 [a-z0-9_]) · pass_hash TEXT (argon2id)
                    role TEXT CHECK ('player','gm','admin') DEFAULT 'player'
                    status TEXT ('active','banned') · created_ip INET · last_login_at/ip · created_at
sessions            id UUID · account_id FK · token_hash BYTEA (sha256 of opaque token) · kind ('game','admin')
                    expires_at · created_ip · last_seen_at        [expired rows purged daily]
bans                id · account_id FK · by_account FK · reason TEXT · until TIMESTAMPTZ NULL(=perm) · lifted_at NULL
characters          id BIGSERIAL · account_id FK (max 5 alive per account, partial unique idx on deleted_at NULL count via trigger-less app check)
                    name CITEXT UNIQUE (2–16, letters + one space) · class TEXT ('warrior','mage','rogue','cleric')
                    body TEXT ('m','f') · skin SMALLINT · outfit TEXT · hair TEXT · hair_color SMALLINT · beard/eyebrows SMALLINT
                    level SMALLINT DEFAULT 1 · xp INTEGER DEFAULT 0 · gold INTEGER DEFAULT 25 CHECK >=0
                    stat_str/agi/int/vit/end SMALLINT (allocated points) · unspent_stat_points SMALLINT · unspent_skill_points SMALLINT
                    pos_x/pos_y/pos_z REAL · yaw REAL · zone_id TEXT · bound_shrine TEXT
                    hp INTEGER · resource INTEGER · playtime_seconds INTEGER · deleted_at NULL (soft delete, name freed via suffix on delete)
character_skills    character_id FK · node_id TEXT (content ref) · ranks SMALLINT          PK(char,node)
character_items     id BIGSERIAL · character_id FK · item_id TEXT (content ref) · container ('inventory','equipment')
                    slot SMALLINT (grid index / equip slot enum) · qty INTEGER CHECK >0
                    rolled_stats JSONB NULL ({str:2,...} for rolled gear) · granted_by TEXT NULL (GM tag)
                    UNIQUE(character_id, container, slot)
character_professions character_id · profession ('wood','mine','herb','fish') · level SMALLINT · xp INTEGER   PK(char,prof)
character_quests    character_id · quest_id TEXT · state ('active','done') · step SMALLINT · counters INTEGER[] · updated_at   PK(char,quest)
character_discoveries character_id · kind ('zone','poi','shrine','codex','fish','herb',...) · ref_id TEXT · at   PK(char,kind,ref)
character_cooldowns character_id · ability_id TEXT · ready_at TIMESTAMPTZ   [long CDs only (ults, potions) — GCD-scale lives in memory]
character_titles    character_id · title_id TEXT · earned_at   PK(char,title)
```

Write patterns: gameplay-critical mutations (items, gold, xp/level, quests) are **write-through
transactions** with row locks (`SELECT … FOR UPDATE` on character) — a kill-reward applies xp+gold+
loot atomically. Position/vitals are **write-behind** (10 s flush + logout). Inventory moves are
single-statement upserts within a transaction to make dupes structurally impossible (SECURITY.md).

## 3. Content Tables (authored in Dawned-Admin)

Pattern: every content table has `id TEXT PK` (slug), `data` as **typed columns for hot fields** +
`extra JSONB` for cold config, plus `status ('draft','published')`, `updated_by`, `updated_at`.
Publishing copies validated drafts into the **published snapshot** (`content_publishes` +
immutable JSON bundle on disk) — the game server never reads drafts.

```
content_items        id · name · category · slot · rarity · ilvl · class_lock · stack · value ·
                     icon TEXT (icon id) · model_ref TEXT NULL · stats JSONB · effect JSONB NULL · flavor TEXT
content_abilities    id · class · slot_index · numbers per COMBAT.md §4 as columns (cost, cooldown_ms, cast_ms, range, shape params) · effects JSONB · anim/vfx/sfx refs
content_skill_nodes  id · class · branch · tier · max_ranks · effect JSONB · requires TEXT NULL
content_enemies      id · name · archetype · level_min/max · rank · model_ref · scale · stats overrides JSONB ·
                     abilities JSONB (weighted list) · loot_table_id FK · xp_mult · gold_min/max · aggro_radius · leash_radius · social_tag
content_npcs         id · name · title · model_ref · role ('vendor','quest','trainer','villager','hermit') ·
                     vendor_id NULL · dialogue JSONB · routine JSONB (waypoints+idles)
content_loot_tables  id · name          content_loot_entries: table_id · ref_kind ('item','table','gold') · ref_id · weight · min_qty · max_qty · conditions JSONB
content_vendors      id · name · buy_mult · sell_mult     content_vendor_items: vendor_id · item_id · price_override NULL · stock ('inf' 0.1.0) · barter JSONB NULL
content_quests       id · name · zone_id · suggested_level · giver JSONB · prerequisites JSONB · journal TEXT
content_quest_steps  quest_id · idx · type · params JSONB · tracker_text · hint_circle JSONB NULL · hooks JSONB
content_zones        id · name · level_min/max · polygon JSONB · ambience JSONB (fog/light/music/sfx/weather weights) · safe BOOLEAN · settlement TEXT NULL
content_pois         id · zone_id · kind · name · pos · discover_radius · xp_bp · icon
content_interactables id · kind ('chest','shrine','campfire','sign','portal','quest_prop',…) · zone_id · pos/rot ·
                     params JSONB (loot_table, respawn_s, text…)
content_resource_nodes id (placement id) · profession · tier · zone_id · pos · respawn_s · loot_table_id
content_spawners     id · zone_id · kind ('point','area') · pos/radius · entries JSONB (enemyId+weight+count) ·
                     respawn_s · rank_override · patrol JSONB NULL · camp_tag NULL · active_window NULL
content_xp_curve     level PK · xp_to_next            content_world_settings: key PK · value JSONB (xpRate, dayNight, motd…)
content_map_chunks   cx · cy · version · heightmap BYTEA (65×65 f32 LE) · splat BYTEA (2×RGBA 32×32 px per-layer weights) ·
                     water_level REAL NULL · PK(cx,cy,version)
content_placements   id BIGSERIAL · chunk cx,cy · asset_ref TEXT · pos/rot/scale · variant JSONB · layer ('props','foliage'…)  [map editor prop layer; foliage stored as scatter params not instances where possible]
content_publishes    version SERIAL · published_by · published_at · notes · bundle_hash · map_version ·
                     state ('active','superseded')
```

Referential integrity for content is enforced at **publish time** by the validator (zod +
cross-ref checks: every loot ref exists, every spawner enemy exists, every quest giver exists…),
not by FKs across draft tables (drafts may be temporarily dangling while editing — the validator
is the gate, and the game only ever sees validated snapshots).

## 4. Ops Tables

```
audit_log        id · actor_account FK · surface ('gm','admin') · action TEXT · args JSONB · target TEXT NULL ·
                 result TEXT · pos JSONB NULL · at TIMESTAMPTZ    [append-only; admin UI filters]
chat_log         id · channel · from_character · to_character NULL · text · at   [7-day retention purge]
metrics_snapshots at · tick_p50/p95 REAL · entities INT · players INT · net_out_kbps REAL · rss_mb INT  [1/min, 14-day retention]
```

## 5. Migrations & Environments

- `drizzle-kit generate` produces SQL migrations committed to the repo (`packages/shared/drizzle/`);
  `UPDATE.sh` runs `drizzle-kit migrate` before restarting services (additive-first policy:
  destructive migrations require a manual flag + backup check).
- Local dev: dockerless Postgres via system package or `postgres` npm-run helper; seed script
  (`pnpm seed`) loads the shipped content snapshot + a dev account (`dev/dev`, admin role) + test
  characters.
- The shipped world (terrain, spawns, content) is itself a committed **seed publish** —
  `pnpm seed` gives any fresh machine the full game. This is also the disaster-recovery floor.

## 6. Backup & Retention (details in DEPLOYMENT.md)

Nightly `pg_dump` (custom format) + `/var/lib/dawned/published/` tarball, 14 daily + 8 weekly
rotations, `BACKUP.sh --verify` restores latest into a scratch DB monthly (drill). Purge jobs:
sessions (daily), chat_log (7 d), metrics (14 d) — via pg_cron-free systemd timer calling a
maintenance script (fewer moving parts than pg_cron).

## 7. Sizing Reality Check

20 players × (1 char row + ~150 item rows + ~60 quest/discovery rows) ≈ trivial; content ≈ tens of
thousands of small rows + map chunks (1024 × ~25 kB ≈ 25 MB per map version, keep last 5). Postgres
tuned to shared_buffers 256 MB, work_mem 8 MB, max_connections 40 (pooled: game 10, admin 10). The
database is never the bottleneck at this scale — the design optimizes for _integrity and editability_.
