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
the P7 tree-authoring defaults, was accepted as shipped with the P7/P8 playtest). The map
editor's four questions were answered on 2026-08-05 with "your recommendations": Q22 keeps
the Orc as the Bandit Forager, Q23 makes the MAP the place camps live (its publish wins over
the Enemies page's copy of a position), Q24 puts patrol splines out of 0.1.0, and Q25 — the
resource-node schema — is answered by P10 starting, since its recommended default was "do it
in the professions phase". Q27 (how hard a T5 legendary fish should be) was answered on
2026-08-05 with the recommended default — leave the reel as shipped and judge it in the
playtest. **One open question: Q26** — `zoneAmbienceSchema` is light and colour only, so a zone
cannot carry music or sfx (recommended default — add both with the audio phase).
**P0–P8 are ✅ complete and owner-verified** (P6 closed 2026-08-04 — "classes are fine";
P7 + P8 closed 2026-08-04 after two playtest fix rounds — "I tested everything so far and
all seems fine"). Their A1 sync points landed in the panel (XP-curve + skill-tree editors,
then items + loot + vendors). **P0–P11 are ✅ complete on their measured DoDs — P9 + P10 closed
2026-08-05 and are owner-accepted; P11 — Quests, POIs & Interactables closed 2026-08-06**
(A/B/C/D built on protocol v14, E measured), paired with the panel's A4 quest editor, which is
live. **P12 — World Building: the Dawnlands is 🟨 in progress: A is built (the terrain), B–G
remain.**
**A phase closes on its MEASURED DoD, not on a playtest** (owner decision, 2026-08-05): the
priority is reaching P15 with every phase built. Record what was measured — including any
deviation, like P10's one-profession grind — and move on. The owner has explicitly deferred
ALL fine-tuning (numbers, feel-pass on shipped systems) to one pass at the end of the project;
do not stop mid-phase to polish balance.
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

- pool chips for self-shields, drawn rank marks (diamond/star, canvas paths not glyphs)
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
  now, which turns that omission into a compile error (NETWORKING.md §3.3). Also fixed:
  nameplates clipped every name past ~17 chars (256 px canvas, centre-aligned). New dev
  levers `/ops/enemyhurt` and `/ops/tp` (ARCHITECTURE.md §3 table).

**P9-E measured the DoD and closed the phase.**
`tools/smoke/browser-p9.mjs` BUILDS its level-12 warrior before timing anything — spends all
33 attribute points and every legal skill node, equips published T2 gear — because an unspent
level 12 fights at 38 % of a built one's damage (30 vs 78 effective dps). That is the trap the
first two measuring runs fell into, and it nearly caused a wrong re-balance of the King.
**Measured: 105.4 s at 78 dps, inside COMBAT.md §12's 60–120 s window**, phase crossed exactly
once, telegraphs throughout, frame released on death; the same run pulls the hexer circle and
proves a cast, a charge and melee land on the player at once. The bot cannot dodge, so it is
kept alive with `/ops/hurt fraction 1` — the number measures the BOSS's durability against a
competent player's damage, which is what §12 is about; feel is the owner's call.
`tools/smoke/p9-load.mjs` tops the world up to 150 active AI with transient `/ops/spawnwave`
waves (no respawn ticket, so a run never leaves the world heavier), drives the 20-bot swarm
through them, and reads the server's own histogram: **tick p95 4.19 ms of a 25 ms budget, RSS
179 MB of 700**. One client bug fell out of the new `/ops/tp` lever: the movement step resolved
against un-streamed ground, whose sampler answers `OCEAN_FLOOR_Y`, so a teleport predicted a
fall to −8 m; `stepMovement` now asks `hasDataAt` first and holds the column (NETWORKING.md
§3.2). 381 unit tests green; two-client, roll-probe, predict-lag, p9-visuals, p9-load,
browser-p9 and browser-p8 all pass on the same build.

**A2 (map editor) game-side half, 2026-08-04.** The live map is no longer a compiled-in
constant: the server resolves `assets_baked/map/current.json` at boot, reports it on
`/api/health`, and the client asks the SERVER which bake to stream before fetching a chunk
(NETWORKING.md §3.4 — the two must never walk on different maps; `MAP_VERSION` remains the
fallback for a dev checkout that only ran `pnpm world:generate`). `/ops/reload-map` loads a
newly published bake and swaps it under the running world (`World.applyMap`): enemies
re-seed from the spawners against the new ground, players keep their x/z and are re-seated
on it, discovery progress is kept (re-awarding it would make republishing a currency), and
a bad bake throws BEFORE the swap so the old map stays live. Connected tabs get the same
reload notice a new build gets.

**A3-c game-side half, 2026-08-05:** `fastTravelCost` (`formulas/travel.ts`) — the
WORLD.md §4.2 / ITEMS_LOOT.md §5 price of a shrine hop, `2 × distance-in-chunks` banded
5–40 g, plus `travelHops` for the unordered matrix. Nothing charges it yet (shrines become
interactable with the world-objects phase); it lives in shared because the map editor
previews the whole matrix while the owner places shrines, and a panel quoting a price the
game will not take is exactly the drift shared exists to prevent. **425 unit tests green.**
**A3-d game-side half, 2026-08-05:** migration 0015 + `mapEditorCollections` — the panel's
named selections and stampable prefabs. Editor-side only (a prefab flattens to plain
placements when stamped), in Postgres rather than a browser because both are shared between
the owner and any GM (DATABASE.md §4).
**A2/A3 are closed panel-side (2026-08-05) and the world is editable end to end.** The
panel's `map-scenario.mjs` sculpts an islet out of open water, populates and zones it,
publishes, and this server hot-swaps onto it with no restart — that whole loop is proven
against a running game, not mocked. The game-side follow-up that landed here: **published
map bakes are machine state.** They are written into `assets_baked/map/` next to the
committed `dev-2` fallback, so they are now git-ignored (`map-*/` + `current.json`) — a
`git pull` during `deploy/UPDATE.sh` must never repoint the live world at a bake from a dev
checkout — and `deploy/BACKUP.sh` archives the LIVE bake plus its pointer nightly
(`backups/map-*.tar.gz`, last 7). They were in neither git nor the backups before, which
made the published world the one thing a restore would not have brought back; the draft it
came from is in Postgres, so pg_dump covers re-publishing, and this covers putting the world
straight back. DEPLOYMENT.md §6 carries the contract.

**P10 — Gathering Professions is ✅ complete (2026-08-05).**
P10-A put the vocabulary in shared: `formulas/professions.ts` (the four professions, the
1/7/13/19/25 tier gates, profession XP with §1.3's back-country halving, channel time, proc
chance, gather range and the refusal reasons) and `content/resource-nodes.ts` — the
definition/placement split enemies already use, so retuning birchwood is one row rather than
two hundred placements, plus `rollGather` itself. Protocol v13 (`GatherOp` up;
`NodeStates`/`GatherState`/`ProfessionSync` down), migration 0016 for
`content_resource_nodes` + `character_professions`. P10-B built the runtime: nodes seeded from
the map's placements, **first-tap claim** (a second player is refused immediately rather than
racing), channels broken by range/damage/movement, respawn scheduling, write-through
profession XP, `/ops/setprof` and `/ops/respawnnodes` — tested by driving the real
`World.step()`, not a stub. P10-C shipped fishing (`formulas/fishing.ts`): cast → bite window
→ a reel bar whose fish path is a PURE FUNCTION of a seed and a time, so the client draws and
the server judges the same bar and only the seed travels. That is the one place in the game
where both sides track a fast-moving thing at once, and a marker sitting on a fish that is
told it missed is the worst thing a minigame can do. Four bugs came out of its tests, the
worst being **a bar that could not be won at all**; the marker physics were re-measured rather
than re-guessed. P10-D is the panel half (Dawned-Admin A1-e): Content → Professions authors
node definitions with a gathering preview that runs THIS repo's `rollGather`, and the map
editor's node layer places them — markers ringed at the definition's radius, and a map bake
that refuses a placement whose definition is not published.

**P10-F — you can gather it (2026-08-05).** The `F` prompt, the hold bar, per-profession
depletion beats (topple/crumble/puff/ripple, each leaving the definition's own spent model),
the fishing minigame (line → bite → reel bar whose catch zone is the fish PLUS its tolerance),
the `J` panel with four codex grids, and toasts. Two holes came out of LOOKING at screenshots
rather than from a failing test: the Professions panel had invented its own classes instead of
the `pv-*` shell every other panel uses, so it rendered as a see-through slab in the corner with
the debug HUD showing through; and the interact prompt sat on top of the fishing bar on a short
window while still offering `F` during a hold it would have cancelled.
**The reel was the real story: it could not be won through a real server.** The shared tests
play the bar with the press and the step at the same instant, which no player ever does — every
press goes up and the server applies it a tick later. Measured against the live server with the
strategy those tests call "the dumbest there is": **20/20 fish offline, 0/12 through the wire.**
Five bugs fell out of chasing that, in order of discovery: the client reset its whole bar
several times a second (the periodic correction carries the same seed a new reel does); a long
frame was CLAMPED rather than sliced, so a hitching client fell behind a fish it could see;
corrections cloned a value that was already stale, jerking a filling bar backwards; the server
stepped fishing BEFORE it consumed inputs, scoring every press one tick late; and it sampled the
Reel bit once per tick instead of once per intent, throwing presses away on catch-up ticks.
Underneath all of them, `MARKER_MAX_SPEED` 1.5 carried the marker half a catch zone in one
delayed tick, so the loop rang instead of settling — **0.9 now**, and the tests that pin
"beatable" include a tick of delay, because the zero-latency version of that claim is not about
this game. New: `tools/smoke/fishing-probe.mjs` (headless, plays the real protocol at the tick
rate and lands a fish), `tools/smoke/p10-probe.mjs` (browser: prompt → hold bar → deplete →
bag → xp → codex → the `J` panel → the fishing UI live on screen), and the `/ops/hook` lever,
which supplies the 0.8 s reflex a bot cannot — the same argument as `/ops/hurt` keeping the P9
boss bot alive because it cannot dodge. A `/ops/respawnnodes` that told no client was fixed with
them. How hard a T5 legendary should be was **Q27**, answered 2026-08-05 with the recommended
default: leave the reel as shipped and judge it in the playtest.

**P10-E — the gathering catalogue is content (2026-08-05).** 22 node models baked (a tree and
a bloom per tier, a fish per water, five ore rocks tinted per ore off ONE grey KayKit boulder,
a felled log + a spent rock for the depleted states), 41 new material/gem/proc/fish items with
unique game-icons, and all 21 node definitions authored through the panel's Professions editor
and published — then frozen into seed migration 0017. 65 T1–T2 placements planted across
Dawnshore and the Weald through the map editor's node layer; T3–T5 have definitions and
deliberately no coordinates until P12 sculpts their zones. Proof it reaches the game:
`/ops/respawnnodes` on the live server reports **65 nodes, 0 orphans**.
**The asset pipeline had to be fixed first.** Only SKINNED models were having their textures
compressed — fine while every prop came from KayKit's tiny shared atlas, and not fine the
moment a pack shipped 2K bark maps: the first tree baked at **23.5 MB** and five of them alone
blew the 64 MB total budget (the report caught it, which is what the report is for). Props and
items squeeze to 512 px webp now, and `PIPELINE_VERSION` joins every source hash so changing a
default transform re-bakes the tree instead of hiding behind a cache that only watches the
source file. **101 MB → 14.8 MB, with 22 more models in it.**
Two content bugs came out of checks rather than out of reading: (1) the first placement pass
put every fishing cluster on dry land and planted **zero** shoals — cluster entries are HINTS
now and the script searches outward for ground that suits them, refusing loudly if there is
none within 90 m; (2) **Dawnpetal was an ilvl-4 Dawnshore drop** while PROFESSIONS §4 calls it
the Elder Grove's T5 rare, so a "legendary" bloom sold for ten gold and fell out of a level-3
spore-dweller. Re-tiered, with Meadowbell taking its slot in the shore's loot table; found by
`gathering-content.test.ts`, which asserts the LADDER holds (every profession at every tier,
every gate reachable from the tier below, every node yielding something from its own band, no
two nodes sharing a model) rather than re-checking what the publish rail already gates.
The Gems & Ores pack was deliberately NOT used despite being the perfect fit: no license file,
third-party conversion, unattributable — recorded in CREDITS.md rather than quietly shipped.

**P10-G measured the DoD and closed the phase.**
`tools/smoke/browser-p10.mjs` takes woodcutting **1 → 10 in 458 real gathers** on the live
world — every one an actual `GatherOp`, no granted XP — with the T2 gate opening at gather 248
and 210 wealdoaks after it. Both numbers reproduce PROFESSIONS §1.3's closed form to the gather
(2980 xp ÷ 12, then 5040 ÷ 24), and that was checked AFTER the run rather than asserted before
it, which is what makes it evidence rather than a tautology. The same run proves the first-tap
claim with two real clients pressing together, the tier gate refusing then opening, relog
persistence and the `J` panel agreeing with the server. It grinds over the PROTOCOL, not in a
browser: at ~4 fps in a container Chromium turned 2.8 s per gather into 32, and 458 of those is
a run nobody executes — so the browser leg is a separate short session for the UI evidence.
**The fishing half needed a new lever to be measurable at all.** A rare is one weight in ten,
so "is the rare's bar winnable?" answered by fishing until one appears measures the yield roll,
not the reel. `/ops/fish` puts a named fish on the line (setup only — the bite, window, bar,
catch and xp are the untouched real path), and the probe now walks the ladder on purpose:
**all four bands the placed waters offer, four distinct bars, each landed within two casts**
(T1 common 0.180/0.160 → T2 rare 0.225/0.129, a clean monotone ladder). Epic and legendary have
definitions and no water until P12, which the run REPORTS rather than implying three rarities.
Two harness bugs fell out, both of the "silence looks like failure" kind: a caught spot depletes
and regrows on the normal 90–180 s timer, so a band's second cast was refused and then sat out
the deadline as if the bar had been lost; and the probe watched only the fishing state, so a
refusal was invisible — the first run to reach the T2 pool spent six minutes being told "your
profession level is too low" without hearing it. It listens to `GatherState` now and aborts a
band on a refusal instead of burning the budget. **`pnpm check` green at 587 unit tests**;
browser-p10 and fishing-probe both pass on the same build.

**P11 — Quests, POIs & Interactables is ✅ complete (closed 2026-08-06 on its measured DoD).**
P11-A put the vocabulary in shared: `content/quests.ts` (the 7-member step union, the four giver
kinds, dialogue nodes, `validateQuestFlow`), `content/npcs.ts`, `formulas/quests.ts` (the state
machine — `questAvailability` where a DISCOVERY gate hides a quest and a LEVEL gate locks it,
`advanceQuest` cascading one event through several steps, `eventCredit`), protocol v14
(`InteractOp`/`QuestOp` up; `QuestSync`/`QuestNotice`/`DialogueState`/`DiscoverySync`/
`InteractState` down) and migration 0018. **Nothing about a quest is predicted** — every op is a
request and the next `QuestSync` is the answer, which is P8's item rule for the same reason.
P11-B built the runtime: the quest log, interactables where **the verb comes from the object and
never from the client**, shrine attunement + `fastTravelCost`, POI discovery on the tick's step
0e, dialogue with stale-node rejection, `/ops/quest`, and `/api/content/quests|npcs`. A4 (panel)
is the editor, on one publish rail with the game's own `validateQuestFlow`.

**P11-C is the pilot content, authored through that editor and live.** 4 NPCs, 8 quests
(`author-quests.mjs` in the panel repo), 7 interactables, 6 POIs — one per POI kind — plus
4 baked props so nothing is a re-labelled rock (KayKit Dungeon chest + carved pillar, Quaternius
Fantasy Props crate + banner; both packs CC0 with license files, unlike the Gems & Ores pack P10
refused). Frozen into seed migration 0019. **Proven from the game side rather than from the
publish button**: the new `/ops/worldobjects` lever reports **4 NPCs, 7 interactables, 6 POIs,
0 orphans** on the hot-swapped bake — the counterpart to `/ops/respawnnodes` reporting node
orphans, and the only line that shows content crossed the repo boundary.
**Four bugs came out of running it, and three were invisible to every test that existed:**
(1) **the map editor and the bake validated NPC placements with DIFFERENT schemas.** A2 shipped
a local guess (`name` + `modelRef` + a walk routine) months before P11 defined the real one in
shared (`npcId`, composed appearance, no mesh), so the editor refused — with a 500 — exactly the
row the bake was written to emit. Both were real zod schemas, so nothing typechecked. The draft
store imports the shared one now, and `map-bake.test.ts` asserts the PROPERTY: a def the bake
accepts must survive the draft store, for every layer. (2) **the bake counted NPCs and never
wrote them** — the same shape as the A2/A3-e scatter bug, found the same way, and a count is not
evidence a row was written. (3) **a delivery credited a step it had just refused**: shared
credits a DELIVER on a `talk` at the named NPC (it cannot see an inventory), the server checks
the pack, and the refusal and the credit came from the same event — `applyQuestEvent` takes a
skip set now. (4) **`stepTarget` read `count` on a deliver step**, so "take 5 mossbloom to Bran"
wanted five separate conversations and the second one found a step it had already counted: the
quest could never finish. `count` on a deliver is the STACK SIZE; the target is 1.
Also closed: publish warns when a quest's `zoneId` names no zone on the map (the journal groups
by it), and the bake now refuses an NPC placement whose definition is not published.
**Every pilot quest says `zoneId: 'dawnshore'`, including the Weald chain** — only one landmass
is built, `verdant_weald` is open water until P12, and a journal heading for a place the player
has never been is worse than a slightly wrong label. Deviations from QUESTS_POI §6's specs are
tabled in that doc's new §6.1 rather than quietly absorbed.

**P11-D put it on screen.** Villagers are COMPOSED rigs (`world/world-objects.ts`), not baked
meshes — the same body+outfit+hair a player wears, which is what gives a quest giver the whole
UAL clip library for free. Interactables are baked props from the manifest, and both seat
themselves only once `hasDataAt` says the ground is real (the P8 market-post lesson). The quest
glyph over a head is SERVER-decided, never a client reading of the log. The client half of
protocol v14 landed with them (`QuestSync`/`QuestNotice`/`DialogueState`/`DiscoverySync`/
`InteractState` down, `InteractOp`/`QuestOp` up — the two encoders were missing from shared and
are there now), plus the `F` prompt for people and things (the client says "use this", never what
using it MEANS), the lower-third dialogue with a typewriter and per-class reward picks, the HUD
tracker, the journal `L`, the world map `M`, discovery banners and quest toasts.
**Four bugs came out of LOOKING at `tools/smoke/p11-probe.mjs`'s screenshots, and no test would
have caught any of them:** (1) **the four pilot villagers stood in a T-pose** — authored
`idleClip: 'Idle'` against a UAL library whose standing clip is `Idle_Loop`, and a rig plays
NOTHING for a name it does not have; fixed in the content (migration 0020, a repair, never an
edit to 0019), in the schema default, and in the client, which now falls back and warns.
(2) **the world map drew 2048 m of ocean** with the island as a smudge and four pin labels
overprinting; it frames on the chunks the BAKE emitted now — the bake's own answer to "where is
there a world", which keeps working when P12 raises four more isles. (3) **a conversation
followed you across the island**: `applyDialogueChoice` refused an out-of-range press but nothing
closed a dialogue that was simply left, so the panel was a remote control for an NPC — closed on
the tick now. (4) **`DiscoverySync` was sent once, at spawn**, so the map's fog never lifted
inside a session and the discovery banner — the phase's headline beat — could not fire at all,
because the client raises it from the diff between two syncs and there was never a second one.
A fifth, found the same way: a board quest with no authored `offer` dialogue opened NOTHING; a
posting is a synthetic dialogue node now, built from constants the resolver shares, with the
quest's own journal prose as the parchment.
Also moved to shared: `QUEST_REFUSALS`/`questRefusalText`, which lived in the server — the one
place those strings have to be readable is the HUD, and it could not reach them.
**`pnpm check` green at 638 unit tests**; `p11-probe.mjs` passes end to end.

**P11-E measured the DoD and closed the phase (2026-08-06).**
`tools/smoke/browser-p11.mjs` never reads the quest content or the map bake to decide what to do
next — every destination comes from the tracker line, the hint circle the MAP draws, the clue
prose, the roster of things this client has actually SPAWNED (`worldObjectList()`), or the `F`
prompt. That distinction is the whole difference between the DoD's sentence and a script that
already knows the answers. **Measured:** the found-object quest solved from prose alone (its clue
names no direction, so the run reads "east" out of the journal line and crosses the ring on probe
12 of 175, 70 m out) → `F — Open Torv's Lost Crate` → turn-in; the discovery loop firing for **all
6 POI kinds** with banner + XP + map reveal, each measured from a forgotten state at a staging
point 61 m clear of every ring (vista 835, landmark 557, cache 696, curiosity 278, camp 696,
shrine 1183 xp); and the whole four-link chain — the logging site found on probe 81 at 179 m, four
stumps by tag, stalkers in 89 s, five mossbloom in real `GatherOp`s, the delivery credited on
Bran's BARK, and the Mushroom King in **137 s** — ending on the per-class picker with all four
options on screen and the warrior's Wealdcleaver in the pack. Every link was confirmed LOCKED
until the previous one was handed in.
**The bug that mattered is a shipped client one: `setInteractState` had exactly ONE call site,
the build path.** The client learned which chests were spent when its world objects first seated
and never again — so a chest you emptied kept offering `F — Open` all session, a respawned one
never came back, and an attuned shrine kept saying "Attune". Nothing survived a relog, which is
why every earlier probe missed it: they touched a thing once and walked away. `onInteractState`
announces every message now (these carry no notice, which is why the existing hook could not see
them) and the world objects apply it live. Also found: quest **titles** are announced and never
stored (QUESTS_POI §6.2), and the debug HUD read "players 25" with one player online because
remotes hold every non-self ENTITY and 24 of them were mushnubs.
**Four content bugs came out of it, all authored-data mistakes no test could see:** four of five
kill hints pointed 85–170 m from their only spawner (the circles are typed in the quest editor
while the spawners live on another page, so nothing had ever compared them); both gather steps had
no circle at all; Hesta said mossbloom grows in the Weald when the placed mossbloom is 360 m north;
and the crate and stumps were one-shot, so opening the crate before Torv mentioned it ended "The
Lost Crate" before it started. `questHintCoverage` in shared + a panel publish cross-check now
catch the first class of these with the distance quoted.
**The harness's own lessons, all of the same shape — assuming an affordance the design does not
promise:** the world samples "have you entered somewhere?" once a second, so a sweep that
teleports faster finds nothing and blames the content; dialogue read off the typewriter loses the
last word of the sentence, which is where the compass direction lives; a fighter with no target
preference clears a MIXED camp's hexers while the quest's stalker stands off; a delivery is a TALK
and a villager answers with a bark, not a panel; a kill step ends the instant its counter fills,
which leaves the bot mid-camp with the heal off. Two content notes recorded rather than retuned:
"kill 3 Weald Stalkers" is the world's entire stalker population and "gather 5 mossbloom" comes
from a circle holding four nodes — both complete, neither leaves room for a second player. P12's
population pass. New lever `/ops/forget` (un-find POIs, zones, shrines or used objects), because
discovery is first-entry-only and without it the loop can be measured exactly once per character.
**`pnpm check` green at 642 unit tests**, 92 baked assets / 15.27 MB.

**P12-A — the Dawnlands have a shape (2026-08-06).** The panel had to gain the tool first: its
island button generates into the RESIDENT region (13x13 chunks, capped after 17x17 measured
7.5 M triangles a frame) and the world is 32x32, so a tool that can only see a fifth of the map
cannot compose an archipelago. Whole-world generation runs server-side now
(`/api/map/generate-stream`, admin-only, lock-held, checkpoint first, SSE progress) over ONE 2049²
height field -- the per-chunk erosion pass must skip the border rows adjacent chunks SHARE, which
leaves an un-eroded lattice every 64 m. Two things the old generator could not do: masks COMBINE
rather than overwrite (two overlapping isles make an isthmus instead of the second erasing the
first) and `carve` masks SUBTRACT, which is how a strait severs an isthmus the masks just merged.
That pairing is what lets the world be 55-60 % land AND have bridges that gate the path -- six
landmasses far enough apart to leave open water between them cannot cover that much of a 2048 m
box, so the isles are generated overlapping and the straits are cut afterwards, which is also what
a strait IS.
**Measured, and identical to what `pnpm world:preview` computes offline** (the proof that the
endpoint and the preview run one copy of the maths): 1024 chunks written, **766 carrying land,
57.6 % coverage** inside WORLD.md §1's 55-60 %, 0 unclaimed splat texels, every land vertex
standing in a zone, and **all six isles confirmed SEPARATE landmasses by flood fill**.
**That flood fill is the finding.** Typed by hand, three of the five original straits severed
NOTHING: the isles joined around the ends of the cuts and one carve sat at nearly a right angle to
where it belonged -- while a depth probe at each channel's own centre reported "open water" for all
five, which was true and completely beside the point. Straits derive their centre, angle and length
from the two isles they separate now. The preview also caught islets drowned inside their own
channel and land standing in no zone (which blocks publish), each before a single chunk was written.
**Nothing is published.** The new archipelago puts open water where the dev island was, so
validation refuses every P8-P11 placement -- 26 spawners, 4 NPCs, 65 nodes, the shrines, the crate,
the stumps -- as standing on a disabled chunk. That refusal is correct and answering it is P12-B
onward; the live game keeps serving the old bake until the content is on the new ground. Three
deviations (the north-west islet with no water to stand in, the mid-channel sandbar that would have
to be a 76 m mountain, and the Dawnsea becoming a real zone row because publish blocks on land in
no zone) are tabled in WORLD.md's new §7.1.

**P12-B — the world has towns (2026-08-06).** Seven zones (§2's six plus the Dawnsea), five
settlements as 40 buildings, nine Ancient Shrines on the travel graph, four bridges dressed with
35 plank sections. **The draft validates.**
**Bridges are GROUND.** The walkgrid runs one way: a prop can subtract from it (`solid` stamps a
footprint unwalkable, which is what stops you walking through a house) and nothing can add to it.
So a bridge model over a channel is scenery you swim under, and §1's "joined by bridges" would be
false. Each crossing is a 22 m neck of terrain raised back over its own strait by a `causeway`
mask, with open water everywhere else so the neck is a real chokepoint. Settlements get `plateau`
masks — levelled ground with smoothstepped edges, because a house on noise-generated terrain
stands on a slope. Both are recorded: Q30 asks whether to keep causeways or spend a phase giving
props walkable surfaces (which would also fix rooftops, jetties and fallen trunks).
**Three bugs, and only one was mine.** (1) The drowned-placement prune parsed `validateDraft`'s
prose for "sits on a disabled chunk" and reported success while 37 rows sat on drowned chunks —
props use a DIFFERENT sentence. It asks the chunks whether they are enabled now. (2)
`listObjects` had **no ORDER BY**, so it returned Postgres's physical row order, which changes
whenever a row is updated. Harmless while zones never overlapped; the Dawnsea's ring covers the
whole map, `zoneAt` takes the FIRST match, and an unchanged draft could have published Dawnshore
as ocean one time and not the next. Objects are ordered by id and the bake sorts zones by area
ascending — the smaller, more specific zone wins. (3) Ordering the zones broke a reachability
test, which turned out to be the real find: `findSpawn` took `zones.find(z => z.settlement)`,
fine with one settlement and a coin flip with five. **A new character could have woken up in
Rustpick Camp, level 24–30.** The starter settlement is the lowest level band now, tested through
the bake's own `meta.json`.
**Measured before anything was written**: the preview reads the ground under every building and
found Dawnhaven's harbour on a 37° slope and Sunwatch's farms on 44° (both plateaus were sized to
where the buildings are, not to the fact that only 55 % of the radius is flat), plus a shrine
standing in 8 m of ocean that took two moves to get onto land. All five settlements now read
**0.0 m spread on 0°**; all nine shrines are dry.
**22 building models baked** (114 assets / 17.99 MB of 64). The **Medieval Village Pack was
refused** despite ASSET_INVENTORY earmarking it for Sungraze — no licence file, FBX/OBJ only,
unattributable, the same call P10 made on Gems & Ores; the farmsteads come from the Buildings
Kit instead. The Buildings Kit's own licence judgement (no in-folder text, shipped as its
Quaternius siblings' CC0) is written into CREDITS rather than assumed, along with Ultimate Nature
Kit 2, which was already being shipped on that reasoning with nothing recorded.
**Still not published**: the world has towns and no inhabitants. P12-C onward.

**P12-C — the world has a bestiary (2026-08-06).** 50 enemy types, 124 camps, **400 enemies**:
Emberwood, Sungraze, Ashcrag and the Elder Grove authored, and every P4–P9 camp RE-PLACED,
because they stood on the dev island and that is open water now.
**A camp is a WISH, not a coordinate** — zone, bearing from that isle's heart, distance — resolved
by the panel's `placeAll` against the real height field: it spirals outward until it finds ground
above water, under 22° (14° for a boss arena), inside the right zone, clear of every town and of
the other camps, reporting WHY each candidate failed. The spiral is capped at 120 m on purpose:
an unbounded search always succeeds and quietly moves a camp a third of an isle away, which turns
an authored difficulty gradient into scatter and looks like it worked. Two wishes hit that cap and
were fixed rather than absorbed.
**Measured from the GAME, not the publish button.** New lever `/ops/camps` (the counterpart to
`/ops/respawnnodes` and `/ops/worldobjects`) reports **124 spawners, 400 wanted, 400 alive, 0
unresolved enemy refs, 0 camps that produced nothing**, per zone: Dawnshore 24/82, Weald 24/77,
Emberwood 24/80, Sungraze 24/85, Ashcrag 22/64, Elder Grove 6/12 — identical to the panel's
offline placement. Tick p95 **1.67 ms** of 25 with all 400 seeded, RSS 186 MB of 700.
**The blocker was the four KayKit skeletons: they baked with ZERO clips**, because the pack ships
meshes and animations in separate files, so the entire Emberwood band would have stood frozen and
slid. The pipeline gained `mergeClips` (ASSET_PIPELINE §2.1) — a NAME-based rebind of a shared
rig's channels onto the character's own skeleton, which THROWS on a joint it cannot match rather
than skipping it, and disposes the library explicitly because `prune()` cannot reclaim a merged-in
skin's joints. There is still no melee swing anywhere in the FREE pack, so rather than authoring
attacks that animate nothing (the P5 Spore Lobber bug on purpose) the undead are the archetypes
that rig CAN play — swarm, charger (the lunge IS the attack), caster — and the zone's melee grunt
is a hooded marauder on a Quaternius rig that owns a real strike. NPCS_ENEMIES §4.1/§4.2 carry the
as-built, including four things recorded rather than faked: no summon kind, no passive-flee state
(ambient fauna ship as `dummy`), root walls as a ring rather than geometry, and no directional
mitigation field.
**Enemies carry a content `tint` now** — §4 asks for a gold Sun Cactoro, an ember Skull Swarm and
a dark Bonelord Varkas, and Varkas wears the same mesh as four of the minions standing around him.
**Four bugs, and only one belonged to this phase.** (1) The clip generator **deleted a helper**
that lived in the file it rewrites whole: `missingClips` is the panel's publish cross-check, the
game repo never calls it, so `pnpm check` stayed green here and the break surfaced as a typecheck
failure in the OTHER repo. It lives in its own module now. (2) `clipForAbility` hardcoded
`CharacterArmature|`, which is a lie for every KayKit model — **no enemy on one could ever have
played an ability clip**; clip names are bare everywhere now and resolved in one place. (3) The
panel's Enemies page compared the RAW jsonb column when pruning drafts, so re-running a content
script republished the whole bestiary and showed 174 "changes" in a diff review whose only job is
to say what changed. (4) Found BY the new lever: the map draft still carried `ashen_reach` from
the dev island, and being a smaller ring it WON inside the savanna and the canyons — 9 camps
reported a zone WORLD.md does not have. `world:author` clears the zone layer now.
**`pnpm check` green at 656 unit tests, 138 assets / 24.09 MB.** The world is published in the dev
checkout (`map-1786002856`) so the camps could be counted; the quests, nodes and villagers come
back with P12-E/F.

**P12-D — the deep catalogue (2026-08-06).** **223 items live** (from 103): 60 weapons and
offhands, 57 armour, 25 jewellery, 22 consumables, 12 junk, 47 materials/fish, and the **6
Legendaries**, one per zone. 21 loot tables, 16 vendors, **256 icons baked with zero duplicates**.
T3–T5 authoring follows P8's contract exactly — identity is chosen (name, slot, ilvl, rarity,
attribute weights, one line of flavour), every number comes out of the ITEMS_LOOT §2 formulas.
Armour ships as SETS (Cinderplate, Ashweave, Sunplate, Duststride, Cragplate, Riftsilk,
Grovemail…): five slots with one authored name each, which is the opposite of the procedural
naming §8 forbids. Loot nests through per-tier pools so a zone names its gear once, and each boss
has its OWN table with no `nothing` entry at all — that absence is what makes §4's "guaranteed
Rare+" a property of the data rather than a promise.
**Item effects are real now, and they were not.** P8 shipped `itemEffectSchema` and a server
helper (`itemEffectPct`) that **nothing ever called**, so every Epic and every Legendary effect in
the game was decoration — the one thing "a handcrafted unique with a named effect" cannot be.
`equipmentBonus` folds `stat_pct` and `on_kill_gold` in SHARED (so the character sheet shows what
the server fights with — the same argument attributes are folded there), and the server applies
them to max HP, armour, move speed, damage dealt, healing done and kill gold. +3 shared tests.
Two design promises are recorded as OWED rather than faked: `on_hit_effect` has no consumer, so
Emberbrand's burn is a damage rider and the burn is written down in ITEMS_LOOT §9.1; and §4's
pity counter is a per-character server counter that does not exist — the floor is real, the pity
is not.
**The bug that mattered is content ownership.** `item_material_dawnpetal` was authored in BOTH the
item catalogue and the profession node catalogue at different ilvls, so whichever script ran last
won — republishing the items silently reverted P10-E's re-tiering of Dawnpetal from a Dawnshore
common to the Elder Grove's T5 rare, and put it back in a level-3 mob's loot table. Caught by
`gathering-content.test.ts`, which asserts the LADDER holds rather than re-checking rows. The
gathering materials belong to the node catalogue; the duplicate is gone.
**Every vendor moved**: the P8 shops were anchored on the dev island, which is open sea now.
Also: `pnpm assets:icons --fetch` reports EVERY missing slug instead of dying on the first —
59 of the 120 new icons needed a different author or a different name, and that is one run to
find out rather than fifty-nine.
**`pnpm check` green at 659 unit tests**, 144 baked assets. The map draft's `node` layer was
cleared: its 43 placements still carried dev-island coordinates, and P12-E re-places them.

**P12-E — the gathering ladder is planted (2026-08-06).** **362 resource nodes across the
Dawnlands** (from 65 on the dev island): 120 trees, 95 ore seams, 107 herb patches, 40 fishing
spots — **all 21 published definitions placed, 0 without a home** — with the five mainland zones
holding 70 each (24 trees / 19 ore / 19 herbs / 8 fishing) and the Elder Grove holding its 12
Dawnpetal and nothing else. **All five fishing bands have water for the first time**: P10-G
measured every bar the placed waters could show and REPORTED that epic and legendary had
definitions and nowhere to play them rather than implying three rarities; the ember run, the dune
water and the deep sea exist now. Proven from the GAME rather than the publish button —
`/ops/respawnnodes` reports **362 total, 0 orphans** on the hot-swapped bake (`map-1786008720`).
A cluster is a WISH resolved by the panel's `placeAll` — the same machinery the camps use — plus a
per-member ground check that reads the DRAFT CHUNKS and a 6-attempt retry shrinking toward the
centre. That retry is not polish: a fishing cluster beside a shoreline comes out **3 of 8 without
it and 8 of 8 with it**.
**The bug that mattered was invisible to every check that existed: 39 of 322 land nodes stood in a
zone they were never authored for.** `placeAll` validates the cluster CENTRE's zone; the members
scatter up to `spread` metres off it and were only ever asked about the GROUND. So 7 ashwood, 5
dawnstone and 5 duskthorn — Ashcrag's T5 band — stood in the T4 savanna, where nothing gates a
player from reaching them, and **4 of the 12 Dawnpetal grew in Emberwood**, which is P12-D's
content-ownership bug re-made out of geometry one day after the data version of it was fixed. The
member loop asks the DRAFT's zone layer now, ordered exactly as `bakeDraft` orders it (smallest
ring first — the Dawnsea's ring covers the whole map), and the retry that was already there
absorbed every stray at no cost: **362 placed, 0 dropped**. Found by comparing wished-zone against
resolved-zone AFTER the run — the same shape of evidence as `/ops/camps` finding `ashen_reach` in
P12-C. A count says the catalogue is complete and says nothing about where it stands.
**A second finding is two phases old: `waterLevel` was `null` for all 1024 chunks.** A chunk
declares its own water and the client draws a surface only where that value is not null, so the
generated world had no sea at all — 42 % of the map an invisible hole with the ocean floor at the
bottom of it — and **no fishing node could ever be authored**, because "submerged" is defined as
ground below its own chunk's water. Nothing had needed water to EXIST until this phase did, which
is why P12-A and P12-B both passed over it. WORLD.md §7.1 carries it; PROFESSIONS §1.6b is the
as-built for the ladder.
Panel side: publish now WARNS when one node id's placements are split across zones — the guard the
script fix cannot give, because the owner drags nodes by hand too. Warning rather than blocker, on
`questHintCoverage`'s precedent: two regions can be a design choice, 5 of 19 across a line is not.
**`pnpm check` green at 659 unit tests** here and **261** in the panel (+2 for the cross-check);
**400 baked assets / 24.72 MB** (144 models + 256 icons).

**P12-F — the world is inhabited (2026-08-06, quests still owed).** Measured from the GAME
(`/ops/worldobjects`): **41 NPCs, 61 interactables, 46 POIs, 0 orphans** against CONTENT_0.1
§1/§2's ~40 / ≥60 / ≥45. The POIs are exactly §1's mix (8 vista, 14 landmark, 8 cache, 10 camp,
5 curiosity); the interactables are 26 chests, 12 signposts, 8 campfires and the Elder Arch on
top of P12-B's 9 shrines and P11's 4 stumps. **Sixteen of the NPCs are bodies for P12-D's sixteen
vendor rows** — a shop with no shopkeeper is a vendor panel that opens out of thin air — and each
stands ON its vendor's `anchor`, because that radius is the proximity lease the server checks
before it will trade. A shopkeeper placed anywhere else offers a trade the server then refuses,
which is the worst kind of wrong: it looks like it works. Five settlements gained **68 dressing
props**; P12-B built them as forty building shells and nothing else, which reads as a diorama of
a town rather than a town.
**The asset pipeline had to grow two front doors first.** Three packs — Medieval Village, Low
Poly Nature, Desert, ~200 models — ship no glTF at all, and one of them owns the **only campfire
in the whole library** while WORLD.md §5 makes campfires a real interactable (sit → +regen
"Cozy"). A design object blocked by a container format is a worse reason than a licensing one.
`.obj` converts in memory now (`obj2gltf`, the `.mtl` in the source hash; FBX deliberately
skipped since every OBJ-only pack ships FBX of the same meshes); `scale` normalises a pack
authored outside metres, at BAKE time because an interactable placement carries no scale on
purpose; `emissive` lights the bonfire's `Fire` material and THROWS on a name the file lacks,
like `mergeClips` throws on an unmatched joint. ASSET_PIPELINE §2.2.
**Two silent bugs fell out of verifying that.** (1) Measuring a prop from its POSITION accessors
is confidently wrong — a glTF node carries a transform — and that reading called the bonfire
41 cm when it is 1.02 m, and the KayKit shrine **one centimetre** when it is 2.4 m tall.
`model-size.mjs` walks the scene graph and transforms all eight corners; a test pins nine props
to loose metre bands, because the failure it guards against is off by 2.5×. (2) `assets:build`
started from an empty asset map while `assets:icons` writes the same manifest, so a model
rebuild **deleted all 256 icon entries** — files on disk, report green, and every item, ability
and node in the game rendering a blank square. It survived because the habitual order is
build-then-icons, which is a trap rather than a workflow.
**The find that mattered is the Elder Grove.** Publish refused all five of its rows as "cannot be
walked to from the spawn", and it was RIGHT: the Grove has no causeway (Q30) and the open ocean
around it is disabled chunks the walkgrid marks Blocked. Two things were wrong. The portal was
authored backwards — §3.6 puts a "one-way ancient portal in Ashcrag" as a way IN, and it had been
placed in the Grove pointing out. And the reachability fill only walked the walkgrid, so it was
wrong about everything behind ANY portal, and would have refused exactly the design the world doc
specifies. It consumes portals as directed edges now, to a fixpoint so they chain, and only once
the portal's own mouth is reachable — otherwise a portal sealed inside the far side would declare
itself the way in.
**Recorded, not fixed:** §3.6's other route in — the long swim from the Weald's north cape — does
not exist. All **249 open-ocean chunks are disabled**, so the sea between the isles is void a
player cannot enter; three chunks of it separate the Grove from the mainland. Straits still swim
(their chunks contain land, so they are enabled); open sea does not.
**Owner decision folded (USER_QUESTIONS Q31):** every uploaded pack may be used, on the owner's
assertion of rights. Recorded rather than disguised — such packs are `ownerAsserted: true` +
`verified: false`, and the asset report names them once per run instead of per asset. That
reverses P10's Gems & Ores refusal and P12-B's Medieval Village refusal, both made on provenance
grounds that no longer apply.
**Still owed: the ~20 remaining side quests** (8 of §5's 28 are live from P11). Eleven of the new
quest givers are named by no quest yet, which the publish rail already warns about — the warning
is the honest state, not noise. **`pnpm check` green at 674 unit tests** here and **264** in the
panel; **416 baked assets / 25.42 MB** (160 models + 256 icons).

**P12-F closed with the quest set (2026-08-06).** **28 quests in 5 chains** — §5's exact target,
Dawnshore 7 / Weald 5 / Emberwood 5 / Sungraze 5 / Ashcrag 4 / Elder Grove 2, one chain per main
zone. 38 steps, 33 with a hint circle (the 5 without are `explore`, which never gets one — §1
rule 4 makes finding the place the objective).
**A hint is DERIVED, never typed.** A step declares WHAT it points at (`{ enemy: … }`,
`{ node: … }`, `{ object: … }`, `{ npc: … }`, `{ poi: … }`) and the authoring pass resolves it
against the live map draft — the same rows the bake reads — then circles the DENSEST cluster of
matches. Encircling EVERY match sounds right and produced a **327 m** ring when two camps sat on
opposite sides of an isle: a circle you can stand in the middle of and see nothing, which is not
what "roughly where" means. Matches outside the chosen cluster are reported rather than absorbed,
and a derived radius over 260 m FAILS the run instead of shipping a shrug.
**Repairing P11's pilot set was the find, and it is the same bug arriving by a different road.**
Five of its eight quests pointed **420–815 m** from their targets — not a typo this time, but the
WORLD moving: they were authored against the dev island and P12 re-placed every spawner, node and
villager under them. Repaired through the same resolver rather than re-typed, so it cannot rot the
same way twice. `quest_shore_lost_crate` was worse than a bad circle: the crate it names was pruned
as drowned back in P12-B, so a live quest referenced a placement that did not exist and no check
was looking for that. Re-placed. The Weald chain's four `zoneId: 'dawnshore'` labels became
`verdant_weald`, which is precisely the edit P11-C wrote down as owed ("open water until P12").
Teague became a villager: Hesta already owns the logging chain, and a second forester with the same
complaint and no work to hand out is an `F` that opens nothing.
**Recorded, not patched — Q32: Dawnhaven resolves to the Verdant Weald.** `zoneAt` takes the first
containing polygon, ordered smallest-area-first (P12-B's fix for non-determinism), and Dawnshore's
ring is 6 % LARGER than the Weald's where the two overlap — an overlap that contains the starter
town. A level-1 character is told they are in the level 6–12 zone, and ambience, discovery XP and
journal headings all follow. Publish already warns that 8 893 land samples sit in more than one
zone; this is that warning with a name. Three fixes measured (trim the rings / containment-then-
nearest-centroid / an authored priority); nearest-centroid ALONE is wrong — it drags 572 of 3 100
land samples into the Dawnsea. Not done here because re-pointing zone resolution moves the whole
world's ambience at once, which is its own slice.
**Verified from the GAME**: 41 NPCs, 62 interactables, 46 POIs, 0 orphans; 124 camps / 400 enemies;
362 nodes / 0 orphans; 28 quests / 5 chains served by `/api/content/quests`.

**P12-G measured the DoD and closed the phase (2026-08-06).** `tools/smoke/p12-dod.mjs` answers all
three DoD questions from the RUNNING WORLD rather than from the content published into it —
`/api/content/*` plus `/ops/camps`, `/ops/worldobjects`, `/ops/respawnnodes`, `/ops/metrics`.
**PASS on every row.**
**CONTENT_0.1 at 100 %**: 46 POIs, 62 interactables, 51 enemy types, 4 zone bosses + 1 world boss +
6 elites, 124 spawners, 41 NPC definitions and 41 placed, 223 items, 6 Legendaries, 16 vendors, 28
quests in 5 chains, 362 node placements of 21 types — and 0 orphan enemy refs, 0 dry camps, 0
orphan nodes, 0 orphan NPCs.
**The 1→30 route exists, measured rather than walked.** Per band, XP demand from the published
curve against supply from that zone's quests, discoveries and camps — Dawnshore 3 530 needed /
2 630 a clear / **0.8 clears**; Weald 23 450 / 8 675 / **2.2**; Emberwood 58 710 / 14 803 / **3.2**;
Sungraze 107 130 / 21 302 / **4.1**; Ashcrag 167 590 / 35 118 / **4.0**. Camps respawn, so >1 is
normal and the number to watch is whether it is MANY; 0.8 → 4.0 is a smooth ramp with no grind
wall, and every band has enemies inside its own level range. **`xpPerClear` is computed by the
SERVER** from what actually spawned (level, rank, `xpMult`) and added to `/ops/camps` for this —
reconstructing it offline would be a second copy of the spawn roll, which is exactly the drift
`killXp` living in shared exists to prevent. A bot walking 1→30 for real is many hours and would
answer the same question with less precision.
**Budgets with the whole world seeded**: tick p95 **2.41 ms** of 25, max 10.18 ms, RSS **193 MB**
of 700, 400 entities.
**One doc bug fell out of counting, and the check was wrong first.** The audit read `rank === 'boss'`
and reported ZERO bosses; the enum is `normal | elite | zone_boss | world_boss`. Fixing the check
surfaced the real thing: CONTENT_0.1 claimed FIVE zone bosses by naming Mossback among them, while
NPCS_ENEMIES §4 authors Mossback as a "mini-boss, quest" at Elite Grunt rank and WORLD.md §3 calls
it a quest target. The content was right and the COUNT was the drift — the Dawnshore's climax is an
elite, which is the right shape for a level 1–6 starter zone. Also fixed: an approximate target
("~370 nodes") was being tested with `>=`, which turned a 2 % shortfall into a red cross; the row
helper now mirrors how each target is WRITTEN (floor / exact / ~5 %), because a report that cries
wolf is one you learn to skip.
**Two DoD clauses are the owner's and cannot be self-certified**: every zone screenshot-reviewed
against its palette/mood spec, and the zone-by-zone walkthrough signoff. P12 is marked ✅ on its
MEASURED DoD per the 2026-08-05 decision; the walkthrough is outstanding.
**`pnpm check` green at 674 unit tests**; two-client sync passes on the same build.

**P12-H — the world can be DEPLOYED (2026-08-06).** Found by the owner, who merged P12 and ran
`deploy/UPDATE.sh` and was still standing on the dev island: "there is visually absolutely nothing
new besides having the World Map." Nothing had failed. **Code travels in git and the world does
not.** A published bake is git-ignored machine state — A2's own decision, so that a `git pull` can
never repoint the live world at a bake from somebody's dev checkout — and P12's `content_*` rows
were never frozen into a seed migration the way P8–P11's were. So an updated box has every feature
P12 built and the old test island to use it on, which is indistinguishable from an update that did
nothing. A phase whose output cannot reach production is not vertically complete (rule 1), which
makes this P12's work rather than P13's.
**`deploy/WORLD.sh`** runs the panel's own authoring chain against the panel on the box, in
dependency order (terrain → settlements → bestiary → items → nodes → places → folk → quests), then
verifies from the GAME's ops levers rather than from the publish button — the same argument every
phase since P9 closes on. Nothing in it reimplements placement or validation: every step rides the
normal publish rail, so what lands is what the panel would land and a bad step is refused rather
than published. Safe to re-run (the scripts prune on match, so a second run says "nothing to
publish"), `--from N` resumes a chain that failed halfway, confirm-gated, backup first.
**`UPDATE.sh` now NAMES the gap** when the health check reports `mapVersion: dev-2`, instead of
leaving it to be discovered by walking around. DEPLOYMENT.md §5.1 carries the contract, including
the table of what travels by which road.
**Freezing P12's content into a seed migration was considered and rejected**: it would carry 50
enemy types and leave the terrain and ~900 placements behind, so the box would end up with a
bestiary and nowhere for it to stand. The world is one thing and it moves in one piece.
**The blocker was a security hole the deploy path would otherwise have shipped.** Every `author-*`
script minted an admin account with a password that is a literal in a public repository. Harmless
in a throwaway dev container; a permanent back door on the VPS — and "run these on the VPS" is
exactly what deploying a world means. The panel's new `tools/content/admin-session.mjs` reads
`DAWNED_ADMIN_USER`/`DAWNED_ADMIN_PASS` and touches the `accounts` table only when neither is set,
so a deploy creates nothing and every published row is attributed to a person in `audit_log`; the
dev fallback mints a per-run RANDOM password on its own account (`zz_admin_content`, not the
smokes' `zz_admin_smoke`) and bans it at the end. The random password is the part that holds — a
crash can skip the ban, and what survives is then an account nobody can log into. Both paths were
verified against the running panel: supplied credentials published with no account created, the
fallback ended `banned`, and `world:author` (the TypeScript entry point) regenerated all 1024
chunks through it.
**The owner's first real run then found the bug this whole path had been hiding: the panel could
never publish a map on the VPS.** `dawned-admin.service` runs under `ProtectSystem=strict` with
`ReadWritePaths=/var/lib/dawned`, and the bake goes into the GAME checkout's `assets_baked/map`
(DEPLOYMENT §6) — outside it, therefore read-only. The unit was written at P0, months before A2
gave the panel a map to publish, so **map publish had been broken on a real box since the map
editor shipped** and nothing had ever tried it there; the dev container has no sandbox, which is
why every smoke passed. The unit grants it now, and since `UPDATE.sh` does not re-install units,
both `UPDATE.sh` and `WORLD.sh` drop a `10-map-writes.conf` on a box that lacks it.
**The errno is the reason this cost an hour**: a recursive `mkdir` into a read-only tree reports
**ENOENT**, naming a path whose parents plainly exist, so it reads as a missing directory rather
than a permission wall. `bakeDraft` catches the staging failure and names the cause now (+1 panel
test, provoked with ENOTDIR so it behaves identically as root), and `WORLD.sh` checks writability
in PREFLIGHT — proving it by creating a directory there from inside a copy of the live sandbox
(`systemd-run` with the unit's own `ReadWritePaths`), because the alternative is discovering it
after several minutes of terrain generation, which is exactly what happened.
`pnpm check` green at **674** here and **265** in the panel.

### Running it locally

```bash
pnpm install && pnpm build
pnpm --filter @dawned/server start     # game server on :8081
pnpm --filter @dawned/client dev       # client on :5173 (proxies /api and /game)
node tools/smoke/two-client-sync.mjs   # headless protocol check
node tools/smoke/browser-sync.mjs      # two real browsers (needs the client dev server running)
node tools/smoke/p11-probe.mjs        # quests/NPCs/map on screen (browser; --screenshots DIR)
node tools/smoke/p12-dod.mjs          # P12's DoD: content report, 1→30 route, budgets
```
