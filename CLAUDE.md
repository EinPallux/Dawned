# CLAUDE.md — Dawned (game repo)

Guidance for Claude Code (and mirrored for other agents in AGENTS.md) when working in this
repository. Read this first, every session.

## What this project is

**Dawned** — a low-poly, vibrant, browser-based 3D **action-combat sandbox MMORPG** for a private
community (5–20 players), deployed to a 4 GB / 1-core Ubuntu 24.04 VPS at `play.pathlands.cc`.
Version target: **0.1.0 = a complete Early Access MMORPG**, explicitly _not_ an MVP/prototype.
The companion repo **Dawned-Admin** (separate repository) is the web editor/ops panel that edits
_everything_ (map, quests, database content, live ops).

## Non-negotiable project rules

1. **No cheap shortcuts.** Features ship vertically complete (anim + VFX + sound hook + UI +
   server validation + editor support) or not at all. No placeholder-forever, no "temp" hacks
   without a tracked replacement task.
2. **Server-authoritative always.** The client renders and predicts; the server decides. Every
   gameplay mutation is validated server-side (docs/tech/SECURITY.md).
3. **Content is data.** Items, enemies, abilities, quests, spawns, zones, terrain live in
   Postgres/published bundles, edited via Dawned-Admin — never hardcoded. New content types get
   editor support in the same phase.
4. **Feel is a requirement.** Combat/UI motion specs (docs/design/COMBAT.md §9, UI_UX.md §2) are
   acceptance criteria, not suggestions.
5. **Desktop-first** (1080p/1440p), 60 FPS budgets in docs/tech/TECH_STACK.md are enforced.
6. **No serif fonts. No generic rounded-blob UI.** Follow the "Cut Facets" design language
   (docs/design/UI_UX.md) — its anti-slop checklist applies to every surface.
7. **Respect the roadmap.** Work happens in the current phase (ROADMAP.md status table). A phase
   closes only via its Definition of Done. Don't start future-phase systems "while at it".
8. **Open questions go to USER_QUESTIONS.md** with a recommended default — never silently guess a
   design the owner might feel differently about; never block on it either (implement the
   recommendation if an answer is pending and the phase demands progress; note it).

## Repository map (planned layout — Phase 0 creates it)

```
packages/shared   @dawned/shared — protocol, formulas, drizzle schema, zod content schemas, constants
packages/server   game server (Node 22, Fastify REST + ws WSS, 20 Hz sim)
packages/client   game client (three.js + React overlay UI, Vite)
tools/            asset pipeline CLIs (models, icons, audio, thumbnails, manifest)
deploy/           DEPLOY.sh / UPDATE.sh / BACKUP.sh / ROLLBACK.sh, Caddyfile, systemd units
assets/           raw source packs (never served) · assets_baked/ committed pipeline outputs
docs/             design/ + tech/ + inventory/content plans — THE source of truth
```

Docs index: start at README.md. Key entry points: ROADMAP.md (what to build now),
docs/design/GAME_DESIGN.md (what the game is), docs/tech/ARCHITECTURE.md (how it fits together).

## Engineering conventions

- TypeScript strict everywhere; no `any` (use `unknown` + narrowing); zod at every boundary
  (REST, protocol JSON envelopes, content rows, env).
- Client and server import **only** `@dawned/shared` from each other's world. Shared formulas
  (movement step, damage, XP) live in shared and are unit-tested — they are the anti-desync layer.
- IDs: content = string slugs (`enemy_mushroom_king`); runtime entities = u32. Integers for
  money/XP/durations(ms); no floats for currency.
- Naming: files kebab-case, types PascalCase, constants SCREAMING_SNAKE in shared/data only.
- Tests (Vitest) are mandatory for: shared formulas, protocol codec round-trips, loot/XP rolls,
  inventory transactions, movement step. UI/scene code: manual + Playwright smoke.
- `pnpm check` (typecheck + lint + test + asset report) must pass before any commit that claims a
  task done. Update CHANGELOG.md under `[Unreleased]` for anything player-visible.
- Performance budgets (TECH_STACK.md) and security gates (SECURITY.md §7) are phase DoD items —
  regressions block the phase, treat them like failing tests.
- Never import raw `assets/` files at runtime — everything flows through `tools/` →
  manifest-referenced `assets_baked/` (docs/tech/ASSET_PIPELINE.md). Every asset needs a license
  ledger entry; builds fail on unattributed files.
- Commit style: imperative, scoped (`combat: add stagger meter decay`), reference phase
  (`[P4]`) when applicable.

## Working with the owner

The owner (solo, plays with friends) will edit content via Dawned-Admin and expects to extend the
game for years: optimize for **readable, editable, documented** over clever. When touching a
design doc's territory, update the doc in the same change. German-speaking owner — player-facing
text is English-only (decided), docs/comments English.

## Current state

**Phase P0 is ✅ complete and live at https://play.pathlands.cc** (deployed by the owner on
2026-08-02): monorepo, shared protocol/formulas, 20 Hz authoritative server, three.js client with
prediction, asset pipeline v1, deploy scripts — `pnpm check` green, both smoke tests passing
(`tools/smoke/two-client-sync.mjs`, `tools/smoke/browser-sync.mjs`), and reviewed (see the
2026-08-02 review commit for netcode-robustness fixes).

21 owner decisions are answered and folded (decision log in USER_QUESTIONS.md); Q21 (P7
tree-authoring defaults: tier-by-listed-order, linear per-rank ramps) is open with a
keep-and-panel-tune recommendation implemented.
**P0–P6 are ✅ complete (owner-verified; P6 closed 2026-08-04 — "classes are fine"; A0
/admin login confirmed). P7 — Progression is ✅ built end-to-end (P7-A…E, 2026-08-04,
protocol v9) — owner playtest pending; its A1-b sync point landed (XP-curve + skill-tree
editors live in the panel).**
What P7 shipped on top of the P5/P6 caster platform: the XP pipeline (kill XP with the tag
rule, level falloff, per-enemy `xpMult` and the `xpRate` world lever, zone-discovery XP,
cascading level-ups with the §1.3 refill/juice contract), attribute allocation and the
96-node skill trees as published `content_skill_nodes` rows (seed migration 0010; all 7
node-effect kinds fold live on BOTH sides — effective ability defs via shared
`applyAbilityMods`, movement/stamina/attack-speed/resource scalars ride prediction), respec
(25×/50×level gold), write-through persistence, and the client layer: bottom-edge XP bar,
level-up juice (gold pillar, Celebration clip, flash frame with bar sparks, chime, unlock
toasts), the `C`/`K` panels (staging with Confirm, suggested build, climbing lattices with
data-generated tooltips) and the §3 micro menu with banked-point badges. Dev levers:
`/setlevel` (gm/admin), `/ops/setlevel`, plus `/ops/cc` and `/ops/hurt` from P6.
Verification: `tools/smoke/browser-p7.mjs` (a bot grinds 1→10 legitimately on the live
camps — kills only, accelerated via the published xpRate/xpMult levers — then proves tier
gates, capstone refusal, both respecs, UI evidence and relog persistence), the node-effect
matrix test (`progression-content.test.ts`: every published node at every rank folds
observably, refs legal), p7-probe/two-client/earlier smokes green, 263 unit tests. Heal
magnitudes remain flagged for panel tuning. Deploys to production happen only when the
owner merges to `main` and runs `deploy/UPDATE.sh` on the VPS (strict migrations; it also
bridges the GitHub PAT for the admin panel's pinned `@dawned/shared` git dependency).

### Running it locally

```bash
pnpm install && pnpm build
pnpm --filter @dawned/server start     # game server on :8081
pnpm --filter @dawned/client dev       # client on :5173 (proxies /api and /game)
node tools/smoke/two-client-sync.mjs   # headless protocol check
node tools/smoke/browser-sync.mjs      # two real browsers (needs the client dev server running)
```
