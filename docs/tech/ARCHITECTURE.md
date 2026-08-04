# Dawned — System Architecture

> How the pieces fit: monorepo layout, the game server, the game client, shared packages, the admin
> panel's touchpoints, and the data flows between them. Stack rationale: [TECH_STACK.md](TECH_STACK.md).
> Wire details: [NETWORKING.md](NETWORKING.md). Persistence: [DATABASE.md](DATABASE.md).

## 1. Topology

```mermaid
flowchart LR
  subgraph Browser["Player Browser"]
    C[Game Client<br/>three.js + React overlay]
  end
  subgraph VPS["VPS (Ubuntu 24.04, 4GB/1core)"]
    CADDY[Caddy 2<br/>TLS + static + proxy]
    GS[dawned-game (Node 22)<br/>Fastify REST + ws WSS<br/>20Hz simulation]
    AS[dawned-admin (Node 22)<br/>Fastify + React SPA]
    PG[(PostgreSQL 16)]
    FS[/var/lib/dawned/<br/>published maps, content bundles,<br/>processed assets/]
  end
  ADM[Admin Browser<br/>Dawned-Admin SPA]
  C -- "HTTPS: auth, content bundles, assets" --> CADDY
  C -- "WSS: game protocol" --> CADDY
  ADM -- HTTPS --> CADDY
  CADDY --> GS
  CADDY --> AS
  GS <--> PG
  AS <--> PG
  AS -- "internal HTTP (localhost): live ops,<br/>publish notify, metrics" --> GS
  GS -- reads --> FS
  AS -- writes/bakes --> FS
```

One VPS, two Node processes, one Postgres, one Caddy. The **game server owns the live world**; the
**admin server owns authoring & operations**; they meet in Postgres (persistent data), on the
filesystem (baked/published artifacts), and over a localhost-only ops API.

## 2. Repositories & Monorepo Layout

```
Dawned/                          # this repo — the game
  packages/
    shared/        @dawned/shared  — THE contract package:
      src/protocol/   packet ids, binary codec, enums
      src/formulas/   damage/xp/stat derivations (unit-tested, used by BOTH sides)
      src/schema/     drizzle table defs + zod content schemas (admin repo consumes these)
      src/data/       constant tables (slots, rarities, class ids), typed content-row interfaces
      src/math/       vec/quat/geom helpers (arc tests, swept sphere)
    server/        @dawned/server  — game server (Fastify + ws + systems)
    client/        @dawned/client  — game client (three.js core + React UI)
  tools/           asset pipeline CLIs (convert, manifest, thumbnails, icons, audio)
  deploy/          DEPLOY.sh, UPDATE.sh, BACKUP.sh, ROLLBACK.sh, Caddyfile, systemd units  [Phase 0]
  assets/          raw source packs (git, never served)  → tools bake into client/public + /var/lib/dawned
  docs/            these documents
Dawned-Admin/                    # separate repo — editor & ops panel
  (consumes @dawned/shared via pnpm git dep; see its docs/ARCHITECTURE.md)
```

Rule: **client and server never import each other** — only `@dawned/shared`. Anything both sides
need (a formula, a constant, a packet shape, a content row type) lives in shared or it doesn't exist.

## 3. Game Server (`@dawned/server`) — single process anatomy

```
src/
  index.ts            boot: config → db → content load → world load → fastify+ws → tick loop
  net/                ws session mgmt, packet router, send queues, rate limiting
  http/               fastify routes: /api/auth/*, /api/characters/*, /api/content/*, /ops/* (localhost)
  world/              world state: entity registry, spatial hash grid, zones, chunk residency
  systems/            fixed-order per-tick systems (see loop below)
  ai/                 FSM brains, perception, steering, A* on walkgrid
  combat/             ability pipeline, effect appliers, hit geometry, rewind buffer, threat
  persistence/        drizzle repos, write-behind queues, transactional ops (inventory!)
  content/            content cache: typed maps loaded from PG published tables, hot-reload
  gm/                 command parser+handlers, audit writer
  metrics/            tick/net/entity ring buffers
```

**Main loop (20 Hz fixed tick, `setTimeout`-drift-corrected):**

1. drain & validate client inputs (movement intents, ability requests, interacts)
2. movement integrate + validate (speed/slope/teleport caps) → position history push (rewind buffer 32 ticks)
3. AI decisions (staggered ~1/2 of brains per tick @10 Hz effective) → AI movement
4. ability pipeline: casts advance, resolves fire (lag-rewound geometry), projectiles step, effects/DoTs tick (250 ms cadence)
5. deaths/respawns/loot spawns; interactable & node timers; quest counters
6. AOI/interest update (grid 64 m cells, 3-cell radius) → per-client delta snapshot build → batched send
7. persistence flush queue (dirty characters every 10 s or on important events; transactional ops immediate)
8. metrics sample; next-tick schedule

Persistence philosophy: the world is memory-resident; Postgres is the durable record. Characters
save on: timer, logout, level/quest/item events. Server crash loses ≤10 s of movement, zero item/xp
transactions (those are write-through).

> **As built (P4):** `world.step()` runs 1–5 and returns the tick's combat events; the
> gateway then sends snapshots and **only then** fans the events out through the per-viewer
> interest sets (`broadcastSnapshots` → `broadcastCombatEvents` in `index.ts`). That order is
> load-bearing: events are scoped to each viewer's **current-tick** visible set, so a fresh
> join (empty set until its first snapshot) would silently drop same-tick events — e.g. the
> alert beat of the camp you spawn next to — if events went first. Enemy AI runs at 10 Hz by
> id parity (half the brains per tick); enemy `EnemyMeta` announcements piggyback the
> snapshot path so meta always precedes the first snapshot containing that enemy.
>
> **As built (P7/P8):** the same queue-then-drain shape carries UI-cadence intents.
> Progression clicks (P7) and item ops (P8) are validated at the gateway, queued, and
> applied at the TOP of the next `world.step()` (sections 0b/0c) so their effects and
> events ride the normal flush instead of landing mid-tick. Item ops run the shared
> planner in `world/items.ts`; an equipment change re-prices the worn set and re-folds
> derived stats immediately, so the very next damage roll in the same tick already uses
> the new weapon. Every item outcome — including a refusal — emits `inventory-dirty`,
> which the gateway answers with a full `InventorySync` and a write-through save
> serialized per character (the same `persistChain` pattern progression uses).

**Content cache:** published content (items, enemies, abilities, loot, quests, zones, spawn layers,
walkgrid, node placements) loads at boot from PG + baked files; `/ops/reload-content` (admin-panel
button / `/reloadcontent` GM command) re-loads safely between ticks (never mid-tick), diffing what
changed: stat-only changes apply live; structural map changes flag "applies on restart" back to the
admin caller.

## 4. Game Client (`@dawned/client`) anatomy

```
src/
  core/        boot, screen router (login→select→create→world), settings store, input abstraction
  net/         connection, codec (from shared), prediction/reconciliation, interp buffers, clock sync
  world/       scene mgmt: terrain chunks, water, sky, props, entity views, zone ambience blending
  render/      renderer setup, materials (splat shader, wind shader, water), instancing pools, LOD/cull
  sim/         local player controller (predicted), remote entity interpolators, projectile visuals
  combat/      ability anticipation FX, telegraph decals, floating text pool, hit-stop/camera kick
  anim/        animation state machines (locomotion blend, combat layers, upper-body masks)
  vfx/         particle systems (Kenney sheets), mesh-flash, trails, pooled
  audio/       WebAudio buses, emitters, music/ambience director (zone-driven)
  ui/          React app: HUD + screens (Zustand stores; per-frame values via refs/subscriptions)
  assets/      manifest-driven loader (GLB/meshopt, KTX-free PNG, audio), zone-based prefetch, IndexedDB cache
```

**Frame flow:** input sample → send intent (30 Hz coalesced) → predict local move (same shared
step function the server runs) → reconcile on snapshot (replay unacked inputs; error smoothing
≤80 ms) → interpolate remotes (100 ms buffer) → animate/VFX/audio → render. UI reads via stores
subscribed to sim events, never per-frame React renders (HP bars etc. are ref-driven DOM writes).

**Scene/perf systems:** chunked static batching (props merged per chunk per material),
InstancedMesh pools for foliage/rocks/nodes, frustum + distance culling rings (props 120 m,
entities 100 m, fx 60 m), shadow: single cascaded directional (2 splits) sized to camera, target
budgets per TECH_STACK.md. Player/NPC animation via three AnimationMixer with a shared clip
library (UAL retargeted once at pipeline time, not runtime).

## 5. Admin Panel Touchpoints (contract summary — full spec in Dawned-Admin repo)

- **Same Postgres**, writing only `content_*` draft tables + operational tables it owns; it never
  writes live gameplay rows (characters etc.) except through explicit admin actions logged in audit.
- **Publish pipeline:** draft → validate (zod, referential checks) → version bump → bake artifacts
  (map chunks, walkgrid, minimap/world-map renders, content bundles JSON) into `/var/lib/dawned/published/<version>/`
  → `POST /ops/reload-content` on the game server → server swaps or schedules.
- **Live ops:** proxied through game server ops API (players online, kick/ban/broadcast, metrics) —
  the admin app never touches game memory directly.
- Client fetches `/api/content/bundle?since=<hash>` (immutable, cached) so players get new content
  on next login/zone-load without redeploys.

## 6. Cross-cutting Conventions

- **IDs:** content ids are human string slugs (`enemy_mushroom_king`, `item_weapon_sword_emberbrand`) —
  editor-friendly, greppable, stable. Runtime entity ids are u32 sequence per boot.
- **Time:** server ticks are the clock; client syncs offset via ping/pong (see NETWORKING.md).
  Durations in ms integers everywhere; no floats for money/xp (integers only).
- **Errors:** every rejected client request gets a coded reason (enum in shared) → client toasts a
  friendly string; server logs at debug unless anomalous rate (anti-cheat signal, SECURITY.md).
- **Config:** `.env` per process (validated with zod at boot, fail-fast), defaults committed as
  `.env.example`, real env only on the VPS.
- **Feature flags:** `world_settings` rows (e.g. `xpRate`, `dayNightEnabled`) — hot-reloadable,
  admin-editable, GM-adjustable where marked.
