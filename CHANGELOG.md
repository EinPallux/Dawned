# Changelog — Dawned

All notable changes to the game. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning: 0.x.y during Early Access (0.1.0 = first playable release, see ROADMAP.md).

## [Unreleased]

### Added — Phase P3: movement, netcode core & chat v1 (in progress)
- **Swimming**: water deeper than 1.2 m carries you — movement pins to the surface,
  speed drops to ×0.55, sprint-swimming drains stamina faster, jumping is inert, and
  diving into deep water always negates fall damage. Enforced by the same shared
  formula on client prediction and the authoritative server (protocol v4).
- **Seamless reconnect**: losing the connection no longer despawns you — the server
  holds your character in place for 15 s while the client auto-retries (banner +
  status show "reconnecting…"); success resumes the same character mid-world with
  no leave/join spam for anyone nearby. Cleanly leaving still despawns immediately.
- **Interest management (AOI)**: snapshots now carry only entities within ~96 m
  (leave past 104 m, per-client cap 80 nearest) — the network cost of a crowd
  stays flat no matter how many players share the island.
- **Chat v1**: global chat with system lines, chat bubbles in the "Cut Facets"
  style above speakers' heads (~6 s), and `/stuck` — a 60 s-cooldown self-rescue
  that recalls you to the spawn shore.
- **Locomotion v2**: 8-way jog blends (diagonals included), sprint turns bank into
  lean animations, and idle/forward swim strokes on the water — all driven by the
  same speed/heading logic for your own character and everyone remote.
- **Cursor without unlocking**: hold **Alt** to free the mouse cursor (chat, future
  menus) and release it to snap straight back to mouselook.
- **Lag lab + netgraph**: `/netsim <rtt> [jitter]` injects artificial latency into
  your own connection for feel-testing; the HUD now graphs RTT and prediction
  corrections and reads out snapshot cadence/age and up/down throughput.
- **Fix**: teleports into not-yet-streamed terrain (e.g. `/stuck` from far away) no
  longer free-fall the camera while chunks load — the client adopts the server's
  authoritative state until the ground data arrives.

### Added — Phase P2: terrain & world streaming (verified on real hardware 2026-08-02)
- **The Dawnlands gain real ground**: a ~1 km dev island (Dawnshore meadows and beaches,
  the wooded Verdant Weald, the stark Ashen Reach, an inland lake) generated deterministically
  by `pnpm world:generate` into committed map artifacts — 271 terrain chunks (~25 kB each:
  65×65 heights at 1 m + 8-layer splat weights + per-chunk water level), a 1 MiB walkability
  grid, zone polygons with ambience profiles, worldmap/minimap renders and a spawn point.
  The admin map editor takes over authoring at A2/A3 using the same formats.
- **Client streaming**: chunks load in residency rings around the player (IndexedDB-cached
  per map version, two fetches in flight, one mesh build per frame — no frame hitches),
  and unload past an outer ring. Terrain renders as flat-shaded vertex-color splat blends
  with edge skirts; water planes blend from glassy shallows to deep blue at the shore;
  an ocean backdrop covers the horizon.
- **Zone ambience**: fog color/range, sky gradient, sun and hemisphere light ease toward
  the profile of the zone polygon underfoot (~4 s settle) — crossing from Dawnshore into
  the Weald visibly closes the fog green; the Ashen Reach goes grey-violet.
- **Foliage**: deterministic per-chunk scatter of grass, bushes, trees and bare trees from
  splat weights as instanced meshes with a vertex-shader wind sway — two clients on the
  same meadow see the same field.
- **Walkability is law**: the shared movement step now consults the walkgrid (slopes over
  50°, deep water and the open ocean block; shallows are wadeable) with axis-separated
  sliding, enforced identically by prediction and the authoritative server (protocol v3).
- **Server terrain mirror**: the full map loads at boot (~8 MB; the server refuses to start
  without it); persisted positions that are now off-world or unwalkable relocate to spawn.
- **Budgets measured** (worst case, dense forest view at 1080p): 154 draw calls,
  ~441 k triangles — within the ≤300 calls / ≤500 k tris budgets (TECH_STACK.md). Real-GPU
  60 FPS validation is the owner's remaining DoD step (dev containers render via software GL).

### Added — Phase P1: accounts, characters & menus (live on the VPS 2026-08-02)
- **Accounts & sessions (server)**: PostgreSQL 16 + Drizzle schema (`accounts`, `sessions`,
  `characters`, `bans`) with committed migrations; argon2id password hashing; registration
  (open, dormant invite-code toggle per Q8), login with per-IP throttles, failed-login lockouts
  and timing-safe unknown-name handling; 30-day sliding sessions (hashed tokens); REST API
  (`/api/auth/*`, `/api/characters`) validated with the shared zod schemas. Five integration
  tests run the full flow against a real database.
- **Characters (server)**: five slots per account, world-unique names, class + full appearance
  stored per character, soft delete that frees the name, position/playtime persistence
  (10 s write-behind + on disconnect), single-session-per-account (newest login wins).
- **Protocol v2**: authenticated `Hello` (session token + character id) replaces the P0
  name-claim handshake; `Welcome` carries the spawn (persisted position on relog) and a roster
  with class, level and appearance for every player.
- **Character asset pipeline**: Quaternius Universal Base Characters, Modular Fantasy Outfits
  and Universal Animation Library baked through new rule options (`skinned`, `bodyCut`,
  `imageOverrides`, `animationsOnly`/`animationKeep` — see docs/tech/ASSET_PIPELINE.md §2);
  13 character assets at 6.6 MB total incl. a mesh-free 13-clip animation library; a rig
  verification gate (bone/track-name contract) now runs inside `pnpm assets:report`;
  `pnpm assets:sync` publishes baked assets into the client.
- **Menus & design system v1 (client)**: React 19 front door over the three.js world — login/
  register screen on a live dawn vignette, character select with 3D stage, character creation
  with class carousel (posed, animated rigs), body/skin/outfit/tint/hair/color/beard controls
  on the live model, and the "Cut Facets" design language (Amaranth + Nunito Sans, corner-cut
  panels, gold-seam buttons) as reusable primitives.
- **Character composition (client)**: load-time skeleton rebinding of outfit/hair pieces onto
  the shared 65-bone rig, multiplicative skin/outfit/hair tinting, UAL clips with crossfade.
- **In-world characters**: composed rigs replace the P0 capsules, with a locomotion state
  machine (idle / jog forward-back-strafe / sprint / jump start-loop-land), speed-following
  playback and desynchronized loop phases; appearance and names applied live from the roster.
- **Session resume**: a returning player lands on character select and re-enters the world at
  the exact spot they left (position write-behind + on-disconnect persist).
- **Verification**: both smoke tests now drive the authenticated flow (REST fixtures, token
  bootstrap, character select, v2 handshake); CI runs against a PostgreSQL 16 service with
  migrations; the §7-P1 security checklist was run and recorded (timing-oracle measurement,
  token/session-fixation review); per-IP registration limit set to 10/day.

### Fixed — P1 VPS deploy
- **Registration/login failed on the VPS with a raw SQL error on screen.** Root cause: the
  deploy scripts ran `pnpm db:migrate` without `DATABASE_URL` (the `dawned` user cannot read
  `/etc/dawned/game.env`), the migrator fell back to the dev-default URL and failed password
  auth, and an `|| echo "(no migrations to run)"` swallowed the failure — so the server came
  up against a database with no tables. Three-layer fix:
  - DEPLOY.sh/UPDATE.sh now read `DATABASE_URL` (as root) and inject it into the migration
    step, which **aborts the deploy on failure** instead of pretending nothing happened;
  - the server refuses to boot when the schema is missing ("accounts" table probe) with a
    message pointing at the migration step — no more healthy-looking broken deploys;
  - a Fastify error handler stops internal errors from reaching the client at all: the VPS
    error body contained the failed SQL and its parameters, including the freshly computed
    password hash. Clients now get a generic message; the real error goes to the server log.

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
- **DEPLOY.sh can no longer lock the owner out of the VPS**: it only disables SSH password login
  once an SSH key is actually installed for root (fail2ban guards passwords until then). Added
  `deploy/FIRST_DEPLOY.md` — a beginner walkthrough for the first deployment with private repos.

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
- Phase P0 shipped and verified live at play.pathlands.cc on 2026-08-02 (first deployment via
  `deploy/DEPLOY.sh` on the production VPS). Next phase: P1 — Accounts, Characters & Menus.
