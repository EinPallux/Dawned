# Changelog — Dawned

All notable changes to the game. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning: 0.x.y during Early Access (0.1.0 = first playable release, see ROADMAP.md).

## [Unreleased]

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
