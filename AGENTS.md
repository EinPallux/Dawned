# AGENTS.md — Dawned (game repo)

Instructions for AI coding agents working in this repository. **CLAUDE.md is the canonical,
complete version of these rules — read it first.** This file is the tool-agnostic mirror and adds
nothing beyond it.

## TL;DR for any agent

- **Project:** Dawned — low-poly browser 3D action-combat sandbox MMORPG (5–20 players), VPS-hosted
  (4 GB/1 core, Ubuntu 24.04, play.pathlands.cc). 0.1.0 must be a complete Early Access game, not
  an MVP. Companion repo: **Dawned-Admin** (editor/ops panel).
- **Truth lives in `docs/`:** ROADMAP.md = what to build now (phase gates with DoD);
  docs/design/_ = game design; docs/tech/_ = architecture/stack/security/deployment;
  docs/CONTENT_0.1.md = content contract; USER_QUESTIONS.md = pending owner decisions.
- **Hard rules:** no shortcut/skeleton implementations · server-authoritative everything ·
  content-as-data (edited via Dawned-Admin, never hardcoded) · TS strict, no `any`, zod at
  boundaries · client↔server share code only via `@dawned/shared` · combat/UI feel specs are
  acceptance criteria · no serif fonts, no generic rounded UI (follow docs/design/UI_UX.md) ·
  desktop-first 1080p/1440p, budgets in docs/tech/TECH_STACK.md · raw `assets/` never served —
  pipeline only (docs/tech/ASSET_PIPELINE.md) with license ledger.
- **Process:** work inside the current ROADMAP phase; run `pnpm check` before claiming done;
  update CHANGELOG.md `[Unreleased]`; update affected docs in the same change; put new design
  questions in USER_QUESTIONS.md with a recommended default.
- **Freshness checklist (every task, see CLAUDE.md):** ROADMAP row + phase block · CHANGELOG ·
  README status block · CLAUDE/AGENTS current state in BOTH repos · design/tech docs you touched
  · no hardcoded phase or version strings in the app (the HUD reads `build-info.ts`) ·
  USER_QUESTIONS · any counts you quoted.
- **State:** **P0–P8 all complete and owner-verified** (P6 closed 2026-08-04 — "classes
  are fine"; P7 + P8 closed 2026-08-04 after two playtest fix rounds — "I tested
  everything so far and all seems fine"); their A1 sync points landed in the panel
  (XP-curve + skill-tree editors, then items + loot + vendors). **P9 — Enemies & AI Depth
  is the current phase.** ALL fine-tuning is deferred to the end of the project by the
  owner's decision — never pause a phase to polish balance. P7 on top of the P5/P6 caster platform: the XP pipeline
  (kill tag rule, falloff, per-enemy xpMult, xpRate lever, discovery XP, cascading
  level-ups + §1.3 juice), attribute allocation + all 96 skill-tree nodes as published
  rows (seed migration 0010 — never edit an applied migration, DATABASE.md §5) with every
  effect kind folding on BOTH sides (effective defs, movement/stamina/attack-speed/
  resource prediction parity), respec, write-through persistence, the C/K panels + XP bar
  - level-up juice + micro menu. P8 on top of that: items/loot/vendors as content with
    the ITEMS_LOOT §2 budgets as shared formulas, the plan/apply inventory model (fuzz-
    proven conservation), an authoritative pack + paper-doll + purse that folds equipment
    into derived stats, per-player instanced loot bags, server-priced vendors with a
    proximity lease, consumables, and the client's `I` pack, world bags, market posts,
    vendor panel and VISIBLE weapons — nothing item-side is predicted, the next
    `InventorySync` is always the answer. Content: 62 items, 5 loot tables, 5 vendors
    authored in the panel and frozen into seed migration 0012. Dev levers: `/setlevel`,
    `/ops/setlevel`, `/ops/cc`, `/ops/hurt`, `/ops/grant`. Verified: `browser-p7.mjs`
    (legit 1→10 camp grind, tier gates, respecs, UI, persistence), `browser-p8.mjs`
    (kill → loot an ITEM → equip → model on the roster → tooltip → posts → trade → relog),
    the node-effect matrix test, the inventory fuzz suite, p8-probe/browser-p6/two-client/
    browser-sync, 336 unit tests. Heal magnitudes flagged for panel tuning. **Owner round
    after P8 (2026-08-04):** worn gear moved from the pack to the character sheet (`C` =
    header + slot columns + live rig + stats folded through the shared `equipmentBonus`;
    `I` = the bag alone), and stale-tab confusion is closed — client and server both carry
    a build id, a mismatch raises a reload notice, the HUD corner shows the build, API
    responses are `no-store` and every non-asset path is `no-cache`.
    **Playtest round 2 (2026-08-04) — protocol v11:** the dodge roll cancelled itself
    because the snapshot carried no roll state — once the server acked the one-input dodge
    press, the replay could not re-create the 550 ms roll and the adopted correction cloned
    `rollTimeLeft = 0` over the prediction (3 ticks survived of 11 at 80 ms RTT; 10 after
    the fix). The self block now carries the roll; the general rule is in NETWORKING.md
    §3.1 — **predicted state that outlives its trigger input MUST be on the wire.** Plus: a
    refused roll names its reason (shared `dodgeRefusal` → HUD) and taps buffer 220 ms;
    market posts wait for `ChunkTerrain.hasDataAt` instead of seating on an un-streamed
    chunk's `OCEAN_FLOOR_Y` (that is why vendors were invisible); held weapons are scaled
    per kind, gripped up the shaft, and bound to the bone in the skinned mesh's skeleton (a
    composed rig has several `hand_r`). `two-client-sync.mjs` no longer drifts its fixtures
    apart (both `/stuck` first, walk-back in a `finally`); new `roll-probe.mjs` and a roll
    gate in `predict-lag.mjs`. 342 unit tests green.
    **P9 — Enemies & AI Depth (in progress):** A/B/C/D built, E (verification) left.
    Shared owns the archetype vocabulary AND the selection rules
    (`selectableEnemyAbilities`/`pickEnemyAbility`/`bossPhaseAt`) so AI and panel preview
    agree; protocol v12 completed the AI (charger lunge + overshoot punish, interruptible
    casts, swarm rings, kit-clipped stand-off bands, boss phases in an arena); 13 models
    baked and the Dawnshore+Weald bestiary (17 enemies, 20 spawners) authored through the
    A1-d editor, published, frozen into seed migration 0013. Shared `ENEMY_MODEL_CLIPS`
    records which clips each baked model owns — publish refuses an ability naming a clip
    its rig lacks (a P5 Spore Lobber swing had been animating nothing).
    **P9-D (client)** made the fights readable: a boss frame with a pip per declared phase
    and the announce read from the published def, enemy cast bars that shatter on an
    interrupt, absorb bubbles for self-shields, drawn (not typed) rank marks + tints,
    per-archetype wind-up audio with distance falloff. Closing it surfaced three holes,
    all found by looking at screenshots rather than by a failing test: `ground_circle`
    resolved as a melee cone instead of the circle it drew (it now lands on the target's
    ground and tests that circle), `self_shield` granted nothing (now a real timed absorb
    draining through the players' own `absorbFromShields`), and the gateway silently
    dropped the protocol's `cast` flag (the field is required now — NETWORKING.md §3.3:
    optional wire fields are a silent-failure trap). Nameplates no longer clip long names.
    New dev levers `/ops/enemyhurt`, `/ops/tp` and `/ops/spawnwave`.
    **P9-E closed the phase (built, awaiting the owner's playtest):** `browser-p9.mjs`
    BUILDS its level-12 warrior first (all 33 attribute points, every legal node, T2 gear)
    — an unspent level 12 does 30 dps where a built one does 78, and skipping that nearly
    caused a wrong re-balance of the King. Measured **105.4 s, inside the §12 60–120 s
    window**, one phase crossing, telegraphs throughout, plus a mixed-camp pull proving a
    cast, a charge and melee at once. `p9-load.mjs` reaches 150 active AI with transient
    spawn waves: **tick p95 4.19 ms of 25 ms, RSS 179 MB of 700**. The `/ops/tp` lever
    exposed a client bug — prediction resolved against un-streamed ground and fell to the
    sea floor; `stepMovement` asks `hasDataAt` first now (NETWORKING.md §3.2). 381 tests
    green.
    **P10 — Gathering Professions (in progress, 2026-08-05): A/B/C/D built, E–G left.**
    P10-A put it in shared — `formulas/professions.ts` (four professions, tier gates
    1/7/13/19/25, profession XP with the back-country halving, channel time, proc chance,
    range, refusal reasons) and `content/resource-nodes.ts` (definition/placement split,
    `rollGather`); protocol v13, migration 0016. P10-B is the runtime: nodes seeded from
    the map's placements, **first-tap claim** so a second player is refused rather than
    racing, channel breaks on range/damage/movement, respawns, write-through profession
    XP, `/ops/setprof` + `/ops/respawnnodes`, all tested through the real `World.step()`.
    P10-C is fishing: the fish's path is a PURE FUNCTION of a seed and a time, so the
    client draws and the server judges the same bar and only the seed travels — four bugs
    fell out of testing it, the worst a bar that could not be won. P10-D is the panel
    (Dawned-Admin A1-e): node definitions with a gathering preview that runs THIS repo's
    `rollGather`, and the map editor's node layer placing them. Left: models + material/
    fish items (E), the client gather/fishing/`J` layer (F), the 1→10 and
    two-players-one-node verification (G).

    **A2 game-side half (2026-08-04):** the live map is a published artifact, not a
    constant — the server resolves `assets_baked/map/current.json`, reports it on
    `/api/health`, and the client asks the server which bake to stream (NETWORKING.md
    §3.4). `/ops/reload-map` swaps a new bake under the running world: enemies re-seed
    from the spawners, players keep x/z and are re-seated, discovery progress is kept, a
    bad bake throws before the swap.
    **A3-c game-side half (2026-08-05):** `fastTravelCost` in `formulas/travel.ts` — the
    shrine-hop price from WORLD.md §4.2 / ITEMS_LOOT.md §5 (`2 × distance-in-chunks`,
    banded 5–40 g) plus `travelHops`. Nothing charges it until shrines become
    interactable; it is in shared so the map editor's cost matrix and the game cannot
    disagree. 425 tests green.
    **A3-d game-side half (2026-08-05):** migration 0015 adds `map_editor_collections` for
    the panel's selection sets and prefabs — editor-side only, nothing the game reads.
    **A2/A3 closed panel-side (2026-08-05):** the panel's §7 run sculpts an islet out of
    open water, populates and zones it, publishes, and this server hot-swaps onto it with
    no restart — proven against a running game. Game-side follow-up: published map bakes
    are MACHINE STATE. They land in `assets_baked/map/` beside the committed `dev-2`
    fallback, so `map-*/` and `current.json` are git-ignored (a `git pull` during
    UPDATE.sh must never repoint the live world at a dev checkout's bake), and BACKUP.sh
    archives the live bake + pointer nightly (`backups/map-*.tar.gz`, last 7) — they were
    in neither git nor the backups before. DEPLOYMENT.md §6.
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
    571 unit tests green.
