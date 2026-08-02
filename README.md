# 🌅 Dawned

**A low-poly, vibrant, browser-based 3D action-combat sandbox MMORPG** — built for a small
community of friends (5–20 players), inspired by the feel of *Farever*, *Guild Wars 2* and
*Black Desert Online*. Runs on a single 4 GB VPS at **play.pathlands.cc**.

> **Status: 📐 Planning complete, owner decisions folded — ready for Phase P0.**
> 0.1.0 will be a *complete* Early Access MMORPG (4 animated classes, real action combat, an
> authored island open world with levels 1–30, professions, quests, loot, chat, GM tools) — not an
> MVP, not a prototype. The companion repo **[Dawned-Admin](../Dawned-Admin)** is the web panel
> that edits everything: map editor, quest editor, database editors, live ops.

## The game in one paragraph
You wash up on the **Dawnlands**, an archipelago of five color-drenched isles joined by bridges.
No chosen-one plot — just a warm, dangerous open world: fight prowling monsters with free-aim
action combat (dodge rolls, telegraphs, combos), level 1→30 through kills, discoveries and
side quests found in the world, chop/mine/pick/fish your way to riches, chase loot from camp
elites and zone bosses, and wander ever further from Dawnhaven's harbor — solo-friendly always,
friends optional and welcome.

## Documentation map

| Read… | For… |
|---|---|
| [ROADMAP.md](ROADMAP.md) | **The build plan** — 16 phases with Definitions of Done + admin-repo sync |
| [USER_QUESTIONS.md](USER_QUESTIONS.md) | ❓ Owner question inbox (currently empty) + the decision log |
| [docs/design/GAME_DESIGN.md](docs/design/GAME_DESIGN.md) | Vision, pillars, loops — start here for design |
| [docs/design/WORLD.md](docs/design/WORLD.md) · [COMBAT.md](docs/design/COMBAT.md) · [CLASSES.md](docs/design/CLASSES.md) · [PROGRESSION.md](docs/design/PROGRESSION.md) | World & the action-combat core |
| [docs/design/ITEMS_LOOT.md](docs/design/ITEMS_LOOT.md) · [PROFESSIONS.md](docs/design/PROFESSIONS.md) · [QUESTS_POI.md](docs/design/QUESTS_POI.md) · [NPCS_ENEMIES.md](docs/design/NPCS_ENEMIES.md) | Systems & content design |
| [docs/design/UI_UX.md](docs/design/UI_UX.md) · [GM_TOOLS.md](docs/design/GM_TOOLS.md) · [AUDIO.md](docs/design/AUDIO.md) | Interface, GM suite, audio |
| [docs/tech/TECH_STACK.md](docs/tech/TECH_STACK.md) · [ARCHITECTURE.md](docs/tech/ARCHITECTURE.md) · [NETWORKING.md](docs/tech/NETWORKING.md) · [DATABASE.md](docs/tech/DATABASE.md) | How it's built |
| [docs/tech/SECURITY.md](docs/tech/SECURITY.md) · [ASSET_PIPELINE.md](docs/tech/ASSET_PIPELINE.md) · [DEPLOYMENT.md](docs/tech/DEPLOYMENT.md) | Safety, assets, VPS operations (script drafts) |
| [docs/CONTENT_0.1.md](docs/CONTENT_0.1.md) | The countable content contract for 0.1.0 |
| [docs/ASSET_INVENTORY.md](docs/ASSET_INVENTORY.md) | What's in `assets/` and what it's for |
| [CLAUDE.md](CLAUDE.md) / [AGENTS.md](AGENTS.md) | Working agreements for AI-assisted development |
| [CHANGELOG.md](CHANGELOG.md) · [CREDITS.md](CREDITS.md) | History & attributions |

## Planned stack (rationale in docs/tech/TECH_STACK.md)
TypeScript everywhere · three.js (WebGL2) + React overlay UI · Node 22 + Fastify + `ws`
(20 Hz authoritative server, client prediction) · PostgreSQL 16 + Drizzle · pnpm monorepo
(`shared` / `server` / `client` / `tools`) · Caddy + systemd on Ubuntu 24.04 · one-command
deploy/update scripts.

## Quickstart (once P0 lands)
```bash
pnpm install
pnpm db:migrate && pnpm db:seed   # local Postgres, seeded world + dev/dev admin account
pnpm dev                          # server + client with hot reload
pnpm check                        # typecheck + lint + tests + asset report
```
VPS: `deploy/DEPLOY.sh` once, `deploy/UPDATE.sh` thereafter — see
[docs/tech/DEPLOYMENT.md](docs/tech/DEPLOYMENT.md).
