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

### Notes
- No game code yet by design — implementation starts at Phase P0 once USER_QUESTIONS.md answers
  are folded in.
