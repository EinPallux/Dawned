# Dawned — Development Roadmap to 0.1.0

> The build order. 16 phases (P0–P15), each a **vertical, playable increment** with a hard
> Definition of Done (DoD) — no phase closes with skeletons, placeholders-forever, or "we'll test
> later". The Dawned-Admin repo runs a synchronized track (A0–A6, its own ROADMAP.md) — sync points
> are marked ⚙ here. Sizes: S ≈ days, M ≈ ~1–2 weeks, L ≈ ~2–4 weeks, XL ≈ 4+ weeks of focused work
> (relative effort, not promises).
>
> **Status legend:** 🔲 not started · 🟨 in progress · ✅ done — update this file as phases move.

| Phase | Name                                     | Size | Status                        |
| ----- | ---------------------------------------- | ---- | ----------------------------- |
| P0    | Foundations & Walking Skeleton           | M    | 🟨 code done, VPS run pending |
| P1    | Accounts, Characters & Menus             | M    | 🔲                            |
| P2    | Terrain & World Streaming                | L    | 🔲                            |
| P3    | Movement, Netcode Core & Chat v1         | L    | 🔲                            |
| P4    | Combat Foundation                        | XL   | 🔲                            |
| P5    | Classes I — Framework, Warrior, Rogue    | L    | 🔲                            |
| P6    | Classes II — Mage, Cleric, Status System | L    | 🔲                            |
| P7    | Progression — XP, Stats, Skill Trees     | M    | 🔲                            |
| P8    | Items, Inventory, Loot & Vendors         | L    | 🔲                            |
| P9    | Enemies & AI Depth                       | L    | 🔲                            |
| P10   | Gathering Professions                    | M    | 🔲                            |
| P11   | Quests, POIs & Interactables             | L    | 🔲                            |
| P12   | World Building (the Dawnlands)           | XL   | 🔲                            |
| P13   | GM Suite & Live Ops                      | M    | 🔲                            |
| P14   | Polish, Performance, Audio & Hardening   | L    | 🔲                            |
| P15   | Release 0.1.0                            | M    | 🔲                            |

---

## P0 — Foundations & Walking Skeleton (M)

**Goal:** a deployed "hello world" that proves the whole pipe: repo → build → VPS → browser →
authoritative server echo.
**Scope:** pnpm monorepo (`shared`/`server`/`client` + `tools`), TS strict + ESLint/Prettier +
Vitest + lefthook wiring, `pnpm check`; Fastify+ws server skeleton with tick loop + metrics ring;
three.js client booting into a lit test scene; binary protocol v0 (hello/ping/echo cube movement);
asset pipeline v1 (gltf-transform + manifest for a starter subset incl. license ledger);
`deploy/` scripts real (DEPLOY/UPDATE/BACKUP/ROLLBACK, Caddyfile, systemd) and **executed on the
actual VPS**; CI script on push.
**DoD:** two browsers see each other's cubes move via play.pathlands.cc over WSS; UPDATE.sh
round-trips a change in <5 min; backup file exists; `pnpm check` green; license ledger for all
packs reviewed (ASSET_INVENTORY §9).

**Status (2026-08-02):**

- [x] pnpm monorepo (`shared`/`server`/`client` + `tools`), TS strict, ESLint 9, Prettier, Vitest,
      `pnpm check` green (37 tests), GitHub Actions workflow
- [x] `@dawned/shared`: binary protocol v1 (codec + 8 message types, fuzz-tested), the shared
      `stepMovement` formula, constants, dev terrain
- [x] Game server: Fastify + `ws`, drift-corrected 20 Hz tick loop, session/rate limiting,
      snapshot fan-out, metrics ring, localhost-only ops API, graceful shutdown
- [x] Client: three.js scene (terrain/water/sky/shadows), prediction + reconciliation +
      remote interpolation, pointer-lock mouselook, stamina/sprint/jump, chat, debug HUD
- [x] Asset pipeline v1: 17 starter assets baked with provenance; the report gate fails the
      build on unattributed files; CREDITS ledger auto-generated
- [x] `deploy/`: DEPLOY/UPDATE/BACKUP/ROLLBACK, Caddyfile, four systemd units
- [x] Automated DoD checks: `tools/smoke/two-client-sync.mjs` (protocol) and
      `tools/smoke/browser-sync.mjs` (two real Chromium clients) — both passing locally
- [ ] **Remaining: run `deploy/DEPLOY.sh` on the VPS** and re-run the browser check against
      `https://play.pathlands.cc` (needs SSH access to the box — owner action)

## P1 — Accounts, Characters & Menus (M) ⚙A0 starts after (schema live)

**Goal:** the full front door, production quality.
**Scope:** Postgres+Drizzle live; accounts/sessions/bans tables; register/login REST (argon2id,
rate limits, invite-code toggle, reserved names); login/register screen (3D dawn vignette, UI
design system v1: fonts, palette, panels, motion tokens); character CRUD (5 slots, soft delete);
**character create** (class carousel with posed rigs, body/skin tone/outfit/hair/colors — full
pipeline character bundles); character select dioramas; session resume; disconnect overlay. Security
checklist §7-P1.
**DoD:** a friend can register, create all 4 class characters (looks correct, animated), relog,
delete one — on the VPS, on 1080p and 1440p, with zero placeholder UI.

## P2 — Terrain & World Streaming (L) ⚙unlocks A2 (map editor terrain)

**Goal:** the ground under everything — chunked terrain tech + a dev island.
**Scope:** heightmap chunk format + splat shader (8 layers, 2 splatmaps) + skirts; chunk
streaming/residency rings + IndexedDB cache; heightfield collision + slope walkability
classification; water plane + shore blend + swim volumes; sky gradient + per-zone fog/light
profiles + zone polygons (data-driven); grass/foliage instancing with wind shader; dev island
authored via a temporary in-repo script (replaced by admin editor at A2/A3); world/minimap baseline
renders. Server terrain mirror for authoritative Y + walkability.
**DoD:** walk (debug controller) across a 1 km dev island at 60 FPS with streaming invisible,
zones tint fog/light on crossing, budgets measured and recorded.

## P3 — Movement, Netcode Core & Chat v1 (L)

**Goal:** the multiplayer _feel_ baseline — this phase is re-tested at 100 ms artificial latency.
**Scope:** shared `stepMovement` (run/sprint+stamina/jump/gravity/slopes/swim); pointer-lock camera
rig (+Alt cursor); client prediction + reconciliation; snapshot/delta protocol v1 + AOI grid +
interest events; remote interpolation (100 ms) + anim state machine (8-way locomotion blends,
jump/land, sprint lean, swim); nameplates; entity framework server+client; clock sync; lag-lab dev
tools (latency/jitter injection, netgraph overlay); chat v1 (global/system + bubbles); `/stuck`.
**DoD:** 5 real humans + 20 bots sprint-jumping around the dev island feel "LAN-like" at 100 ms
injected RTT (signoff checklist: no rubber-banding on slopes, dodge-free baseline), tick p95 <15 ms
at that load, prediction-mismatch test suite green.

## P4 — Combat Foundation (XL) — _the make-or-break phase_

**Goal:** fighting one enemy type feels **great** before any class/content breadth exists.
**Scope:** health/damage pipeline + combat math (formulas in shared, unit-tested); hurtbox
capsules + melee arc / projectile / ground-AoE / cone / dash hit tests; position history + lag
rewind; dodge roll (i-frames, rewind-aware) + stamina integration; basic-attack combo framework
(link windows, cancel rules, move-lock tables); stagger meter + hit reacts + knockback; floating
combat text; telegraph decal system (all shapes, colorblind patterns); death/respawn at shrines +
"Dawned" debuff; threat table core; **enemy AI v1** (Grunt archetype full FSM: perception, social
aggro, steering, leash, camps) with 2 tuned enemies (Glub, Mushnub); training dummies; hit-stop,
camera kick, flash-tint, kill beat — the whole §9 juice checklist; combat SFX slots (temp-sourced
now, final at P14).
**DoD:** the "10-minute demo": clear a Glub camp with basic combo + dodge only, at 100 ms lag-lab,
and it passes the COMBAT.md §9 checklist reviewed line-by-line; feel signoff from the owner
(explicitly: does it feel like Farever-smooth action combat? iterate until yes).

## P5 — Classes I: Ability Framework, Warrior & Rogue (L) ⚙A1 (content editors) in parallel

**Goal:** the data-driven ability pipeline + two full melee kits.
**Scope:** ability executor (costs/cooldowns/GCD/casts/channels/charges per COMBAT.md §4);
resources Rage & Energy+Combo; hotbar UI (cooldown radials, insufficient-resource states, proc
glow); buff/debuff bar v1; Warrior complete (8 abilities + block RMB + combo + anims + VFX + tuning
vs P4 content); Rogue complete (incl. Evasive stance, CP pips); ability content rows authored via
admin editor (A1) end-to-end (proving the content pipeline); VFX system v1 (pooled particles from
Kenney atlas, mesh trails, decals).
**DoD:** Warrior & Rogue each clear the P4 camp + a new Ranged-archetype camp using full kits;
every ability passes the juice checklist; ability numbers live-tunable from admin panel without
restart.

## P6 — Classes II: Mage, Cleric & Status System (L)

**Goal:** ranged/caster tech + healing + the full status-effect vocabulary.
**Scope:** projectile pooling + homing (Barrage), ground-target reticle flow (Meteor/Sanctuary),
cast bars (self + soft-target), Mage complete; ally-soft targeting + heal pipeline + Cleric
complete; status effects full set (chill/root/slow/stun/burn/poison/bleed/shield/HoT + DR rules) with
UI; interrupt system; Mana/potion economy pass; class balance pass #1 (dummy DPS envelopes).
**DoD:** all 4 classes solo the two test camps at level parity within tuning envelopes
(CLASSES.md §5); status effects all render/report correctly; 4-player mixed session (tank pulls,
cleric heals) plays clean at lag-lab settings.

## P7 — Progression: XP, Stats & Skill Trees (M)

**Goal:** kills mean something: 1→30 exists end-to-end.
**Scope:** XP sources + curve + level-ups (juice per PROGRESSION.md §1.3); stat points UI/server +
derived stats application; skill trees ×4 (server validation + lattice UI + respec at Mirror of
Dawn); ability unlock flow + toasts; `content_xp_curve`/nodes editable via A1 editors; dev
`/setlevel` (pre-GM-suite, gated).
**DoD:** grind a character 1→10 legitimately on test camps; trees allocate/respec correctly incl.
all Warrior/Rogue/Mage/Cleric node effects verified by targeted tests; unspent-point UX per design.

## P8 — Items, Inventory, Loot & Vendors (L) ⚙A1 item/loot editors required

**Goal:** the reward engine.
**Scope:** item system + rolled stats; inventory grid + paper-doll + tooltips + compare; equipment
stat application + weapon model attachment (visible weapons per class); loot tables + per-player
instanced bags + beams + Shift-F flow; gold + pickup juice; vendors (buy/sell/buyback, barter
rows); consumables (potions/food + E slot + Drink/Consume anims); icon pipeline live (every item
unique icon, rarity frames); first 60 real items authored (T1–T2 bands) via admin.
**DoD:** kill→loot→equip→visible weapon change→sell loop feels complete with juice; inventory
fuzz tests green (no dupes under parallel op storms); icon build fails on any unmapped item
(enforced); 60 items reviewed in-game.

## P9 — Enemies & AI Depth (L)

**Goal:** the full archetype language + the bestiary breadth machine.
**Scope:** Ranged/Caster/Charger/Swarm/Elite archetypes complete (incl. enemy projectiles with
dodgeable travel, caster interrupts, charge telegraph rects, swarm surround); boss framework
(rotations, 50% phases, arena leash, safe-wedge patterns); patrols + camps + spawn director +
population governor; enemy ability content rows; 12 enemy types fully dressed (anim/SFX/loot/XP)
across Dawnshore+Weald as the template set; Mushroom King (first real boss) complete.
**DoD:** Mushroom King solo fight hits COMBAT.md boss targets (60–120 s, 3+ mechanics, readable);
mixed camps (grunt+ranged+caster) create the intended "pick your fight" pressure; AI CPU within
budget at 150 active.

## P10 — Gathering Professions (M) ⚙A3 node placement tools required

**Goal:** all four professions shippable.
**Scope:** interactable framework final (prompts, hold-cast, server timers); nodes (tree topple,
rock crumble, herb pick, respawn scheduling); profession levels/XP/tier gates + panel + codex;
tool-prop auto-show + anims; fishing complete (cast/bite/reel minigame, water tables, rods by
tier); materials/fish item sets ×5 tiers; gather XP trickle; profession titles.
**DoD:** each profession 1→10 on the dev island feels good (timing, sounds, toasts); fishing
minigame tuned across 3 rarities; node respawn/depletion correct under multiplayer contention
(two players, one node — first-tap claim rule verified).

## P11 — Quests, POIs & Interactables (L) ⚙A4 quest editor required

**Goal:** the discovery layer: quests, dialogue, map, POIs.
**Scope:** quest framework (all step types, counters via event bus, prerequisites, chains);
dialogue UI + NPC framing + barks; journal + tracker + map hints; POI/discovery system (vista/
landmark/cache/camp/shrine/curiosity + XP + map reveal); world map UI (fog-of-unknowing, pins,
fast travel) + minimap final; interactables full set (chests, campfires+Cozy, signs, boards,
portal); shrine attunement + fast-travel costs; 8 pilot quests incl. "The Loggers' Silence" chain
end-to-end via the Quest Editor.
**DoD:** a tester who has never read our docs finds, accepts, completes and turns in a chain using
only in-game affordances; discovery loop (banner/XP/map) fires correctly for every POI type;
found-object quest works.

## P12 — World Building: the Dawnlands (XL) ⚙A2+A3 fully required (dogfood!)

**Goal:** the real world, authored with our own tools — the sandbox's heart.
**Scope:** archipelago terrain (island synth base + hand-sculpt per WORLD.md layouts); all 6 zones
painted (splat sets, ambience profiles, zone polygons); settlements built (Dawnhaven + 4);
bridges; all spawner/camp/patrol placement (~140); all resource nodes (~370); all POIs (≥45),
interactables (≥60), shrines (9); all NPCs placed with routines; remaining ~20 quests authored +
placed; remaining bestiary dressed (all 36 + 5 bosses + Ashwing); items T3–T5 + legendaries
authored (~210 total); world map bake + minimap tiles; walkability bake + perf passes per zone
(budgets hold in worst vistas).
**DoD:** CONTENT_0.1.md tables hit 100% (script-verified counts); full 1→30 leveling route exists
and was walked by at least one dev character per class archetype pair; every zone screenshot-reviewed
against its palette/mood spec; owner walkthrough signoff zone by zone.

## P13 — GM Suite & Live Ops (M) ⚙A5 in parallel

**Goal:** operating the world from inside and outside.
**Scope:** full GM command set + palette + GM panel tabs (GM_TOOLS.md complete); roles/grants;
audit log; chat final (local/whisper/mute + GM gold); announce/xprate events; ops API surface for
admin Live Ops (players, kick/ban, metrics, reload-content, announce); `/reloadcontent` diff-aware;
single-session enforcement + reconnect polish.
**DoD:** run a scripted "GM event night" (spawn waves, xprate, announces, a ban/unban, a rescue
teleport) entirely via GM panel + admin Live Ops; every action lands in audit log with correct
attribution.

## P14 — Polish, Performance, Audio & Hardening (L) ⚙A6 in parallel

**Goal:** from "feature-complete" to "feels finished".
**Scope:** audio full pass (all AUDIO.md buckets sourced/processed/mixed; music director; ambience
emitters); settings final (graphics presets incl. foliage/FX density, rebinding UI, a11y toggles);
day/night visual cycle (subtle, zone-tinted) + **weather system** (zone-profiled rain &
thunderstorms with distance-delayed thunder, post-rain rainbows — visual only, per WORLD.md §4.6)

- `/settime` & `/weather`; juice sweep (screen-edge vignettes, loot
  stingers, level fanfare, idle emotes, ambient critter density); performance closure (client
  worst-vista list @60 FPS, server 25-bot soak 24 h, memory leak watch); security closure
  (SECURITY §7 re-run, cheatbot regression, dependency audit, backup **restore drill**); onboarding
  hints; credits screen; disconnect/reconnect UX final; a closed alpha weekend with the friend group
- triage.
  **DoD:** alpha feedback triaged to zero P0/P1 bugs; all budgets green in CI report; the game plays
  start-to-30 with sound, settings persist, and nothing says "TODO".

## P15 — Release 0.1.0 (M)

**Goal:** ship it like it matters.
**Scope:** content freeze; full-clear balance pass (class × zone matrix, boss timings, economy
faucet/sink audit); release checklist (CONTENT_0.1 §9 + DEPLOYMENT drill: fresh DEPLOY.sh on a
scratch box, UPDATE.sh upgrade path, ROLLBACK test); CHANGELOG 0.1.0 written; version tag; deploy;
launch-day monitoring (dashboard watch, backup verified); post-launch hotfix window staffed
(owner + docs for triage).
**DoD:** 0.1.0 tagged & live at play.pathlands.cc; friends playing; backups running; a
`docs/POSTMORTEM_0.1.md` retro written (what to carry into 0.2 planning).

---

## Cross-repo sync (details in Dawned-Admin/ROADMAP.md)

| Admin phase                                                                           | Delivers                   | Needed by                                              |
| ------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------ |
| A0 Foundation (auth, shell, DB link)                                                  | after P1                   | A1+                                                    |
| A1 Content editors (items, abilities, enemies, loot, vendors, curves, world settings) | during P5–P8               | P5 ability rows, P8 items                              |
| A2 Map editor I — terrain sculpt/paint/publish                                        | after P2                   | P12 (early access for dev island iteration from P5 on) |
| A3 Map editor II — placement/spawns/zones/nodes/POIs                                  | after P9 systems stabilize | P10 nodes, P12 world                                   |
| A4 Quest & dialogue editor                                                            | during P11                 | P11 pilot quests                                       |
| A5 Live ops (players, dashboard, bans, reload)                                        | during P13                 | P13 event night                                        |
| A6 Validation/diff/publish polish + backups UI                                        | during P14                 | P15 release ops                                        |

## Post-0.1.0 direction (unscoped, priority-ordered draft)

0.2: Crafting & processing (materials → gear/food), group system + XP share, tools-as-items.
0.3: Duels (1v1), drop-trading, daily board quests, first dungeon (Ember Vault).
0.4+: more zones/isles, day/night & weather gameplay hooks (night spawns, storm events), housing?.
Never (per spec): open-world PvP, guilds/guild wars, raids, BDO-style enhancing, mounts.

## Working agreements (apply to every phase)

- A phase is **done when its DoD is checked**, demoed on the VPS, CHANGELOG updated, docs touched
  by the phase updated, and the next phase re-planned against reality.
- Feel-critical phases (P3, P4, P5, P6, P12) end with an explicit owner signoff session.
- No phase starts while a previous phase's "known broken" list is non-empty (bugs ride along only
  if consciously triaged as post-0.1).
- USER_QUESTIONS.md answers are folded into docs before the phase they affect starts.
