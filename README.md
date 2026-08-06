# 🌅 Dawned

**A low-poly, vibrant, browser-based 3D action-combat sandbox MMORPG** — built for a small
community of friends (5–20 players), inspired by the feel of _Farever_, _Guild Wars 2_ and
_Black Desert Online_. Runs on a single 4 GB VPS at **play.pathlands.cc**.

> **Status (2026-08-06): phases P0–P12 are complete on their measured DoDs** (P0–P10
> owner-accepted; P11 and P12 measured on 2026-08-06 — P12's zone-by-zone walkthrough signoff is
> the owner's and still pending). Live at
> [play.pathlands.cc](https://play.pathlands.cc) — accounts and characters,
> a streamed island, action combat, all four classes with their ability kits, levels 1–30 with
> attributes and 96-node skill trees, and the full item loop (pack, paper-doll, loot bags,
> vendors, visible weapons). Protocol v13 — enemies come in five archetypes with a 17-strong
> Dawnshore/Weald bestiary, and their fights are readable: boss frames with phase pips,
> interruptible cast bars, telegraphed pools you walk out of, and absorb bubbles. The Mushroom
> King measures **105 s** solo at level (the 60–120 s target), and 150 active AI cost the server
> 4.2 ms of a 50 ms tick. **The world itself is editable now**: the live map is a published
> artifact the server hot-loads, and Dawned-Admin's map editor (A2 + A3, closed 2026-08-05) can
> sculpt a new islet out of open water, populate and zone it, and put it under a player's feet
> without a deploy. **Gathering professions are in:** 65 resource nodes
> stand in the world, `F` chops/mines/picks them with a hold bar and a depletion beat, fishing is
> a real minigame, and `J` opens four profession levels with a codex of everything you have ever
> brought home. Measured end to end: woodcutting goes **1 → 10 in 458 real gathers** (the T2 gate
> at 248, both matching the XP curve's own arithmetic to the gather), two players cannot chop the
> same tree, and every fishing bar the placed waters can show is landable within two casts.
> **P11 — Quests, POIs & Interactables is ✅ complete** (2026-08-06), paired with the panel's A4
> quest editor. Protocol v14: four villagers stand in Dawnhaven, eight quests are published — four
> Dawnshore jobs plus the four-part chain _The Loggers' Silence_ — and the world carries a notice
> board, a washed-up crate, four marked stumps, an attunable travel shrine and six discoverable
> places, all authored through the panel and hot-swapped onto the running server. You walk up and
> talk to people, `F` names what it will do, conversations run a typewriter with per-class reward
> picks, and there is a HUD tracker, a journal (`L`), a world map (`M`) with fog and pins, and a
> banner for each new place. **Measured end to end** by a run that navigates only by what the game
> shows: the found-object quest solved from prose alone, the discovery loop firing for **all six
> POI kinds**, and the whole chain — stumps, stalkers, five gathered mossbloom, a delivery that
> credits on a villager's mutter, and the Mushroom King in **137 s** — ending on the per-class Rare.
> **P12 — the real world — is ✅ measured** (2026-08-06): the Dawnlands are generated, five isles
> and a hidden grove and four islets in 2048 m of sea, 57.9 % of it land, each isle its own
> landmass with a channel between, joined by four bridges of raised ground. Five settlements,
> nine shrines, and **a bestiary of 50 types across 124 camps — 400 enemies** from the Dawnshore's
> glubs to Ashwing in the Ashcrag caldera, each camp resolved against the real terrain rather than
> typed as a coordinate. **223 items** with their own icons — nine armour sets, sixty weapons
> and shields, and six Legendaries that finally do what their names promise — with every
> settlement trading. **362 resource nodes** in clusters you walk between — 120 trees, 95 ore
> seams, 107 herb patches and 40 fishing spots, every zone carrying its own tier band, and all
> five fishing waters real for the first time (the epic and legendary bars had definitions and
> nowhere to play them). And the world is **inhabited**: 41 people — sixteen shopkeepers behind
> the sixteen shops, guards, villagers, the Grove's Warden — **46 places to discover** across all
> six regions, and **61 things to press `F` on** (chests, signposts, campfires, shrines, the
> Elder Arch). The five settlements are dressed with wells, market stalls, carts and benches
> instead of standing as bare building shells. And there is **work to do: 28 quests in five
> chains**, one per region, with every marker worked out from the real camps and herbs and chests
> rather than typed by hand — which is how five of the original eight turned out to be pointing
> 420–815 m into empty ground after the world moved under them. **Measured end to end**
> (`tools/smoke/p12-dod.mjs`, run against the live world): every CONTENT_0.1 target met with zero
> dangling references, a real 1→30 route — each region pays its own level band in 0.8 to 4.0 camp
> clears, a smooth ramp with no grind wall — and 400 enemies awake for 2.4 ms of a 25 ms tick.
> Fine-tuning of every shipped system (numbers, feel) is deliberately held to one pass at the
> end of the project, by the owner's decision.
> 0.1.0 will be a _complete_ Early Access MMORPG (4 animated classes, real action combat, an
> authored island open world with levels 1–30, professions, quests, loot, chat, GM tools) — not an
> MVP, not a prototype. The companion repo **[Dawned-Admin](../Dawned-Admin)** is the web panel
> that edits everything: map editor, quest editor, database editors, live ops.
>
> Phase status lives in [ROADMAP.md](ROADMAP.md); what shipped in each is in
> [CHANGELOG.md](CHANGELOG.md).

## The game in one paragraph

You wash up on the **Dawnlands**, an archipelago of five color-drenched isles joined by bridges.
No chosen-one plot — just a warm, dangerous open world: fight prowling monsters with free-aim
action combat (dodge rolls, telegraphs, combos), level 1→30 through kills, discoveries and
side quests found in the world, chop/mine/pick/fish your way to riches, chase loot from camp
elites and zone bosses, and wander ever further from Dawnhaven's harbor — solo-friendly always,
friends optional and welcome.

## Documentation map

| Read…                                                                                                                                                                                               | For…                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [ROADMAP.md](ROADMAP.md)                                                                                                                                                                            | **The build plan** — 16 phases with Definitions of Done + admin-repo sync |
| [USER_QUESTIONS.md](USER_QUESTIONS.md)                                                                                                                                                              | ❓ Owner question inbox + the decision log (21 decisions folded)          |
| [docs/design/GAME_DESIGN.md](docs/design/GAME_DESIGN.md)                                                                                                                                            | Vision, pillars, loops — start here for design                            |
| [docs/design/WORLD.md](docs/design/WORLD.md) · [COMBAT.md](docs/design/COMBAT.md) · [CLASSES.md](docs/design/CLASSES.md) · [PROGRESSION.md](docs/design/PROGRESSION.md)                             | World & the action-combat core                                            |
| [docs/design/ITEMS_LOOT.md](docs/design/ITEMS_LOOT.md) · [PROFESSIONS.md](docs/design/PROFESSIONS.md) · [QUESTS_POI.md](docs/design/QUESTS_POI.md) · [NPCS_ENEMIES.md](docs/design/NPCS_ENEMIES.md) | Systems & content design                                                  |
| [docs/design/UI_UX.md](docs/design/UI_UX.md) · [GM_TOOLS.md](docs/design/GM_TOOLS.md) · [AUDIO.md](docs/design/AUDIO.md)                                                                            | Interface, GM suite, audio                                                |
| [docs/tech/TECH_STACK.md](docs/tech/TECH_STACK.md) · [ARCHITECTURE.md](docs/tech/ARCHITECTURE.md) · [NETWORKING.md](docs/tech/NETWORKING.md) · [DATABASE.md](docs/tech/DATABASE.md)                 | How it's built                                                            |
| [docs/tech/SECURITY.md](docs/tech/SECURITY.md) · [ASSET_PIPELINE.md](docs/tech/ASSET_PIPELINE.md) · [DEPLOYMENT.md](docs/tech/DEPLOYMENT.md)                                                        | Safety, assets, VPS operations (script drafts)                            |
| [docs/CONTENT_0.1.md](docs/CONTENT_0.1.md)                                                                                                                                                          | The countable content contract for 0.1.0                                  |
| [docs/ASSET_INVENTORY.md](docs/ASSET_INVENTORY.md)                                                                                                                                                  | What's in `assets/` and what it's for                                     |
| [CLAUDE.md](CLAUDE.md) / [AGENTS.md](AGENTS.md)                                                                                                                                                     | Working agreements for AI-assisted development                            |
| [CHANGELOG.md](CHANGELOG.md) · [CREDITS.md](CREDITS.md)                                                                                                                                             | History & attributions                                                    |

## Planned stack (rationale in docs/tech/TECH_STACK.md)

TypeScript everywhere · three.js (WebGL2) + React overlay UI · Node 22 + Fastify + `ws`
(20 Hz authoritative server, client prediction) · PostgreSQL 16 + Drizzle · pnpm monorepo
(`shared` / `server` / `client` / `tools`) · Caddy + systemd on Ubuntu 24.04 · one-command
deploy/update scripts.

## Quickstart

```bash
pnpm install
pnpm build                             # shared → server → client

pnpm --filter @dawned/server start     # game server on :8081
pnpm --filter @dawned/client dev       # client on http://localhost:5173

pnpm check                             # typecheck + lint + format + tests + asset report
pnpm assets:build                      # rebuild assets_baked/ from assets/
```

Open the client in two browser windows, pick two names, and walk around: the server is
authoritative, the client predicts your own movement, and other players are interpolated.

The same guarantee, automated:

```bash
node tools/smoke/two-client-sync.mjs   # headless: handshake, movement, replication
node tools/smoke/browser-sync.mjs      # two real Chromium clients, end to end
```

VPS: `deploy/DEPLOY.sh` once, `deploy/UPDATE.sh` thereafter — see
[docs/tech/DEPLOYMENT.md](docs/tech/DEPLOYMENT.md).

## Repository layout

```
packages/shared   @dawned/shared — protocol, movement formula, constants (the anti-desync layer)
packages/server   game server — Fastify + ws, 20 Hz authoritative simulation
packages/client   game client — three.js + prediction/reconciliation/interpolation
tools/            asset pipeline, smoke tests
deploy/           DEPLOY / UPDATE / BACKUP / ROLLBACK, Caddyfile, systemd units
assets/           raw source packs (never served) · assets_baked/ pipeline output
docs/             design + tech documentation — the source of truth
```
