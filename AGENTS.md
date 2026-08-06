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
  (XP-curve + skill-tree editors, then items + loot + vendors). **P9 and P10 are both built
  and measured (2026-08-05) and owner-accepted; P11 — Quests, POIs & Interactables is
  ✅ complete — A/B/C/D built (protocol v14, client included) and E measured its DoD on
  2026-08-06. P12 — World Building is 🟨 in progress: A (the terrain) is built, B–G remain.** ALL fine-tuning is deferred to the end of the project by the
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
    **P9-E closed the phase:** `browser-p9.mjs`
    BUILDS its level-12 warrior first (all 33 attribute points, every legal node, T2 gear)
    — an unspent level 12 does 30 dps where a built one does 78, and skipping that nearly
    caused a wrong re-balance of the King. Measured **105.4 s, inside the §12 60–120 s
    window**, one phase crossing, telegraphs throughout, plus a mixed-camp pull proving a
    cast, a charge and melee at once. `p9-load.mjs` reaches 150 active AI with transient
    spawn waves: **tick p95 4.19 ms of 25 ms, RSS 179 MB of 700**. The `/ops/tp` lever
    exposed a client bug — prediction resolved against un-streamed ground and fell to the
    sea floor; `stepMovement` asks `hasDataAt` first now (NETWORKING.md §3.2). 381 tests
    green.
    **P10 — Gathering Professions ✅ built and measured (2026-08-05).**
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
    `rollGather`, and the map editor's node layer placing them.
    **P10-G measured the DoD:** `browser-p10.mjs` takes woodcutting **1 → 10 in 458 real
    gathers** (T2 gate at 248, 210 wealdoaks after) — both reproducing §1.3's closed form to
    the gather, checked AFTER the run rather than asserted before it — plus the first-tap
    claim with two real clients pressing together, the tier gate, relog and the `J` panel. It
    grinds over the PROTOCOL: headless Chromium at ~4 fps turned 2.8 s per gather into 32.
    Fishing needed a lever to be measurable at all — a rare is one weight in ten, so fishing
    until one appears measures the yield roll, not the reel. `/ops/fish` names the fish (setup
    only); the probe then walks **all four bands the placed waters offer, four distinct bars,
    each landed within two casts**. Epic/legendary have no water until P12 and the run says so
    rather than implying three rarities. Two harness bugs, both "silence looks like failure": a
    caught spot regrows on the normal timer so a band's second cast sat out its deadline as a
    lost bar, and the probe never decoded `GatherState`, so six minutes of "your profession
    level is too low" were invisible. **587 unit tests green.**

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
    **P10-F — the client half (2026-08-05).** The `F` prompt, the hold bar,
    per-profession depletion beats (topple/crumble/puff/ripple, each leaving the
    definition's own spent model), the fishing minigame, the `J` panel with four codex
    grids, toasts. Two holes came out of LOOKING at screenshots: the Professions panel
    had invented classes instead of the `pv-*` shell every other panel uses (a
    see-through slab in the corner), and the interact prompt sat on the fishing bar on a
    short window while offering `F` for a hold it would cancel. **The reel could not be
    won through a real server** — the shared tests press and step at the same instant,
    which no player does. Measured: **20/20 fish offline, 0/12 through the wire.** Five
    bugs behind it: the client reset its bar several times a second (the periodic
    correction carries the same seed a new reel does); a long frame was CLAMPED not
    sliced, so a hitching client fell behind a fish it could see; corrections cloned a
    stale value, jerking a filling bar backwards; the server stepped fishing BEFORE
    consuming inputs, scoring every press a tick late; and it sampled the Reel bit once
    per tick, not once per intent. Under all of them `MARKER_MAX_SPEED` 1.5 carried the
    marker half a catch zone per delayed tick — **0.9 now**, and the beatability tests
    include a tick of delay. New: `tools/smoke/fishing-probe.mjs` (headless, real
    protocol at the tick rate, lands a fish), `tools/smoke/p10-probe.mjs` (browser), and
    `/ops/hook` for the 0.8 s reflex a bot cannot supply. `/ops/respawnnodes` told no
    client it had run; fixed. T5 legendary difficulty was Q27, answered 2026-08-05 with the
    recommended default: leave the reel as shipped and judge it in the playtest.

    **P10-E — the gathering catalogue is content (2026-08-05).** 22 node models baked (a
    tree and a bloom per tier, a fish per water, five ore rocks tinted per ore off ONE grey KayKit boulder,
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

    **P11 — Quests, POIs & Interactables ✅ complete (closed 2026-08-06). A/B/C:**
    P11-A put it in shared: `content/quests.ts` (7-member step union, four giver kinds,
    dialogue, `validateQuestFlow`), `content/npcs.ts`, `formulas/quests.ts` (the state
    machine — a DISCOVERY gate HIDES a quest, a LEVEL gate LOCKS it; `advanceQuest`
    cascades one event through several steps), protocol v14 and migration 0018. **Nothing
    about a quest is predicted** — every op is a request and the next `QuestSync` is the
    answer, which is P8's item rule. P11-B is the runtime: the quest log, interactables
    where **the verb comes from the object, never from the client**, shrine attunement +
    `fastTravelCost`, POI discovery at tick step 0e, dialogue with stale-node rejection,
    `/ops/quest`. A4 (panel) is the editor, on one publish rail running the game's own
    `validateQuestFlow`. P11-C is the pilot content, authored through it and live: 4 NPCs,
    8 quests (four Dawnshore one-offs + the four-part "The Loggers' Silence"), 7
    interactables, 6 POIs — one per kind — and 4 baked props so nothing ships as a
    re-labelled rock (KayKit Dungeon + Quaternius Fantasy Props, both CC0 WITH license
    files). Frozen into seed migration 0019 and proven from the GAME side by the new
    `/ops/worldobjects`: **4 NPCs, 7 interactables, 6 POIs, 0 orphans**.
    Four bugs came out of running it, three invisible to every existing test: the map
    editor and the bake validated NPC placements with **different schemas** (A2's local
    guess vs P11's shared row — both real zod, so nothing typechecked; the editor 500'd on
    exactly the row the bake emits); the bake **counted** NPCs and never wrote them; a
    delivery **credited the step it had just refused** (shared credits a DELIVER on a
    `talk`, the server checks the pack — same event, so `applyQuestEvent` takes a skip set
    now); and `stepTarget` read `count` on a deliver step, so "take 5 mossbloom to Bran"
    wanted five conversations and could never finish (`count` is the STACK, the target is
    1). Every pilot quest says `zoneId: 'dawnshore'` — only one landmass is built, and a
    journal heading for a place the player has never been is worse than a soft label;
    deviations from QUESTS_POI §6 are tabled in its new §6.1. **638 unit tests green.**

    **P11-D put it on screen (2026-08-05).** Villagers are COMPOSED rigs, not baked meshes —
    the same body+outfit+hair a player wears, which hands a quest giver the whole UAL clip
    library. Interactables are baked props; both seat only once `hasDataAt` says the ground is
    real (the P8 market-post lesson). The quest glyph over a head is SERVER-decided, never a
    client reading of the log. Client half of protocol v14 (the `InteractOp`/`QuestOp` encoders
    were missing from shared), the `F` prompt for people and things (the client says "use this",
    never what using it MEANS), the lower-third dialogue with a typewriter and per-class reward
    picks, the HUD tracker, journal `L`, world map `M`, discovery banners, quest toasts.
    **Five bugs came out of LOOKING at `tools/smoke/p11-probe.mjs`'s screenshots; no test would
    have caught any of them.** The four pilot villagers stood in a **T-pose** (`idleClip: 'Idle'`
    against a library whose standing clip is `Idle_Loop` — a rig plays NOTHING for a name it
    lacks; repaired in migration 0020, in the schema default, and with a client fallback). The
    world map drew 2048 m of ocean with the island as a smudge — it frames on the chunks the
    BAKE emitted now. A conversation FOLLOWED you across the island (out-of-range presses were
    refused; nothing closed a dialogue that was simply left). `DiscoverySync` was sent once at
    spawn, so the fog never lifted and the discovery banner could not fire at all. And a board
    quest with no authored `offer` dialogue opened NOTHING — a posting is a synthetic dialogue
    node now, built from constants the resolver shares. **638 unit tests green.**

    **P11-E measured the DoD and closed the phase (2026-08-06).**
    `tools/smoke/browser-p11.mjs` never reads the quest content or the map bake to decide what
    to do next — every destination comes from the tracker line, the hint circle the MAP draws,
    the clue prose, the roster of things this client actually SPAWNED (`worldObjectList()`), or
    the `F` prompt. That is the whole difference between the DoD's sentence and a script that
    already knows the answers. **Measured:** the found-object quest solved from prose alone
    (crossing the ring on probe 12 of 175, 70 m out) → `F — Open Torv's Lost Crate` → turn-in;
    the discovery loop firing for **all 6 POI kinds** with banner + XP + map reveal, each from a
    forgotten state at a staging point 61 m clear of every ring; and the four-link chain — the
    logging site on probe 81 at 179 m, four stumps by tag, stalkers in 89 s, five mossbloom in
    real `GatherOp`s, the delivery credited on Bran's BARK, the Mushroom King in **137 s** —
    ending on the per-class picker. Every link was confirmed LOCKED until the previous turn-in.
    **The bug that mattered is a shipped client one: `setInteractState` had exactly ONE call
    site, the build path.** The client learned which chests were spent when its world objects
    first seated and never again — an emptied chest kept offering `F — Open` all session, a
    respawned one never came back, an attuned shrine kept saying "Attune", and nothing survived
    a relog, which is why every earlier probe missed it (they touched a thing once and walked
    away). `onInteractState` announces every message now — these carry no notice, which is why
    the existing hook could not see them. Also found: quest **titles** are announced and never
    stored (QUESTS_POI §6.2), and the debug HUD read "players 25" because remotes hold every
    non-self ENTITY.
    **Four content bugs, all authored-data mistakes no test could see:** four of five kill hints
    pointed 85–170 m from their only spawner (circles are typed in the quest editor while
    spawners live on another page, and nothing had ever compared them); both gather steps had no
    circle at all; Hesta named the wrong region; and the crate and stumps were one-shot, so
    opening the crate before Torv mentioned it ended "The Lost Crate" before it started.
    `questHintCoverage` in shared + a panel publish cross-check now catch the first class with
    the distance quoted.
    **The harness's own lessons all have one shape — assuming an affordance the design does not
    promise:** the world samples "have you entered somewhere?" once a second, so a sweep that
    teleports faster finds nothing and blames the content; dialogue read off the typewriter loses
    the last word, which is where the compass direction lives; a fighter with no target preference
    clears a MIXED camp's hexers while the quest's stalker stands off; a delivery is a TALK and a
    villager answers with a bark, not a panel; a kill step ends the instant its counter fills,
    which leaves the bot mid-camp with the heal off. Two content notes recorded rather than
    retuned: "kill 3 Weald Stalkers" is the world's entire stalker population and "gather 5
    mossbloom" comes from a circle holding four nodes — both complete, neither leaves room for a
    second player (P12's population pass). New lever `/ops/forget` (un-find POIs, zones, shrines
    or used objects), because discovery is first-entry-only and without it the loop can be
    measured exactly once per character. **642 unit tests green**, 92 baked assets / 15.27 MB.

    **P12-A — the Dawnlands have a shape (2026-08-06).** Whole-world generation runs server-side
    in the panel (`/api/map/generate-stream`), because the editor's island button works on the
    RESIDENT region (13×13 chunks) and the world is 32×32. Masks COMBINE rather than overwrite so
    overlapping isles make an isthmus; `carve` masks SUBTRACT so a strait can sever one — which is
    what lets the world be 55–60 % land AND have bridges that gate the path. Erosion runs over ONE
    2049² field because the per-chunk pass must skip the border rows chunks share.
    **Measured, identical to `pnpm world:preview`'s offline numbers:** 1024 chunks, **766 carrying
    land, 57.6 % coverage**, 0 unclaimed texels, every land vertex in a zone, **all six isles
    separate landmasses by flood fill**. That flood fill is the finding — typed by hand, three of
    five straits severed NOTHING while a depth probe at each channel's centre said "open water" for
    all of them. Straits derive their geometry from the two isles they separate now.
    **Nothing is published**: the new sea sits where the dev island was, so every P8–P11 placement
    is on a disabled chunk. That is P12-B onward. Deviations in WORLD.md §7.1.

    **P12-B — the world has towns (2026-08-06).** Seven zones, five settlements (40 buildings on
    levelled `plateau` masks), nine shrines, four bridges + 35 plank sections. **The draft
    validates.** Bridges are GROUND: the walkgrid runs one way — a prop can make terrain
    unwalkable, nothing can make it walkable — so a bridge model over water is scenery you swim
    under. Each crossing is a 22 m `causeway` neck with open water everywhere else. Q30 records
    it and its alternative.
    **Three bugs, two latent since before P12.** The drowned-row prune parsed validateDraft's
    prose and missed props, which use a different sentence. `listObjects` had **no ORDER BY** —
    harmless until the Dawnsea's ring overlapped every land zone, after which an unchanged draft
    could publish Dawnshore as ocean one time and not the next (objects order by id; the bake
    sorts zones by area, smallest wins). And `findSpawn` took the first zone with a settlement,
    so with five settlements **a new character could have woken up in Rustpick Camp, level
    24–30**; the starter is the lowest level band now.
    Measuring the ground under every building found Dawnhaven's harbour on a 37° slope and a
    shrine in 8 m of ocean. All five towns read 0.0 m spread on 0° now. 114 baked assets /
    17.99 MB. Not published — the world has towns and no inhabitants.

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

    **The first world deploy found two more, and the worse one invalidated an A2 claim (P12-H).**
    (1) **A published world never reached the browser.** The client fetches `/assets/map/<version>/…`
    and `assets:sync` satisfied that by COPYING `assets_baked/map/` into the client's public dir at
    BUILD time. A map is published at RUNTIME — so on the VPS the server hot-loaded the Dawnlands,
    reported them on `/api/health`, and the browser 404'd every artifact: `map failed to load —
refresh` over a perfectly healthy world. **"The game hot-loads a new map without a deploy" was
    true server-side and false in the browser from A2 onward**, and never showed in dev because a
    rebuild follows a publish there out of habit. Both sides serve the bake DIRECTORY now — Caddy in
    production (`deploy/Caddyfile`), a Vite middleware in dev and preview (client `vite.config.ts`) —
    which also stops every published version being duplicated into the bundle at ~23 MB each.
    `deploy-contract.test.ts` pins the rule AND that it is declared before the client handler; proven
    by fetching meta/zones/walkgrid through the dev server with the copy deleted, and by a traversal
    attempt falling through.
    (2) `author-items.mjs` treated an EMPTY diff as a failed publish, so step 4 of a resumed world
    build died on `"nothing to publish"` with every row already correct. A draft identical to what is
    live prunes itself, which makes an empty diff the normal case for a re-run — the rule CLAUDE.md
    already wrote down after P10-E, applied in one place now
    (the panel's `tools/content/publish.mjs`). **675 unit tests green here, 265 in the panel.**

    **QA sweep + the live-edit deploy rules (2026-08-06, owner-requested before P13).** A targeted
    sweep of deploy/ops, security boundaries, publish rails, server authority and data safety.
    **The critical find: World Settings edits could never reach the game.** The server reads
    `content_world_settings WHERE status = 'published'` (`content/loader.ts`); the panel wrote DRAFT
    rows only and no publish route existed — A0's DoD was the draft round-trip and A1 never wired the
    surface in, though this file's own header claimed it had. There were **zero published rows in
    existence**, so the world has run on `defaultWorldSettings()` for eleven phases, `xpRate` included.
    Fixed with a transactional rail + `/ops/reload-content` + a Publish button (+1 panel test).
    Also found, ranked: content scripts silently revert panel edits (**fixed**, below); backup
    retention keeps up to 70 dumps at 65 MB with **no disk guard anywhere** — the disk fills, Postgres
    stops writing, the game dies; `ROLLBACK.sh` restores the database but not the map bake, so a
    rollback after a bad publish pairs yesterday's data with today's broken world; the ops-secret check
    is copy-pasted into all 19 `/ops` routes with nothing structural enforcing it; the 10/min per-IP
    login limit is shared by everyone behind one address (the panel's own suite trips it, which is how
    three unrelated suites failed with a bare "expected undefined to be defined"). Healthy: no
    unguarded panel routes, `/ops` unreachable through Caddy, `ItemOp` zod-gated, a malformed packet
    cannot touch the tick, migration journal consistent.
    **Two deploy rules, both owner decisions.** (1) `UPDATE.sh` updates EVERYTHING — code, deps,
    assets, migrations, services, Caddy — and the world too, but only when the panel's `tools/content`
    TREE HASH changed (`/var/lib/dawned/world.fingerprint`), so a code-only run does not spend ten
    minutes rebuilding correct terrain. A failed rebuild does not advance the fingerprint. A
    non-interactive run refuses the world step rather than half-doing it, because `WORLD.sh` needs the
    owner's login and that must never live in a file on the box. (2) **Nothing the owner changed in the
    panel is ever overwritten**: migration 0021 + `owner-edits.mjs` record the hash of each row as
    STORED after a script publishes it, and a row that no longer matches is kept and named.
    The bug worth keeping: the first version hashed what the script SENT, and the panel `.parse()`s
    every def on save — the first clean re-run called **200 rows owner-edited** on an untouched
    database. Both sides of the comparison have to be the stored row. Proven over four runs against a
    real database: adopt 218 → silent re-run → a hand-edited row survives → `--force-authored` puts the
    authored value back. DEPLOYMENT.md §5.1–5.3.

    **Every open finding from the sweep is closed (2026-08-06).** **The `/ops` gate is structural**: it
    was six lines copied into all nineteen handlers, all nineteen had them, and nothing made a twentieth
    route carry them — one `onRequest` hook gates every `/ops/` URL and `ops-guard.test.ts` asserts the
    PROPERTY (routes exist, one gate, no per-handler copies), so it cannot be quietly undone. Verified
    live: 401 with no secret, 401 with a wrong one, 200 with the right one, `/api` untouched. Comparison
    is `timingSafeEqual`, and **production refuses the default OPS_SECRET** — a literal in a public
    repository that opens every GM lever.
    **BACKUP.sh cannot fill the disk.** Retention kept up to 70 dumps at a size that went 11 MB → 65 MB
    the day the Dawnlands landed, and nothing anywhere ran `df`; a full disk stops Postgres writing and
    takes the game with it. Now a budget trimmed oldest-first BEFORE each run (never the newest of a
    series), a hard floor that refuses to add while the game keeps running, an early warning at twice
    the floor, and `--report`. Both paths exercised against a fake over-budget directory.
    **ROLLBACK.sh restores the world with the database.** The nightly backup had archived the live bake
    since 2026-08-05 and nothing used it, so a rollback paired yesterday's data with today's world.
    It pairs the map archive taken at or before the dump's own timestamp (`--map` / `--no-map`), sorting
    by the timestamp in the NAME rather than mtime — the comparison is on the name, and a copied file
    carries a new mtime while its name still says when it was taken. Caught by testing four cases,
    including a dump older than every archive.
    **680 unit tests green.**

    **The world you built is finally the world you see (2026-08-06).** Two mirror-image bugs, found by
    the owner reporting "I only see the NPCs + the Waypoint, nothing else but there are some invisible
    bounding boxes." **Nothing in the client ever read `placements.props` or `placements.scatter`** —
    `world-objects.ts` draws NPCs/interactables/POIs and `foliage.ts` scatters from splat weights, its
    header promising that hand-placed props "arrive with the map editor's placements at A3/P12", which
    nothing kept. The bake stamps every `solid` prop into the walkgrid, so all forty of Dawnhaven's
    buildings were collision with no mesh. **And `loadPropModels` never named `world/buildings`**, so
    even a client that asked for a house had no mesh to give it. `map-props.ts` draws both layers
    INSTANCED, seating each item only once `hasDataAt` says its ground is real, resolving scatter
    through the shared `resolveScatter` the editor previews with and the bake emits with. Built by its
    OWN loader, not folded into `buildWorldObjects` — that one awaits published NPC definitions, and a
    town has no business disappearing because the content API is empty; they were coupled for one
    commit and `tools/smoke/props-probe.mjs` caught it on the first run. That probe waits for the
    BUILD rather than a stopwatch: the static layers arrive after the map, walkgrid, nodes and
    villagers, which on a slow box is past any fixed sleep, and an early sample reports "placed NONE"
    for a client that was still loading — two false failures before it was fixed.
    **Production can never serve the dev island (owner: "No Dev Server, No Dev Instance, No Dev
    Island, nothing").** `assets_baked/map/dev-2` is COMMITTED, so 8.7 MB of test island lands on the
    VPS with every pull, while `current.json` — the pointer naming the live world — is deliberately
    machine state. Both halves fell back to the island silently: the server whenever the pointer could
    not be read (missing after a restore, truncated by a full disk), and the client whenever the health
    request failed, its own comment saying "if health is unreachable the constant still gets us onto
    the dev map". Either one looks exactly like an update that did nothing; together they put two
    players on different worlds. The server refuses in production and names the fix; the client no
    longer catches the health call into a guess. **The guards also had to be switched ON**: every
    production check here is gated on `NODE_ENV`, `DEPLOY.sh` writes it once at provision time, and
    nothing had verified it since — `UPDATE.sh` checks both env files every run now. `map-version.test.ts`
    pins it, including the corrupt-pointer case and a source assertion that the client's health call has
    no `.catch`, because that bug was one word long. **685 unit tests green.**
