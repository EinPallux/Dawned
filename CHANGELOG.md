# Changelog — Dawned

All notable changes to the game. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning: 0.x.y during Early Access (0.1.0 = first playable release, see ROADMAP.md).

## [Unreleased]

### Added — Phase P0: foundations & walking skeleton
- **Monorepo**: pnpm workspaces (`packages/shared`, `packages/server`, `packages/client`,
  `tools`), TypeScript strict everywhere, ESLint 9 + Prettier, Vitest, a single `pnpm check`
  gate (typecheck + lint + format + tests + asset report) and a GitHub Actions workflow.
- **`@dawned/shared`**: binary wire protocol v1 (allocation-free codec, 8 message types,
  fuzz-tested against malformed input), the shared `stepMovement` simulation step both sides
  run, movement/stamina/fall-damage constants, and the P0 dev terrain. 37 unit tests, including
  a 10,000-tick client/server parity test and a reconciliation replay test.
- **Game server**: Fastify + `ws`, drift-corrected 20 Hz tick loop, session management with
  per-opcode rate limiting and backpressure shedding, authoritative movement, snapshot fan-out,
  in-process metrics ring, localhost-only ops API (`/ops/metrics`, `/ops/announce`), graceful
  shutdown.
- **Game client**: three.js scene (vertex-coloured terrain, water, gradient sky, shadows),
  client prediction with reconciliation and smoothed corrections, remote-entity interpolation,
  pointer-lock mouselook camera, sprint/stamina/jump, chat, roster, and a debug HUD with a
  ping graph.
- **Asset pipeline v1**: incremental, hash-based conversion of source packs into
  `assets_baked/` with a manifest; the report gate fails the build on unattributed assets and
  budget violations; the CREDITS per-file ledger is generated from manifest provenance.
  17 starter assets baked (1.2 MB).
- **Deployment**: real `deploy/` scripts — DEPLOY (provision + harden + build + start), UPDATE
  (backup → announce → pull → build → migrate → restart), BACKUP (nightly/quick/verify with
  rotation), ROLLBACK (code, optional double-confirmed DB restore) — plus a Caddyfile with CSP
  and cache rules and four systemd units.
- **Automated Definition-of-Done checks**: `tools/smoke/two-client-sync.mjs` (headless protocol
  test) and `tools/smoke/browser-sync.mjs` (two real Chromium clients: roster, movement,
  replication, convergence, console errors).

### Fixed
- Remote players rendered several metres behind their true position on slow clients: the
  interpolation clock was derived from ping/pong offsets, which skew badly when a stalled frame
  inflates the measured RTT. Interpolation is now driven off the snapshot stream with bounded
  lag/lead, so a slow or backgrounded client no longer drags every other player out of place.

### Added
- Complete 0.1.0 planning documentation:
  - Design: game vision & pillars, world (the Dawnlands archipelago, 6 zones), action combat
    system, 4 classes × 8 abilities + skill trees, progression (levels/stats/XP), items & loot &
    economy, 4 gathering professions incl. fishing minigame, quests/dialogue/POIs, enemies & AI
    (36 types + 6 bosses mapped to owned assets), UI/UX specification ("Cut Facets" language),
    GM command suite, audio direction.
  - Tech: stack selection & budgets, system architecture (monorepo, 20 Hz authoritative server,
    prediction/reconciliation client), networking protocol, PostgreSQL/Drizzle database schema,
    security & anti-cheat plan, asset pipeline, VPS deployment plan with script drafts
    (DEPLOY/UPDATE/BACKUP/ROLLBACK, Caddy, systemd).
  - Planning: 16-phase roadmap (P0–P15) with Definitions of Done and admin-repo sync points,
    0.1.0 content contract (countable targets), asset inventory & license ledger,
    USER_QUESTIONS.md for pending owner decisions, CLAUDE.md/AGENTS.md working agreements.
- Companion planning in the Dawned-Admin repository (editor & ops panel).

### Changed
- Folded all 16 initial owner decisions (2026-08-02) into the docs. Highlights: mouselook
  controls confirmed; jumping with light fall damage specced; English-only content; **open
  registration** (invite-code toggle kept available); admin panel at `/admin` with allowlist off;
  off-box backups manual via Hostinger hPanel (local nightly backups unchanged); CC0-first audio
  sourcing confirmed; 5 skin tones added to character creation; and **visual weather added to
  0.1.0 scope** — zone-profiled rain, thunderstorms with distance-delayed thunder, and post-rain
  rainbows, landing in P14 alongside day/night (WORLD.md §4.6, `/weather` GM command,
  `WeatherState` protocol message). Full decision log: USER_QUESTIONS.md.

### Notes
- No game code yet by design — Phase P0 is ready to start.
