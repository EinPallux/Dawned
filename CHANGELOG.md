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

### Fixed — P0 code review pass
- **Alt-tab no longer gets you kicked**: the keep-alive ping ran on the render loop, which
  browsers stop entirely in hidden tabs — the server's idle sweep then dropped the player after
  30 s. Pinging now runs on an interval timer and the idle window is sized above Chrome's worst
  background-timer throttling (90 s).
- **Silent clients no longer run away**: when inputs stop arriving, the server used to repeat the
  last movement intent indefinitely — a hidden tab or dying connection walked its character in a
  straight line until the world border. Movement now zeroes after 0.5 s of input starvation
  (verified with a live test: 4.6 m of legal coasting, then a full stop).
- **One bad tick can no longer take the server down**: the simulation tick is guarded — errors
  are logged and tolerated, and only persistent failure (100 consecutive) exits for a clean
  systemd restart. Crash paths now exit non-zero instead of masking themselves as clean stops.
- **Server restarts and rejections have real UX**: the client auto-reloads a few seconds after a
  shutdown notice, and pre-entry rejections (name taken, server full, outdated client) show an
  overlay with a reload button instead of stranding the player on an empty world. UPDATE.sh's
  in-game announcement now describes what actually happens.
- **CI would have failed on GitHub**: pnpm/action-setup errors when both its `version` input and
  the `packageManager` field are set — the workflow now relies on the pinned field alone.
- **Unattended deploys could hang**: corepack's interactive download prompt is disabled in
  DEPLOY/UPDATE/ROLLBACK (it triggers on TTY detection mid-script).
- Shadows now follow the player instead of silently vanishing beyond ±70 m of the world origin;
  fall-damage world events are logged instead of silently discarded (HP consumes them in P4).
- Asset pipeline: manifest paths are normalized to forward slashes (a Windows dev machine would
  have committed backslash paths) and duplicate asset ids across packs are now a build error.
- Docs synced to reality: input send rate is 20 Hz tick-locked (not 30 Hz), the protocol tables
  note the implemented v1 subset, DEPLOYMENT.md §8 documents private-repo deploy keys; removed a
  dead constant, a dead field and an unused re-export; added the missing ChatBroadcast codec
  test (38 tests total).

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
