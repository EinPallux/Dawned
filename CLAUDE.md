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

### Freshness checklist (run it at the end of EVERY task, not only phase closes)

Stale state is a bug the owner has to find. Before claiming anything done, check that each of
these still tells the truth — and fix the ones that don't, in the same change:

1. **ROADMAP.md** — the status table row AND the phase's own block/checklist.
2. **CHANGELOG.md** `[Unreleased]` — anything player-visible.
3. **README.md** — the status block at the top (phases built, what's live, what's next).
4. **CLAUDE.md + AGENTS.md** — the "Current state" section in BOTH repos, mirrored.
5. **Docs you touched the territory of** — design docs get an "as built" note when the shipped
   thing deviates; tech docs get the new contract.
6. **In-app strings** — nothing hardcodes a phase or version. The HUD corner reads its build id
   from `build-info.ts` (Vite stamps the commit); keep it that way.
7. **USER_QUESTIONS.md** — answered questions move to the decision log; new ones get a
   recommended default.
8. **Counts you quoted** — test counts, item counts, asset counts drift; re-read them from the
   run you just did rather than copying the last number.

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

All 21 owner decisions are answered and folded (decision log in USER_QUESTIONS.md — Q21,
the P7 tree-authoring defaults, was accepted as shipped with the P7/P8 playtest). No open
questions right now.
**P0–P8 are ✅ complete and owner-verified** (P6 closed 2026-08-04 — "classes are fine";
P7 + P8 closed 2026-08-04 after two playtest fix rounds — "I tested everything so far and
all seems fine"). Their A1 sync points landed in the panel (XP-curve + skill-tree editors,
then items + loot + vendors). **P9 — Enemies & AI Depth is the current phase.**
The owner has explicitly deferred ALL fine-tuning (numbers, feel-pass on shipped systems)
to the end of the project — do not stop mid-phase to polish balance; note it and move on.
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
observably, refs legal), p7-probe/two-client/earlier smokes green. Heal magnitudes remain
flagged for panel tuning. Deploys to production happen only when the
owner merges to `main` and runs `deploy/UPDATE.sh` on the VPS (strict migrations; it also
bridges the GitHub PAT for the admin panel's pinned `@dawned/shared` git dependency).

What P8 shipped on top of that: items, loot and vendors as content (`content_items`,
`content_loot_tables`, `content_vendors`) with the ITEMS_LOOT §2 budgets as shared
formulas; the plan/apply inventory model (one code path both sides run, proven by a
5-seed × 4000-op conservation fuzz suite); an authoritative 48-cell pack + paper-doll +
purse that folds equipment into the P4 derived stats and persists write-through;
per-player instanced loot bags (60 s, 4 m, `nothing` weighted, nested tables, XP's tag
rule); server-priced vendors with a proximity lease and a 10-deep buyback shelf;
consumables on the shared cooldown lane; and protocol v10 — `ItemOp` up (the only
client-authored JSON envelope, zod-gated), `InventorySync`/`LootBags`/`VendorPanel`/
`ItemNotice` down, `mainhandModel`/`offhandModel` on the roster. NOTHING about items is
predicted: every op is a request and the next full sync is the answer, which is also what
heals a refused drag. The client layer is the `I` pack + paper-doll + comparing tooltips,
world loot bags with rarity beams and the `F` / `Shift+F` flow, Dawnhaven market posts
with the `F` trade prompt, the vendor panel, HUD gold, item toasts, `E` quick-drink and
visible weapons hung off the animated hand bones. Content: 12 weapon/shield models, 62
unique item icons, and the whole T1–T2 catalogue (62 items, 5 loot tables, 5 vendors)
authored in the panel, published, and frozen into seed migration 0012. Dev lever:
`/ops/grant` (item or gold). Verification: `tools/smoke/browser-p8.mjs` runs the DoD loop
for real (grind → bag with an ITEM → take with the key → equip → model on the roster →
tooltip → the `C` sheet drawing its rig and worn slots → all 5 posts standing → trade →
relog); `pnpm check` is green at 336 unit tests, and browser-p6/p7, p8-probe, two-client
and browser-sync all pass in the same session.

**Owner round after P8 (2026-08-04):** worn gear moved OUT of the pack and onto the
character sheet (`C`) — name/level header, slot columns flanking the live rig (holding
what you equipped), stat block with gear contributions marked, all folded through the
shared `equipmentBonus` the server derives with. `I` is the bag alone. Alongside it, the
"which build am I on?" problem is closed: the client bakes in its commit (Vite), the
server reports its own at `/api/health`, a mismatch raises a reload notice, and the HUD
corner shows the build instead of a hardcoded phase label. API responses are `no-store`
(both repos) and Caddy marks every non-asset path `no-cache` — an SPA deep link used to
be served with no cache header at all, which is why updates appeared in a private window
first.

**Playtest round 2 after P8 (2026-08-04) — protocol v11.** Three owner bugs, all fixed and
verified: (1) **the dodge roll cancelled itself.** Not an animation bug — the snapshot
carried no roll state, so once the server acked the dodge press (one input, ~1 RTT) the
replay could no longer re-create the 550 ms roll, the position error blew past the 2 cm
ignore threshold, and the adopted correction cloned `rollTimeLeft = 0` over the
prediction. The self block now carries the roll (time left, locked direction, cooldown).
Measured through the shipped reconciliation algorithm at 80 ms RTT: **3 ticks before, 10
of 11 after.** A refused roll also says why now (shared `dodgeRefusal` → HUD line + deny
sound) and a dodge tap buffers 220 ms. (2) **vendors were invisible** — the market posts
seated themselves on `heightAt` before their chunk had streamed, which answers
`OCEAN_FLOOR_Y`; `ChunkTerrain.hasDataAt` now distinguishes "no data" from "sea floor" and
posts stay hidden until the ground is real. (3) **weapons sat wrong in the hand** — held
models are scaled to a target length per kind and gripped up the shaft, shields ride the
forearm, and everything hangs off the bone in the SKINNED MESH's skeleton (a composed rig
has several `hand_r`; only one animates). Also fixed: `two-client-sync.mjs` drifted its own
fixtures 130 m apart over many runs because the walk-back only ran on success — both
characters `/stuck` home first and the walk-back is in a `finally`. New/changed smokes:
`tools/smoke/roll-probe.mjs` (headless, pins the server half of the roll),
`predict-lag.mjs` (mirrors connection.ts — it needed the same v11 fix, and now FAILS if a
predicted roll is cut short). `pnpm check` green at **342 unit tests**; browser-p8,
two-client and predict-lag pass.

**P9 — Enemies & AI Depth (in progress, 2026-08-04).** A/B/C/D are built; E (verification)
remains. P9-A put the archetype vocabulary in shared — charge/self-shield
kinds, interruptible casts, hp-threshold/once-per-life/phase conditions, boss phases +
arena — and, crucially, the SELECTION RULES themselves (`selectableEnemyAbilities`,
`pickEnemyAbility`, `bossPhaseAt`), so the AI and the panel's TTK preview cannot disagree.
P9-B (protocol v12) completed the AI: charger lunges sweeping the segment travelled each
tick into an overshoot punish, casts flagged interruptible, swarm surround rings, ranged
stand-off from `ARCHETYPE_MOTION` clipped to what the kit can actually reach, bosses
walking one-way phases inside an arena. P9-C baked 13 enemy models (3 → 16) and authored
the Dawnshore + Weald bestiary — 17 enemies, 20 spawners, two deliberately mixed camps —
through the panel's A1-d editor, published, frozen into seed migration 0013. The TTK
simulator caught the Mushroom King at a 48 s kill (under COMBAT.md §12's 60 s floor) before
he went live; he now carries an explicit HP override landing him near 87 s. A latent P5 bug
surfaced with it: the Spore Lobber's panic swat asked a mushnub rig for a `Punch` clip it
does not have, so the swing animated nothing — shared now records which clips each baked
model owns (`ENEMY_MODEL_CLIPS`) and publish refuses the mistake.

**P9-D made those fights readable — and closed three holes the earlier slices left.**
Shipped: the boss frame (`ui/boss-frame.ts` — name/level, HP, a pip per declared phase, the
announce read from the client's own copy of the published def so the panel can rewrite a
shout with no protocol change; adopted on ENGAGEMENT, released on death/leash/leaving the
arena), enemy cast bars that shatter red with a ring + hit on an interrupt, absorb bubbles
+ pool chips for self-shields, drawn rank marks (diamond/star, canvas paths not glyphs)
with per-rank tints, per-archetype wind-up audio with distance falloff, and phase VFX.
Rect charge decals and elite ×1.15 scale were already live. The holes, all found by
LOOKING (`tools/smoke/p9-visuals.mjs` + reading its screenshots, never by a failing test):
(1) `ground_circle` drew a circle and resolved as a melee cone at the caster — it now
places the pool on the target's ground at cast start and tests that exact circle, which is
what makes "walk out of it" a real answer; (2) `self_shield` granted no absorb at all —
it now applies a timed pool that drains through the same `absorbFromShields` players use,
and enemy damage runs through it (full absorb ⇒ `HitFlag.Absorbed`, threat/tag still count
the full swing); (3) the gateway rebuilt `AbilityStart` field-by-field and never copied
`cast`, so no enemy cast bar could ever appear — the field is REQUIRED on the message type
now, which turns that omission into a compile error (NETWORKING.md §3.2). Also fixed:
nameplates clipped every name past ~17 chars (256 px canvas, centre-aligned). New dev
levers `/ops/enemyhurt` and `/ops/tp` (ARCHITECTURE.md §3 table). 377 unit tests green;
two-client, roll-probe, predict-lag, p8-probe and browser-p8 all pass on the same build.

### Running it locally

```bash
pnpm install && pnpm build
pnpm --filter @dawned/server start     # game server on :8081
pnpm --filter @dawned/client dev       # client on :5173 (proxies /api and /game)
node tools/smoke/two-client-sync.mjs   # headless protocol check
node tools/smoke/browser-sync.mjs      # two real browsers (needs the client dev server running)
```
