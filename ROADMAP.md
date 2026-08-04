# Dawned — Development Roadmap to 0.1.0

> The build order. 16 phases (P0–P15), each a **vertical, playable increment** with a hard
> Definition of Done (DoD) — no phase closes with skeletons, placeholders-forever, or "we'll test
> later". The Dawned-Admin repo runs a synchronized track (A0–A6, its own ROADMAP.md) — sync points
> are marked ⚙ here. Sizes: S ≈ days, M ≈ ~1–2 weeks, L ≈ ~2–4 weeks, XL ≈ 4+ weeks of focused work
> (relative effort, not promises).
>
> **Status legend:** 🔲 not started · 🟨 in progress · ✅ done — update this file as phases move.

| Phase | Name                                     | Size | Status                     |
| ----- | ---------------------------------------- | ---- | -------------------------- |
| P0    | Foundations & Walking Skeleton           | M    | ✅ done (live 2026-08-02)  |
| P1    | Accounts, Characters & Menus             | M    | ✅ done (live 2026-08-02)  |
| P2    | Terrain & World Streaming                | L    | ✅ done (2026-08-02)       |
| P3    | Movement, Netcode Core & Chat v1         | L    | ✅ done (2026-08-03)       |
| P4    | Combat Foundation                        | XL   | ✅ done (2026-08-03)       |
| P5    | Classes I — Framework, Warrior, Rogue    | L    | ✅ done (2026-08-03)       |
| P6    | Classes II — Mage, Cleric, Status System | L    | ✅ done (2026-08-04)       |
| P7    | Progression — XP, Stats, Skill Trees     | M    | 🟨 built, playtest pending |
| P8    | Items, Inventory, Loot & Vendors         | L    | 🟨 built, playtest pending |
| P9    | Enemies & AI Depth                       | L    | 🔲                         |
| P10   | Gathering Professions                    | M    | 🔲                         |
| P11   | Quests, POIs & Interactables             | L    | 🔲                         |
| P12   | World Building (the Dawnlands)           | XL   | 🔲                         |
| P13   | GM Suite & Live Ops                      | M    | 🔲                         |
| P14   | Polish, Performance, Audio & Hardening   | L    | 🔲                         |
| P15   | Release 0.1.0                            | M    | 🔲                         |

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
- [x] `deploy/DEPLOY.sh` executed on the VPS by the owner — **live and verified at
      https://play.pathlands.cc (2026-08-02). P0 closed.**

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

**Status (2026-08-02):**

- [x] Postgres 16 + Drizzle schema (accounts/sessions/characters/bans), committed migrations,
      argon2id register/login REST with throttles + lockouts, 30-day sliding sessions,
      character CRUD (5 slots, world-unique names, soft delete frees the name)
- [x] Protocol v2: authenticated Hello (token + character id), persisted-position spawn,
      appearance-carrying roster, single-session-per-account
- [x] Character pipeline: heads/outfits/hair/UAL clips baked + rig-verified (report gate),
      `assets:sync` into the client; 13 assets, 6.6 MB
- [x] Menus ("Cut Facets" v1): login/register on the dawn vignette, character select + create
      with live posed rigs and full appearance controls — verified at 1080p and 1440p
- [x] In-world composed rigs with locomotion states (idle/jog/strafe/sprint/jump); session
      resume verified (relog lands at the persisted spot, Δ 0.00 m)
- [x] Security checklist §7-P1 run and recorded (SECURITY.md); both smoke tests rewritten for
      the auth flow and green; CI runs against a real Postgres service
- [x] Deployed to the VPS and verified by the owner (2026-08-02): registration, character
      creation and two players seeing each other in the world all work in production —
      after fixing a swallowed-migration deploy bug (see CHANGELOG "Fixed — P1 VPS deploy").
      **P1 closed. A0 (Dawned-Admin) is unlocked.**

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

**Status (2026-08-02):**

- [x] Shared terrain core: ~25 kB chunk codec (65×65 f32 + 2×RGBA splat + water level),
      seam-continuous bilinear sampler, 2-bit walkgrid (walkable/steep/wade/blocked), zone
      polygon + ambience contract (zod), walkability inside the shared movement step
      (axis-separated slide, never traps) — protocol v3
- [x] Deterministic worldgen: ~1 km dev island (271 chunks, byte-stable across runs and
      verified against the committed artifacts), three zones with distinct ambience profiles,
      lake with per-chunk water level, walkgrid, south-beach spawn, worldmap + minimap renders
- [x] Client streaming: residency rings with IndexedDB cache, one amortized mesh build per
      frame, vertex-color splat terrain with skirts, shore-blended water, zone fog/sky/light
      blending (~4 s settle), deterministic wind-swayed foliage instancing
- [x] Server mirror: full map in memory at boot (refuses to start without it), authoritative
      ground + walkability every tick, spawn ring at the baked spawn, stale persisted
      positions relocate
- [x] Verified: both smokes green on the island (server/client terrain agreement Δ0.000 m,
      0 hard corrections), zone crossing tints fog/light (Dawnshore → Verdant Weald / Ashen
      Reach), budgets measured in the worst forest view: **154 draw calls, ~441 k triangles**
      (≤300 / ≤500 k budgets) — recorded in CHANGELOG
- [x] Walked on real hardware by the owner (2026-08-02) — runs fine, streaming unobtrusive.
      **P2 closed. A2's terrain tooling is unblocked (once A0/A1 exist in Dawned-Admin).**

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

**Status: ✅ complete (owner-verified 2026-08-03) — protocol v4.**

- [x] Swimming in the shared movement step (deep >1.2 m, ×0.55 speed, swim-sprint stamina,
      fall-damage negation), water sampling via per-chunk levels, walkgrid `Water` semantics —
      22 terrain tests incl. a 10 k-tick shoreline parity fuzz (P3-A).
- [x] Server: AOI interest sets (96 m enter / 104 m leave / cap 80), 15 s reconnect grace with
      in-place reattach, `/stuck` (60 s cooldown), `kind` byte on snapshot entities — verified
      headlessly against a live server (P3-B).
- [x] Client: auto-reconnect inside the grace window (banner + frozen inputs), hold-Alt cursor,
      8-way jog blends + sprint-turn lean + swim clips (UAL bake extended), chat bubbles
      ("Cut Facets" canvas sprites), `/netsim` lag lab + netgraph HUD, void-terrain snapshot
      adoption after far teleports — `tools/smoke/browser-p3.mjs` drives all of it (P3-C).
- [x] Load + latency gates (P3-D): 20-bot swarm (`tools/bots/swarm.mjs`) + client → tick
      p50 0.66 / p95 1.0 / max 3.6 ms (<15 ms gate), ~42 kB/s total egress; prediction at
      100 ms ± 20 ms over 60 s sprint-jumping → corrections p95 39 mm, **0 hard snaps**
      (`tools/smoke/predict-lag.mjs`). Docs: NETWORKING.md §2/§5/§6/§8 as-built notes.
- [x] **Feel rework after the owner's first playtest** (movement "extremely bad"): fixed the
      swapped A/D strafe axis (screen-right sign, now unit- and browser-pinned), sub-tick
      render extrapolation of the local player over the 20 Hz sim (the reported lag was raw
      tick-stepped drawing), live-yaw model facing, gait retune to the clips' natural speeds
      (run = sprint cycle ~1.06×, walk band, jog for strafes — kills the skating), foot-phase
      carry across gait changes, sticky 8-way sectors, sprint FOV push.
- [x] **Playtest fix rounds 2–3** (2026-08-03): production CSP unblocked for GLB textures
      (blob: in connect-src — the untextured-white-world bug), map re-versioned dev-2 (stale
      cached walkgrid vs new server = shoreline rubber-banding), downhill ground snap in the
      shared step (grounded-state flicker + animation spam on every slope — protocol v5),
      an L/R clip-naming theory applied (viewer-perspective — later disproved on screen,
      round 5), deploy scripts bootstrap the admin panel and consume shared from the sibling
      checkout (no tokens).
- [x] **Playtest fix round 4** (2026-08-03, "animations switch around when walking"): the
      velocity→model-space transform double-negated yaw, reading headings as 2·yaw — every
      camera turn cycled the 8-way clips twice per revolution (invisible at yaw 0/π, which is
      all the old asserts swept). Fixed in `anim-math.ts` (unit-tested at arbitrary yaws), and
      the LOCAL player's 8-way heading now follows the held keys (yaw-invariant) instead of
      velocity, so even hard flicks can't churn sectors while the rendered velocity turns.
      Browser smoke gained a camera-spin + 180°-flick stability assert (verified to fail
      against the old code). Also fixed alongside: the `/admin` panel's blank page (Caddy
      `handle` kept the prefix the panel expects stripped — now `handle_path`, pinned by
      `packages/server/src/deploy-contract.test.ts` together with the CSP/caching contracts).
- [x] **Playtest fix round 5** (2026-08-03, owner-verified rounds 1–4 otherwise good): L/R
      clips were mirrored — the round-3 viewer-perspective naming theory was wrong; the UAL
      names are character-perspective (settled by the owner watching the rig). Mapping back
      to identity, leans flipped to match, and the browser smoke now pins exact L/R clip
      names for strafes, the S+D diagonal and the left-turn lean.
- [x] **Owner signoff on real hardware** (2026-08-03): group session verified — LAN-like
      feel at `/netsim 100 20`, no slope rubber-banding, bubbles/reconnect behave. P3 closed.

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

**Status: ✅ complete (owner-verified 2026-08-03 via the 10-minute demo) — protocol v6.**

- [x] Shared combat core (P4-A): class stat spreads + HP/weapon curves, the full damage
      formula (crit, variance, armor/resist mitigation, level mod, stagger-vuln and Dawned
      multipliers — injectable RNG, unit-tested), pure hit-shape math (melee arc, projectile
      sweep vs capsule, circle, dash sweep), stagger meter with exact-decay ticking, the dodge
      roll **inside the shared movement step** (0.55 s / 4.2 m, i-frames 0.05–0.35 s,
      25 stamina, 0.5 s cooldown, direction locked at start, grounded-only — predicted like
      any other movement, so no dodge desync), basic-combo data + link-window rules, and
      protocol v6 (AbilityRequest/Start/Resolve/Reject, EntityEvent, Telegraph, Projectile
      spawn/end, EnemyMeta, hp/flags in snapshots, ping echo for server-side RTT). 112 shared
      tests green.
- [x] Combat content as data (P4-B): `content_enemies` + `content_spawners` tables with zod
      defs (invalid published content refuses boot — fail loud, not weird), P4 seeds authored
      as published rows in migration 0003 (Shore Glub camps ×3, Mushnub pair, training-dummy
      line), `GET /api/content/enemies` serves defs to the client, and the enemy model + combat
      clip bake (`enemies_glub`, `enemies_mushnub` + UAL Roll/attack/hit clips) through the
      standard pipeline.
- [x] Server combat (P4-C): position-history rings + lag rewind (rewind = RTT/2 + interp
      delay, capped 250 ms; player attacks test rewound enemies, enemy hits honor i-frames
      live **or** rewound — player-favorable), the ability executor (combo validation, costs,
      contact-point scheduling, cleave arcs, projectile flight), Grunt AI FSM at 10 Hz
      (perception cone + hearing, alert beat, threat-table targeting, ranged/melee bands,
      heavy attacks with exact-shape telegraphs, seek+separation steering on the walkgrid,
      damage + social aggro, leash with invulnerable return, corpse → spawner respawn
      tickets), player death → control lock → shrine respawn with the 30 s −15 % Dawned
      debuff, threat core, and hp persistence. Headless probe:
      `tools/smoke/combat-probe.mjs` (15 asserts incl. combo chain, arc damage, alert
      discipline, telegraph shape, death/respawn loop).
- [x] Client combat (P4-D): LMB basic combo with predicted chain + instant swing anim
      (server-confirmed resolve), Mouse4/V dodge, enemy views from `EnemyMeta` + content defs
      (skeleton-cloned rigs, nameplates + HP slabs, ability/hit/death clips, desaturate-sink
      corpses), soft-target reticle plate, telegraph decals (exact server shapes, hatched
      fill — colorblind-safe by construction), pooled floating combat text (cap 40), local
      projectile integration between server spawn/end, death soul-screen → respawn button →
      Dawned chip, and the §9 juice pass v1: 60 ms hit-stop on confirmed hits, directional
      camera kick, capped shake, enemy flash tints, WebAudio temp SFX slots (swing/impact/
      dodge/death — final sourcing at P14). Browser smoke: `tools/smoke/browser-p4.mjs`
      (15 asserts, screenshot trail).
- [x] Verification (P4-E): full `pnpm check` green; P3 regression smokes all green against
      the v6 stack (browser-p3 21 asserts, two-client-sync, browser-sync, predict-lag →
      corrections p95 56 mm / 0 hard snaps at 100 ms ± 20 ms); tick perf **with a live camp
      fight**: p50 0.14 / p95 1.17 / max 4.5 ms (<15 ms gate), RSS 129 MB.
- [x] **Playtest fix round 6** (2026-08-03, first owner combat session): flinches moved to
      overlay blending — routing them through the base layer had frozen the whole rig under
      camp fire ("combat has no animations at all"), and one-shot actions now reset before
      replay / never source crossfades from finished actions; enemy swings stretch across
      wind-up + recover (no more mid-lunge freeze); telegraph cones un-mirrored (they drew
      180° behind the caster — geometry now unit-tested); over-the-shoulder camera so the
      crosshair floats beside the head instead of inside the model; death beat added (death
      clip + slow camera drift ~1.8 s before the soul screen fades in). New mixer-truth
      asserts in `browser-p4.mjs` (19 total) pin swings-under-fire, the Roll clip during
      dodge, enemy wind-up playback and the death clip. **Owner confirmed: `/netsim 100 20`
      combat stays smooth. Q17/Q18 answered (decision log).**
- [x] **Owner: the 10-minute demo** — Glub camp cleared with basic combo + dodge at
      `/netsim 100 20`, §9 behaviors seen live in the same session ("worked good",
      2026-08-03).
- [x] **Owner: feel verdict** — demo session positive, P4 closed by the owner. Combat feel
      stays a standing acceptance bar: every P5/P6 ability re-runs the §9 checklist against
      real kits, and tuning knobs (shared constants + content rows) remain one edit away.

**P4 closed 2026-08-03.** The P3 real-hardware group session stays open as a non-blocking
item — it needs friends online and can ride along with any future group playtest.

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

**Status: ✅ complete (owner-verified 2026-08-03, after fix rounds 7–8) — protocol v7.**

- [x] Shared ability core (P5-A): `content_abilities` zod schema (bindings slot/basic/rmb, costs,
      cooldowns/charges, casts/channels, 9 targeting kinds, ordered effect vocabulary incl.
      DoTs/marks/on-kill riders — a superset so P6's Mage/Cleric are data-only), the class
      resource model (Rage builds-in-combat/decays-OOC, Energy 12/s, Mana 100+10×INT, combo
      points ×5 with spend-all finishers; fractional accumulation so 20 Hz never starves regen),
      and the deterministic ability machine (evaluate → commit → tick: GCD, charges, cast
      release, dodge-interrupt refunds) that BOTH sides run. Protocol v7: AbilityRequest gains
      `targetId`, snapshots carry self resource+CP, EffectSync 0x96 + AbilityState 0x97, the
      Blocking entity flag. Migration 0004 + 165 tests total across the suites.
- [x] Server pipeline (P5-B): slot-request executor through the SHARED machine (rejects mean
      real divergence and ship an authoritative AbilityState correction), lag-rewound targeting
      for arcs/cones/PBAoE-pulse-trains/single, Charge through the shared dash, Shadowstep
      blink-behind, the buff/debuff runtime (same-caster stacking, periodic DoTs through the
      real damage path, caster-scoped marks, next-attack + on-kill riders, aggregate
      multipliers), RMB stances folded per intent (Warrior/Cleric frontal block + stamina absorb + perfect-block riposte window; Rogue Evasive speed/dodge-discount at 3 Energy/s), taunt
      override in the AI, and `/ops/reload-content` hot-swap.
- [x] Kits as content through the editor path (P5-C + A1): all 28 rows (16 slot abilities +
      12 basics ×4 classes) authored via the Dawned-Admin abilities editor API and published
      through publish v1 (validate → slot-collision cross-check → transactional copy → ops
      reload — the cross-check caught a leaked test fixture on its first live run). Basics now
      execute from content rows (Rage/CP riders on landed hits); ability clips baked with real
      durations. Migration 0005 freezes the published set for deploys (`ON CONFLICT DO
NOTHING` — a panel-retuned live row is never reverted by a redeploy).
- [x] Client ability layer (P5-D): hotbar presses 1–8 predicted through the SAME machine
      (instant anim + debit at any ping, local refusals with no round trip, rollback + wholesale
      correction on server rejects, an in-flight-spend hold so the resource globe never bounces),
      predicted dash/blink under one-RTT correction holds, per-intent stance/Evasive prediction
      with replay-stable modifiers, and the combat HUD cluster (twin faceted globes, cooldown
      radials + GCD sweep + ready ping, red refusal seam, CP pips with full-pip proc seam, cast
      bar, buff/debuff chips, target debuff strip, compact <1500 px breakpoint). Ability VFX v1:
      pooled bursts/trails/rings/wakes from the defs. RMB shield-up loops on your rig and on
      remotes via the Blocking flag.
- [x] Ranged-archetype test camp (P5-E): enemy projectile pipeline (volleys aimed at release,
      dodgeable by i-frames live-or-rewound, blockable frontally), band-holding + 60 %-speed
      kiting steering per NPCS_ENEMIES.md §1, and the Spore Ridge camp (3 Spore Lobbers east of
      the glub corridor) as published content — tuned after the first bot run proved 3 focused
      snipers overwhelm a non-dodging target.
- [x] Verification (P5-E): `pnpm check` green (165 tests); the full smoke ladder green in one
      server session — two-client-sync, combat-probe 15, browser-sync, browser-p4 19, and the
      new `tools/smoke/browser-p5.mjs` (21 asserts: content-driven hotbar, local Rage gating,
      rider-built Rage, Charge dash+cooldown, spend-and-land, Shield Wall on the buff bar,
      bleed + DoT ticks, perfect-block flag round trip, Twin Strike → pips → Eviscerate,
      Evasive drain, spore volleys + kill); live-tune DoD proven end-to-end (panel edit →
      publish → hot reload → game serves the new number → reverted the same way); tick perf
      with ability fights + projectiles: p50 0.36 / p95 1.21 / max 5.8 ms (<15 ms gate),
      RSS 200 MB.
- [x] **Playtest fix round 7** (2026-08-03, first owner kit session — "combat feels
      horrible"): real game-icons.net icons for all 28 rows through a new pipeline step
      (vendored SVGs, per-author license ledger, HUD renders them as masked tiles so states
      tint the icon), every slot ability re-timed out of 2.2–4.3× fast-forward into a
      0.96–2.4× band with fitting clips, cooldown timers that count the whole way down,
      lit/cold/locked/cooling tile states, refusals in words ("Not enough Rage"), and an
      impact pass (contact flash + spray, 90 ms hit-stop, camera kick/shake, kill pop).
- [x] **Playtest fix round 8** (2026-08-03): the cast-once brick (cd-0 commits burned a
      charge nothing refilled — both sides agreed, so it stuck; machine fixed + regression
      test + smoke double-press), ability VFX fans un-mirrored by reusing the telegraph
      cone geometry (one unit-tested orientation contract), migration 0006 pushing icons +
      anim retimes into already-seeded databases (0005 was edited in place and the runner
      silently skips applied files — doctrine now in DATABASE.md §5), swings while moving
      ride a bone-masked upper-body overlay so the gait keeps the feet honest (no more
      gliding LMB spam; flinches + block stance de-wobbled the same way), and the dodge
      roll preempts action locks at a readable 2.0× instead of losing its slot to long
      swings. Smokes hardened off three reproduced failure modes (role-committed bleed
      choreography, press-time cost re-checks, relative Evasive-drain windows).
- [x] **Owner: DoD demo runs** (2026-08-03, after fix round 8 — "works perfectly"): both
      camps cleared with the full Warrior and Rogue kits at `/netsim 100 20`; §9 checklist
      verdict positive.
- [x] **Owner: hotbar/HUD look check** (2026-08-03): the Cut Facets combat cluster reads
      right on the real monitor after the round-7 state/icon overhaul. P5 closed.

## P6 — Classes II: Mage, Cleric & Status System (L)

**Goal:** ranged/caster tech + healing + the full status-effect vocabulary.
**Scope:** projectile pooling + homing (Barrage), ground-target reticle flow (Meteor/Sanctuary),
cast bars (self + soft-target), Mage complete; ally-soft targeting + heal pipeline + Cleric
complete; status effects full set (chill/root/slow/stun/burn/poison/bleed/shield/HoT + DR rules) with
UI; interrupt system; Mana/potion economy pass; class balance pass #1 (dummy DPS envelopes).
**DoD:** all 4 classes solo the two test camps at level parity within tuning envelopes
(CLASSES.md §5); status effects all render/report correctly; 4-player mixed session (tank pulls,
cleric heals) plays clean at lag-lab settings.
**Status: ✅ closed 2026-08-04 (owner-verified — "classes are fine").** Shipped end-to-end:
shared caster/status core (protocol v8), server pipeline, both kits authored + published via
the panel (seed migration 0007), client casters, `tools/smoke/browser-p6.mjs` green (mage
kit, CC/DR/interrupt via the new `/ops/cc` GM primitive, two-client heals, envelopes,
4-player lag run). Potion economy is deferred to P8 with the consumable system (mana economy
itself shipped: costs/regen/Attunement, panel-tunable). Heal magnitudes flagged for panel
tuning as play data accumulates (heals scale on SP alone).

## P7 — Progression: XP, Stats & Skill Trees (M)

**Goal:** kills mean something: 1→30 exists end-to-end.
**Scope:** XP sources + curve + level-ups (juice per PROGRESSION.md §1.3); stat points UI/server +
derived stats application; skill trees ×4 (server validation + lattice UI + respec at Mirror of
Dawn); ability unlock flow + toasts; HUD **micro menu** (UI_UX.md §3 — mouse path to every
screen, grows with later phases); `content_xp_curve`/nodes editable via A1 editors; dev
`/setlevel` (pre-GM-suite, gated).
**DoD:** grind a character 1→10 legitimately on test camps; trees allocate/respec correctly incl.
all Warrior/Rogue/Mage/Cleric node effects verified by targeted tests; unspent-point UX per design.

**Status: ✅ built end-to-end 2026-08-04 (P7-A…E) — protocol v9; owner playtest pending.**

- [x] Shared progression core (P7-A): `content_xp_curve` (formula-exact defaults, panel-editable) + the full 96-node skill-tree contract (tiers/gates/capstones, 7-effect-kind vocabulary,
      allocation + aggregation helpers both sides run); protocol v9 (AllocateStats/Skill/Respec ↑,
      ProgressSync/XpGained/LevelUp ↓); migrations 0008/0009.
- [x] Server progression (P7-B): kill XP with tag rule + falloff + per-enemy `xpMult` + `xpRate`,
      zone-discovery XP, cascading level-ups with the §1.3 refill contract, allocation/respec
      validated with the SAME shared gates, write-through persistence, all 7 node-effect kinds
      folding live, `/setlevel` + `/ops/setlevel` dev path.
- [x] Content + panel (P7-C, with Dawned-Admin A1): the 29-row curve + all 96 CLASSES.md nodes
      authored through the panel's Content → Progression editors and published (hot reload); seed
      migration 0010; `GET /api/content/skill-nodes`; Q21 authoring defaults (USER_QUESTIONS.md).
- [x] Client progression (P7-D): bottom-edge XP bar + `+N XP` floaters, the full level-up juice
      (pillar, Celebration when idle, flash frame + bar sparks, chime, toasts incl. ability
      unlocks), `C` Character panel (staging + Confirm, suggested build, formula-transparent
      derived stats, respec), `K` Skills panel (climbing lattices, data-generated tooltips,
      click-to-allocate on shared gates), the §3 micro menu with banked-point badges, and the
      specced-character prediction folds (effective defs, movement/stamina/attack-speed/resource).
- [x] Verification (P7-E): `tools/smoke/browser-p7.mjs` grinds 1→10 legitimately on the live
      camps (kills only, accelerated via the xpRate + xpMult content levers, hot-reloaded and
      restored), proves tier gates open exactly with in-branch investment, capstone refusal at
      L10, both respec flavors with gold charges, UI evidence (bar/toasts/badges/K-panel) and
      relog persistence; the node-effect matrix test verifies EVERY published node at EVERY rank
      folds observably with legal refs (`progression-content.test.ts`); p7-probe + two-client
      regressions green.

## P8 — Items, Inventory, Loot & Vendors (L) ⚙A1 item/loot/vendor editors in parallel

**Goal:** the reward engine.
**Scope:** item system + rolled stats; inventory grid + paper-doll + tooltips + compare; equipment
stat application + weapon model attachment (visible weapons per class); loot tables + per-player
instanced bags + beams + Shift-F flow; gold + pickup juice; vendors (buy/sell/buyback, barter
rows); consumables (potions/food + E slot + Drink/Consume anims); icon pipeline live (every item
unique icon, rarity frames); first 60 real items authored (T1–T2 bands) via admin.
**DoD:** kill→loot→equip→visible weapon change→sell loop feels complete with juice; inventory
fuzz tests green (no dupes under parallel op storms); icon build fails on any unmapped item
(enforced); 60 items reviewed in-game.

**Status: ✅ built end-to-end 2026-08-04 (P8-A…E) — protocol v10; owner playtest pending.**

- [x] Shared item core (P8-A): item/loot-table/vendor zod schemas, the §2 budget formulas
      (`statBudget`, `weaponDamageFor`, `baseArmorFor`, `itemValue`, `sellPriceFor`,
      `ROLLS_BY_RARITY`), the plan/apply inventory model (`planMove`/`planSplit`/`planEquip`/…
      → `InventoryMutation[]` → `applyPlan`, one code path for both sides) and protocol v10:
      `ItemOp` (0x09, the only client-authored JSON envelope, zod-gated) plus `InventorySync`,
      `LootBags`, `VendorPanel`, `ItemNotice`, and `mainhandModel`/`offhandModel` on the roster.
- [x] Server items (P8-B): the authoritative inventory service (48-cell bag + paper-doll + purse),
      equipment stat folding into the P4 derived block, per-player instanced loot bags (60 s,
      4 m reach, `nothing` as a first-class weighted entry, nested tables with a cycle guard,
      shared kill-tagging with XP), gold, vendors with a proximity lease the server closes when
      you walk away, consumables on the shared cooldown lane, write-through persistence, and the
      `/ops/grant` GM primitive. No client prediction anywhere: every op is a request and the
      next full `InventorySync` is the answer, which is also what heals a refused drag.
- [x] Content + panel (P8-C, with Dawned-Admin A1-c): 12 weapon/shield models and 62 unique item
      icons through the pipeline, then the whole T1–T2 catalogue authored IN the panel and
      published — 62 items, 5 loot tables, 5 Dawnhaven vendors, the shore/weald enemy bindings —
      and frozen into seed migration 0012.
- [x] Client items (P8-D): the `I` panel (48-cell grid with drag/split/sort/search, paper-doll,
      rarity frames, tooltips with equipped-compare), loot bags as world props with rarity beams
      and the `F` / `Shift+F` flow, the vendor panel (buy/sell/buyback, server-priced), market
      posts with the `F` prompt, gold in the HUD, item toasts, `E` quick-drink, and visible
      weapons: the roster's model refs hang off the animated hand bones.
- [x] Verification (P8-E): `tools/smoke/browser-p8.mjs` runs the DoD loop for real — a bot grinds
      the shore camp until a published table pays out an ITEM, walks into reach, takes the bag
      with the real key, equips from the panel and sees the model reach the roster, reads a
      tooltip, finds all five market posts standing, trades at one, and relogs into the same
      pack/paper-doll/purse; the 5-seed × 4000-op inventory fuzz suite proves conservation; the
      icon bake now refuses duplicate item icons; earlier smokes (p8-probe, browser-p6/p7,
      two-client, browser-sync) green.
- [x] Playtest fixes round 2 (2026-08-04, **protocol v11**): the dodge roll was being cancelled by
      the client's own reconciliation — the snapshot carried no roll state, so once the server
      acked the one-input dodge press the replay could not re-create the 550 ms roll and the
      adopted correction cloned `rollTimeLeft = 0` over the prediction (3 of 11 ticks survived at
      80 ms RTT; 10 after). The self block now carries the roll (NETWORKING.md §3.1 states the
      general rule). Also: refused rolls name their reason and taps buffer 220 ms (COMBAT.md §7
      as-built); market posts wait for `hasDataAt` instead of seating on an un-streamed chunk's
      ocean floor (that is why vendors were invisible); held weapons are scaled per kind and bound
      to the animated skeleton's `hand_r` (ITEMS_LOOT.md §"Visible gear"). New `roll-probe.mjs`;
      `predict-lag.mjs` now gates the predicted roll's lifetime; `two-client-sync.mjs` no longer
      drifts its own fixtures apart. `pnpm check` green at 342 unit tests, browser-p8 green.

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
