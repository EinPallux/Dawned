# Changelog — Dawned

All notable changes to the game. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning: 0.x.y during Early Access (0.1.0 = first playable release, see ROADMAP.md).

## [Unreleased]

### Added — P7 Progression (in progress, 2026-08-04)

- **Shared progression core (P7-A, protocol v9):** the level curve
  (`round₁₀(90 × L^1.75)`, levels 1–30) now lives as editable
  `content_xp_curve` rows with completeness validation; kill XP
  (`8 + 6 × mobLevel^1.15`, ×1.5 elites / ×4 zone bosses, −10%/level
  falloff beyond 3 below, 10% floor, per-enemy `xpMult` honored, never
  rounds to 0), discovery basis-points and the `xpRate` world modifier are
  unit-tested shared formulas. Derived stats fold player-allocated
  attribute points (+3 banked per level) on top of the class spreads, and
  END now scales stamina regen. The full skill-tree contract shipped as
  content schema: 12 branches, tier gates (0/3/6/9/12 in-branch points OR
  level 2/5/10/15/20 — whichever is later; capstones 8 points + L25), and
  a closed per-rank effect vocabulary that expresses all 96 CLASSES.md
  nodes (stat scalars, conditional damage, per-ability rewrites + on-use
  riders, category effect mods, stance/passive tweaks, 8 proc shapes) with
  allocation/gate/aggregation helpers both sides run. New wire messages:
  AllocateStats/AllocateSkill/Respec up, ProgressSync/XpGained/LevelUp
  down. Migration 0008 adds `character_skills`, `content_xp_curve`,
  `content_skill_nodes`.
- **Server progression live (P7-B):** kills pay XP to everyone tagged
  (≥10% damage, or any heal on a tagger — Cleric-safe), scaled by rank,
  level gap and the panel's xpRate; entering a zone for the first time pays
  discovery XP with a chat toast; level-ups refill HP/stamina/resource and
  bank +3 attribute / +1 skill points. The Character sheet's allocation and
  the Mirror of Dawn respec (25×/50×level gold) are validated server-side
  with the same shared rules the client predicts, persisted write-through,
  and every one of the 7 skill-node effect kinds now folds into play
  (stats, per-ability rewrites, conditionals, stances, passives, procs —
  Second Wind, Colossus stacks, Righteous Echo, Flurry, auto-Aegis and
  friends all run). Dev `/setlevel` (gm/admin) + `/ops/setlevel` ship for
  the grind-free test path. Verified live: `tools/smoke/p7-probe.mjs`
  (join sync → setlevel 10 → allocation → relog persistence) plus the P4
  combat probe and the two-client smoke green on v9.
- **The trees are content (P7-C, with Dawned-Admin A1):** the full XP
  curve (29 rows) and all 96 skill-tree nodes from CLASSES.md are now
  published, live-tunable rows authored through the panel's new Content →
  Progression editors and its publish pipeline (diff → validate + tree
  cross-checks → transactional copy → hot reload) — tier layout and
  per-rank ramps follow the Q21 authoring defaults (USER_QUESTIONS.md).
  Seed migration 0010 carries the whole progression content set to fresh
  deploys, `GET /api/content/skill-nodes` serves the trees to the client
  for P7-D, and heal-over-time ticks can now carry a %-of-max-HP part
  (`periodic.pctMaxHpTotal` — how Immovable's 30% max-HP heal works for
  SP-less warriors). The p7 probe now allocates against the published
  trees and proves the tier-2 gate + skill-rank persistence on relog.
- **Progression on screen (P7-D):** the thin XP bar rides the bottom edge
  (segment ticks, hover numbers, purple `+N XP` floaters and a pulse on
  every award), and leveling up fires the full juice contract — gold
  pillar, the new `Celebration` animation when idle, a gold flash frame
  with sparks bursting off the bar, a chime, chat toast, ability-unlock
  toasts (click one to open Skills) and a banked-points note. `C` opens
  the Character panel (attribute +/− staging with Confirm, the one-click
  suggested build, derived stats that explain their formulas on hover,
  gold + attribute respec); `K` opens Skills (ability tiles with unlock
  levels + the three branches as climbing faceted lattices — invest by
  click, connectors light up, capstone at the crown, tooltips generated
  from the published node data with next-rank previews). A slim micro
  menu sits above the XP bar with badge pips for banked points. Under
  the hood the client folds allocated trees exactly like the server
  (effective ability defs, movement/stamina/attack-speed/resource
  scalars), so builds predict as tightly as fresh characters; discovery
  and level-up moments also surface as slide-in toasts.

### Added — P6 Classes II: Mage & Cleric playable with casts, channels and status effects (2026-08-03)

- **Two new kits, 16 abilities, authored as live-tunable content:** Mage
  (Fireball, Ice Lance, Frost Nova, Blink, Ember Wave, Mana Shield, Arcane
  Barrage, Meteor) and Cleric (Holy Smite, Mend, Hammer of Wrath, Radiant
  Burst, Sanctuary, Purify, Aegis, Dawnlight), each with its own game-icon,
  published through the admin panel like the P5 kits (seed migration 0007
  covers fresh deploys).
- **Cast bars and channels:** casting abilities show a fill-up bar (gather
  pose on the rig while it runs, release anim + bolt at the end); Arcane
  Barrage drains a violet channel bar with a pip per bolt. Moving cancels
  casts that demand standing still — with words, not silence — and abilities
  with a cast-while-moving fraction walk you at that speed while the bar
  runs (both sides, no rubber-banding). Dodge still cancels for half cost.
- **Ground quick-cast (Q19):** Meteor and Sanctuary fire at the terrain
  point under the crosshair (range-clamped, sky-aim falls back to max
  range). Your own decals draw gold — enemy telegraphs stay red.
- **Ally heals with a green plate (Q20):** Mend/Purify/Aegis pick the ally
  under your reticle (green target plate shows who), fall back to the most
  injured in range, then yourself. Absorb shields shimmer on the shielded
  body and their chip counts the pool down; heals float green numbers.
- **Hard crowd control on players:** roots pin your feet (turning free),
  stuns freeze everything and interrupt your cast (red bar flash +
  INTERRUPTED / ROOTED / STUNNED ribbon says why input is dead). Repeated
  CC in the same 10 s window halves, then immunizes — server-authoritative
  with client prediction parity, so none of it rubber-bands.
- **Class passives & stances in the HUD:** mage Attunement pips under the
  mana globe (every third landed bolt refunds mana), cleric Grace stacks
  shorten the next Mend bar (both sides compute the same bar), and the mage
  Focus stance (hold RMB) slow-strafes with a tightened reticle and faster
  bolts.
- **Caster VFX palettes:** fire abilities burst orange, frost ice-blue,
  arcane violet, cleric kits holy gold — derived from each ability's own
  effect data, so panel-made abilities color themselves.
- **Verified end to end:** `tools/smoke/browser-p6.mjs` drives the mage kit,
  the root/stun/DR/interrupt path, cross-client heals, class DPS envelopes
  and a 4-player mixed session under lag-lab jitter against the tick budget.
  Two GM primitives shipped for it (and for future moderation): `/ops/cc`
  (stun/root a player) and `/ops/hurt` (stage a wounded heal target) —
  localhost + ops secret only.

### Fixed — P6 verification round (caught before anything shipped, 2026-08-03)

- A dodge roll now cancels an active CHANNEL for half cost, not just casts
  (server missed channels; the predicted client already did both).
- The fractional `cast-while-moving` speed defined by the ability schema is
  actually applied while the bar runs (it was validated but never folded
  into movement) — on the server and in prediction, so no rubber-banding.
- A server-rejected cast press now also drops the predicted cast bar — the
  client no longer plays out a bar (and release flourish) for a spell the
  server refused.
- Blink and Purify break player roots: movement/any cleanses clear the hard
  root timer, not just effect rows — without this, P9's enemy roots would
  have been uncleansable.
- Heals float green `+` numbers with a soft sparkle instead of rendering as
  red incoming damage, and healing an ally no longer punches the healer's
  camera with the contact kick.

### Fixed — P5 playtest round 8: cast-once brick, mirrored fans, missing icons, gliding attacks, dodge roll (2026-08-03)

- **"I can only cast a spell one time" — real, and nasty.** Committing any
  zero-cooldown ability burned a charge that nothing ever refilled (only
  cooldown abilities arm a recharge timer), so every cd-0 spender bricked
  after ONE use — on the client AND the server, so the server agreed and no
  correction ever came. Charges are now only consumed by abilities that
  actually recharge; a regression test pins it and the P5 smoke now presses
  the same cd-0 ability twice.
- **Swing-trail fans mirrored again:** the ability VFX hand-rolled its fan
  sector and pointed it 180° behind the swing — the exact bug the telegraph
  decals had in round 6. The fan now reuses the telegraph module's
  unit-tested cone geometry (one orientation contract, one place), and its
  camera tilt no longer twists sideways at east/west headings.
- **"Still all the letters" — icons never reached already-seeded
  databases.** Round 7 regenerated migration 0005 in place, but the
  migration runner silently skips already-applied files, so any database
  migrated before round 7 kept icon-less, badly-timed ability rows forever.
  New migration 0006 surgically merges the icon + animation presentation
  into existing rows (balance numbers untouched, drafts included,
  idempotent). Doctrine added to DATABASE.md: never edit an applied
  migration.
- **No more ice-skating LMB spam:** swings while MOVING now play on a new
  upper-body overlay layer (masked to the torso/arm bones) so the legs keep
  the real gait — previously every swing froze the whole rig and the
  character glided. Standing swings stay full-body; starting to move
  mid-swing hands the rig back to locomotion; dash/blink abilities keep
  their full-body read. Flinches and the block stance ride the same mask
  now, so they no longer wobble the legs mid-run either.
- **The dodge roll actually rolls:** the roll was losing its animation slot
  to whatever swing was still playing (the action lock outranked it — worse
  since round 7's longer, properly-timed swings) and was fast-forwarded
  2.7×. Dodge now preempts any action instantly, clears attack overlays off
  the roll's back, and plays at 2.0× — crouch and full roll inside the
  550 ms dodge, recover tail fading into the run.
- Smoke hardening from three reproduced failure modes: the bleed assert
  commits to separate rage-builder and bleed-host dummies (ad-hoc target
  juggling starved on murdered arenas), ability presses re-check costs at
  press time (out-of-combat Rage decay made edge-exact presses refuse
  silently), and the Evasive drain is measured as free-vs-held windows
  (the displayed pool rides wire-floor jitter; the server drain itself was
  verified correct). Ranged-camp fixture to level 12.

### Fixed — P5 playtest round 7: combat readability & feel (2026-08-03)

The owner's verdict on the first kit session was blunt — no visible
cooldowns, no castable/uncastable states, no proper ability animations, no
impact, no icons. Root causes found and fixed:

- **Every ability has a real icon now** (owner request): a curated
  game-icons.net set — Crushing Blow `hammer-drop`, Shield Bash
  `shield-bash`, Charge `charging-bull`, Rending Slash `bleeding-wound`,
  Taunting Shout `shouting`, Whirlwind `whirlwind`, Shield Wall
  `edged-shield`, Earthshatter `quake-stomp`, Twin Strike `crossed-swords`,
  Shadowstep `shadow-follower`, Eviscerate `bloody-sword`, Fan of Knives
  `thrown-daggers`, Crippling Strike `broken-bone`, Poisoned Blades
  `dripping-knife`, Smoke Veil `smoke-bomb`, Death Mark `targeting`, plus
  per-class basics — 20 icons through a new pipeline step
  (`pnpm assets:icons --fetch`, vendored SVGs, license ledger with every
  author named, CC BY 3.0). The HUD masks them, so tile states tint the
  icon itself. Buff/debuff chips wear the icon of the ability that applied
  them.
- **Ability animations were playing at 2.2×–4.3× fast-forward** — the real
  reason combat looked animation-less: every kit press crammed a long clip
  into a short swing (Whirlwind squeezed a 4.3 s combo into 1 s; Shield
  Wall "played" an idle loop at 4.2×; Smoke Veil somersaulted the dodge
  roll). All 16 slot abilities re-timed into a readable 0.96–2.4× band
  with fitting clips (Shield Wall braces with the shield pop, Smoke Veil
  THROWS the bomb, Earthshatter gets the big overhead) — republished
  through the panel, deploy seed refreshed.
- **Cooldowns you can actually read:** the radial wipe darkened and the
  timer now counts the whole way down (tenths under 10 s, seconds above),
  in bright gold on every cooling tile.
- **Castability at a glance:** ready tiles are lit with a warm icon glow;
  unaffordable tiles go cold-dark with the cost in red; locked tiles are
  near-black with their `Lv N` tag; cooling tiles shade until the ready
  ping. And every refused press now SAYS WHY — a floating reason above the
  hotbar ("Not enough Rage", "Locked — reach level 6", "Needs combo
  points") on both local refusals and server rejects.
- **Impact you can feel:** every confirmed hit pops a bright flash at the
  wound plus a bigger spray (crits ~double, kills flash white), slot
  abilities hit with 90 ms hit-stop + a stronger camera kick + a shake,
  PBAoE casts shake on commit, and Shadowstep flashes out/in at both ends.
  Ability contacts use the heavy impact sound layer.

### Added — P5 ranged camp, deploy seeds & live-tune proof (2026-08-03)

- **Enemies can shoot now.** The enemy pipeline gained projectile volleys:
  bolts aim at the target's position at release (strafing during the draw
  changes the shot), fly dodgeable (i-frames count live or rewound) and are
  frontally blockable exactly like melee. Ranged-archetype steering holds
  the volley band and kites at 60 % speed when you close (NPCS_ENEMIES.md
  §1); panic-melee stays in the weighted attack pick.
- **New test camp: the Spore Ridge** — three Spore Lobbers (lv 3–5, mushnub
  rig) east of the shore-glub corridor, published content rows. Tuned after
  the first run: three focused snipers at full cadence overwhelmed a
  non-dodging target, so volleys now breathe (2.4 s cooldown, coef 0.8).
- **P5 content deploys itself:** migration 0005 seeds the 28 published kit
  rows (frozen from the editor-authored publish) + the Spore Ridge with
  `ON CONFLICT DO NOTHING` — a fresh database gets the kits, a live one
  keeps its panel tuning.
- **Live-tune DoD proven end-to-end:** Crushing Blow's coefficient bumped
  through the panel (draft → publish v1 → `/ops/reload-content`), the live
  game served the new number without a restart, then reverted the same way
  (`Dawned-Admin/tools/content/live-tune-proof.mjs` re-runs the proof).
- **The P5 browser smoke grew to 21 asserts** (three phases: Warrior kit,
  Rogue kit, ranged camp — volleys observed, bolts connect, Shadowstep
  closes the kite and the kit clears a lobber). Tick p95 under ability
  fights + projectiles: 1.21 ms (<15 ms gate).

### Added — P5 client ability layer (2026-08-03)

- **The combat HUD grew its real cluster (UI_UX.md §3):** twin faceted globes
  (HP left, class resource right) flanking an 8-slot hotbar with keybind
  glyphs, cost tags, conic cooldown radials with second countdowns, a GCD
  sweep, end-of-cooldown "ready" ping, insufficient-resource desaturation and
  a red seam pulse on refused presses; Rogue combo points as five diamond
  pips arcing over the resource globe (full-pip finishers get a rotating
  gold proc seam); a cast bar above the hotbar; self buffs/debuffs as
  faceted chips top-right and the soft-target plate gained a debuff strip
  (bleeds visibly tick). Below 1500 px the cluster compacts so chat never
  covers the HP globe.
- **Hotbar keys 1–8 cast the published class kits, predicted.** Presses run
  the SAME shared evaluate → commit machine the server validates with —
  costs, cooldowns, charges, GCD, unlock levels — so accepted casts animate
  and debit instantly at any ping and refusals answer locally without a
  round trip. Server rejects roll the prediction back and adopt the
  authoritative cooldown/resource state; snapshots re-base resources every
  50 ms (with an in-flight-spend hold so the globe never flickers a paid
  cost back). Charge's dash and Shadowstep's teleport are predicted through
  the shared movement state with correction holds sized to one round trip.
- **RMB stances are held-input verbs:** Warrior/Cleric raise the shield
  (looping overlay clip on your rig AND on remote players via the new
  Blocking entity flag, protocol v7) while Rogues enter Evasive — both
  predicted, both settled by the server per intent.
- **Ability VFX v1 (COMBAT.md §9):** pooled additive particle bursts, swing
  trail fans, expanding PBAoE ground rings, dash wakes and blink smoke —
  procedural sprites, per-school/class palettes, driven by the same content
  defs on your own casts, remote players' casts and confirmed impacts
  (crits pop harder). Temp-synth SFX gained `impact_heavy` and a dull
  `deny` tick for refused presses; ability rows pick their slot by id.
- **New browser smoke** (`tools/smoke/browser-p5.mjs`, 16 asserts): hotbar
  from published content, local Rage gating, rider-built Rage, Charge dash +
  cooldown, spend-and-land, Shield Wall on the buff bar, bleed + DoT ticks,
  the Blocking flag round trip, Twin Strike → pips → Eviscerate, and the
  Evasive Energy drain — run against the real client and server.

### Fixed — P4 playtest round 6 (2026-08-03)

- **Combat animations no longer freeze — swings, dodge and death all play
  under fire.** Root cause: incoming light hits routed their flinch through
  the rig's BASE animation layer, replacing whatever played and re-locking
  the rig 0.3 s per hit. Against a camp (a hit every ~250 ms) that lock was
  continuous, and repeated/finished one-shot actions were reused without a
  reset — three.js then renders them as one static frame at weight 0. Net
  effect: the character stood bolt upright through entire fights, swings and
  dodge rolls never visibly played, and dying mid-barrage skipped the death
  clip. Flinches are now blended OVERLAYS on top of the base layer (per
  COMBAT.md §6.4: light hits never take control), one-shot actions always
  reset before replay, and crossfades never source from a finished action
  (they cut + fade instead — a finished action can't drive a weight ramp).
  Enemy swing clips got the same lifecycle fixes and now stretch across
  wind-up AND recover, so glubs no longer freeze mid-lunge after contact.
  New mixer-truth asserts in `browser-p4.mjs` pin all of it — including
  "swing plays WHILE the camp is hitting you", which is exactly the case
  the playtest caught and the dummy-only smoke missed.
- **Enemy telegraph cones now point at you, not out the enemy's back.** The
  decal sector was centered on the wrong pole of the circle geometry, so
  every cone rendered 180° behind the caster — the ground warning and the
  actual server hit shape disagreed, breaking the "what you see is what
  hits you" rule. Unit tests now pin the orientation of all three decal
  shapes (`telegraphs.test.ts`).
- **The crosshair no longer drills into your character's back.** The camera
  aims over the right shoulder now (aim point raised and offset screen-right,
  BDO-style), so the reticle floats beside the head and the character sits
  just left of center — aim mechanics unchanged (attacks still fire along
  the camera yaw; the offset's angular error is inside the soft-target
  magnetism at combat ranges).
- **Dying got its beat (COMBAT.md §10).** The death clip plays while the
  camera drifts slowly around the body for ~1.8 s, then the soul screen
  fades in — it used to slam over the corpse the same frame. Mouse yaw is
  untouched during the drift, so control returns exactly where you left it
  on respawn.
- Owner-confirmed this round: combat at `/netsim 100 20` stays smooth; Q17
  (stagger decay default) and Q18 (mushroom training dummies) accepted —
  moved to the USER_QUESTIONS decision log.

### Added — P4 Combat Foundation (2026-08-03, protocol v6)

- **Enemies are in the world.** Shore Glub camps (3 camps on the western
  shore), a Mushnub pair inland, and a training-dummy line south of the spawn
  shrine — all authored as published `content_enemies`/`content_spawners`
  rows (zod-validated at boot), streamed to the client with nameplates and
  HP bars. Grunt AI v1: perception cones + hearing, an alert beat before
  committing, threat-table targeting, melee/ranged attack bands, steering
  with separation on the walkgrid, damage + social aggro (camps join in),
  leashing with invulnerable return, and corpse → spawner respawns.
- **The basic combo.** LMB chains a per-class 3-step basic attack (link
  window in the last 40 % of each swing, warrior step 3 cleaves 120°);
  casters fire bolts instead. Client-predicted swing anims with
  server-confirmed damage; melee hits are lag-rewound to what the attacker
  actually saw (RTT/2 + interpolation delay, capped 250 ms).
- **The dodge roll.** Mouse4 (or V): 0.55 s / 4.2 m with i-frames from
  0.05–0.35 s, 25 stamina, direction locked at press — simulated inside the
  shared movement step, so prediction and server always agree.
- **Getting hit, staggering, dying.** Full damage pipeline (crit, variance,
  armor/resist, level scaling — unit-tested in shared), stagger meter with
  hit reacts and a vulnerability window, floating combat text (outgoing/
  crit/incoming/heal), enemy heavy attacks draw their **exact** hit shape as
  a hatched ground telegraph (colorblind-safe pattern, fills toward impact),
  death → soul screen → respawn at the shrine with a 30 s −15 % damage
  "Dawned" debuff. HP persists across logout (dead characters revive at 1).
- **Juice pass v1 (COMBAT.md §9).** 60 ms hit-stop on confirmed hits,
  directional camera kick + capped shake, enemy flash tints, corpse
  desaturate-and-sink, soft-target reticle plate, HP globe/vitals HUD, and
  WebAudio-synthesized temp combat SFX (swing/impact/dodge/death — final
  sourcing lands at P14).
- Verification: `tools/smoke/combat-probe.mjs` (15 headless server asserts)
  and `tools/smoke/browser-p4.mjs` (15 browser asserts incl. the death
  loop); all P3 smokes still green; tick p95 1.17 ms during a live camp
  fight (<15 ms gate).

### Fixed — production playtest round 5 (2026-08-03)

- **Left/right locomotion clips are no longer mirrored** (A played the D
  strafe; camera-turn leans banked the wrong way). Round 3 had swapped the
  L/R clip assignment on the theory that the UAL pack names sides from the
  viewer's perspective — an inference that could only be settled by watching
  the rendered rig, and the owner's eyes now have: the names are
  **character-perspective**, so the mapping is back to identity (left motion →
  "L"-named clips, left turn → LeanL). The browser smoke now pins exact clip
  names on both sides (W+A → `Jog_Fwd_L_Loop`, W+D → `Jog_Fwd_R_Loop`,
  S+D → `Jog_Bwd_R_Loop`, left-turn lean → `Jog_Fwd_LeanL_Loop`) so the
  assignment can never silently flip again.

### Fixed — production playtest round 4 (2026-08-03)

- **Animations no longer switch around while walking with the action camera.**
  Two layered causes: (1) the velocity→model-space transform double-negated
  yaw, so the 8-way heading read as 2·yaw − direction — running forward with
  the camera at 90° played the backpedal clip, and every camera turn cycled
  the sector clips twice per revolution (yaw 0/π were the only correct angles,
  and the only ones the old tests swept). (2) Even with correct math, the
  local player's measured velocity trails the live mouse yaw by ~100 ms
  (20 Hz intents + smoothing), so hard flicks swept the heading across sector
  borders mid-turn. The transform is fixed and unit-tested at arbitrary yaws
  (`anim-math.ts`), and the local player's 8-way heading now follows the held
  movement keys — camera-relative, hence turn-rate-invariant — with velocity
  as the fallback for decel tails; remotes keep the (now sign-correct)
  velocity heading, since their yaw and velocity arrive coherently in
  snapshots. The browser smoke now spins the camera and snaps it 180° while
  holding W and fails on any non-forward sector clip (verified to catch the
  old behavior).
- **The admin panel at `/admin` no longer serves a blank page.** Caddy proxied
  the panel with `handle` (prefix kept) while the panel is built against
  stripped paths (`handle_path` — its documented contract): the SPA fallback
  answered `/admin/assets/*.js` with `index.html`, which browsers refuse on
  MIME, leaving `#root` empty. Fixed to `handle_path /admin*`; the CSP also
  gained an explicit `font-src 'self'` (the panel's fonts now ship as files —
  its build stopped inlining them as `data:` URIs the CSP refused). A new
  vitest (`packages/server/src/deploy-contract.test.ts`) pins the Caddyfile's
  production contracts — admin prefix strip, `connect-src blob:`, font-src,
  and the manifest/index no-cache rules — so these serving bugs fail the
  build instead of a playtest. Deploy: merge both repos to `main`, run
  `sudo bash /opt/dawned/game/deploy/UPDATE.sh` (it reinstalls the Caddyfile
  and rebuilds the panel), then hard-refresh.

### Fixed — production playtest round 3 (2026-08-03)

- **Grounded/airborne flicker while walking (protocol v5)**: on any downhill
  tick the simulation briefly went "airborne", fell one gravity step and
  re-landed — the HUD state flapped and walk animations kept restarting into
  jump/land. The shared step now GLUES a grounded character to the slope for
  drops up to 0.5 m per tick (covers the steepest walkable grade at sprint);
  bigger drops and jumps still leave the ground properly. Pinned by new unit
  tests (100-tick downhill run stays grounded, cliffs still fall) and a
  browser assert sampling the live state during a sloped run.
- **Left/right locomotion clips were mirrored**: the animation pack names its
  strafe/lean clips from the VIEWER's side, not the character's (masked until
  now by the old inverted A/D input). Character-left motion plays the
  "R"-named clips throughout — strafes, diagonals and turn-leans now match the
  actual movement direction.
- **`/admin` deploys deterministically**: the panel now consumes
  `@dawned/shared` from the sibling game checkout (`file:` dependency; the
  deploy scripts provide a `Dawned → game` symlink) instead of a GitHub
  tarball fetch that private repos can't serve credential-less. No tokens, no
  network — the previous npmrc bridge is removed.

### Fixed — production playtest round 2 (2026-08-03)

- **The untextured white world**: the production Content-Security-Policy blocked
  every model texture. three.js loads GLB-embedded textures by `fetch()`ing
  `blob:` URLs, which answers to `connect-src` (not `img-src`) — the Caddy
  header now allows `blob:` there. Verified by A/B-serving the production build
  with both headers: 38 blocked texture fetches before, zero after. (Dev never
  showed it — the Vite server sends no CSP.)
- **Shoreline/water rubber-banding**: P3's walkgrid rebake changed map data
  under the unchanged `dev-1` version, so returning browsers kept predicting
  with the stale cached walkgrid (IndexedDB + immutable HTTP) — the client
  refused to enter water the server happily swam through. The map now ships as
  **`dev-2`** (byte-identical terrain, new cache keys), and worldgen documents
  the rule: map data change ⇒ version bump. The mutable `manifest.json` is also
  excluded from the immutable-cache header it was wrongly under.
- **`/admin` unreachable after UPDATE.sh**: the updater only touched the admin
  panel if `package.json` already existed — but that file only arrives WITH the
  first pull (and the panel repo had no `main` branch to clone at first deploy).
  UPDATE.sh now clones the panel when missing (deriving the URL + token from
  the game clone's remote), checks for code AFTER pulling, and enables the
  service. It also re-execs from a temp copy first — it updates the very repo
  it runs from, and bash reads scripts lazily.
- **Missed jump taps**: intents sample at 20 Hz; a key pressed and released
  between two samples (a quick Space tap at high fps) vanished entirely. Taps
  now latch until the next intent sample.

### Fixed — movement feel rework (owner playtest feedback, 2026-08-02)

- **A/D were swapped** — the camera-relative strafe math used the wrong sign for
  the screen-right axis. D now strafes right, A left, at every camera angle; a
  unit suite and a browser check pin the mapping so it can't quietly regress.
- **The "laggy" feel**: the simulation runs at 20 Hz, and your own character was
  drawn at raw tick positions — 27 cm jumps between frames on a 60/144 Hz
  screen. The local player now renders extrapolated through the sub-tick
  remainder (terrain-grounded, wall-aware) and the model faces the LIVE mouse
  yaw instead of the last tick's — motion and turning are now frame-smooth.
- **"Skating" animations**: locomotion clips now play at their natural gait
  speeds (measured from the baked cycles) instead of a fixed reference — plain
  running uses the sprint cycle at ~1.06× (it IS 5.5 m/s), a real walk cycle
  covers slow speeds, and the jog family drives strafes/backpedal/diagonals.
  Foot phase carries across gait/direction changes (no mid-stride restarts),
  8-way sectors are sticky at their borders (no clip flicker on held
  diagonals), and only idles randomize their start phase.
- **Polish**: sprinting eases the field of view out by 6° (speed you can feel),
  and the camera starts looking the way your character faces on entry.

### Added — Phase P3: movement, netcode core & chat v1 (built 2026-08-02; owner signoff pending)
- **Swimming**: water deeper than 1.2 m carries you — movement pins to the surface,
  speed drops to ×0.55, sprint-swimming drains stamina faster, jumping is inert, and
  diving into deep water always negates fall damage. Enforced by the same shared
  formula on client prediction and the authoritative server (protocol v4).
- **Seamless reconnect**: losing the connection no longer despawns you — the server
  holds your character in place for 15 s while the client auto-retries (banner +
  status show "reconnecting…"); success resumes the same character mid-world with
  no leave/join spam for anyone nearby. Cleanly leaving still despawns immediately.
- **Interest management (AOI)**: snapshots now carry only entities within ~96 m
  (leave past 104 m, per-client cap 80 nearest) — the network cost of a crowd
  stays flat no matter how many players share the island.
- **Chat v1**: global chat with system lines, chat bubbles in the "Cut Facets"
  style above speakers' heads (~6 s), and `/stuck` — a 60 s-cooldown self-rescue
  that recalls you to the spawn shore.
- **Locomotion v2**: 8-way jog blends (diagonals included), sprint turns bank into
  lean animations, and idle/forward swim strokes on the water — all driven by the
  same speed/heading logic for your own character and everyone remote.
- **Cursor without unlocking**: hold **Alt** to free the mouse cursor (chat, future
  menus) and release it to snap straight back to mouselook.
- **Lag lab + netgraph**: `/netsim <rtt> [jitter]` injects artificial latency into
  your own connection for feel-testing; the HUD now graphs RTT and prediction
  corrections and reads out snapshot cadence/age and up/down throughput.
- **Fix**: teleports into not-yet-streamed terrain (e.g. `/stuck` from far away) no
  longer free-fall the camera while chunks load — the client adopts the server's
  authoritative state until the ground data arrives.
- **Load & latency gates measured** (dev container): 20 wandering bots + 1 client →
  tick p50 0.66 / p95 1.0 / max 3.6 ms (<15 ms budget), ~42 kB/s total server egress;
  headless prediction client at 100 ms RTT ± 20 ms jitter, 60 s of sprint-jumping →
  corrections p95 39 mm, zero hard snaps. New harnesses: `tools/bots/swarm.mjs`,
  `tools/smoke/predict-lag.mjs`, `tools/smoke/browser-p3.mjs`.

### Added — Phase P2: terrain & world streaming (verified on real hardware 2026-08-02)
- **The Dawnlands gain real ground**: a ~1 km dev island (Dawnshore meadows and beaches,
  the wooded Verdant Weald, the stark Ashen Reach, an inland lake) generated deterministically
  by `pnpm world:generate` into committed map artifacts — 271 terrain chunks (~25 kB each:
  65×65 heights at 1 m + 8-layer splat weights + per-chunk water level), a 1 MiB walkability
  grid, zone polygons with ambience profiles, worldmap/minimap renders and a spawn point.
  The admin map editor takes over authoring at A2/A3 using the same formats.
- **Client streaming**: chunks load in residency rings around the player (IndexedDB-cached
  per map version, two fetches in flight, one mesh build per frame — no frame hitches),
  and unload past an outer ring. Terrain renders as flat-shaded vertex-color splat blends
  with edge skirts; water planes blend from glassy shallows to deep blue at the shore;
  an ocean backdrop covers the horizon.
- **Zone ambience**: fog color/range, sky gradient, sun and hemisphere light ease toward
  the profile of the zone polygon underfoot (~4 s settle) — crossing from Dawnshore into
  the Weald visibly closes the fog green; the Ashen Reach goes grey-violet.
- **Foliage**: deterministic per-chunk scatter of grass, bushes, trees and bare trees from
  splat weights as instanced meshes with a vertex-shader wind sway — two clients on the
  same meadow see the same field.
- **Walkability is law**: the shared movement step now consults the walkgrid (slopes over
  50°, deep water and the open ocean block; shallows are wadeable) with axis-separated
  sliding, enforced identically by prediction and the authoritative server (protocol v3).
- **Server terrain mirror**: the full map loads at boot (~8 MB; the server refuses to start
  without it); persisted positions that are now off-world or unwalkable relocate to spawn.
- **Budgets measured** (worst case, dense forest view at 1080p): 154 draw calls,
  ~441 k triangles — within the ≤300 calls / ≤500 k tris budgets (TECH_STACK.md). Real-GPU
  60 FPS validation is the owner's remaining DoD step (dev containers render via software GL).

### Added — Phase P1: accounts, characters & menus (live on the VPS 2026-08-02)
- **Accounts & sessions (server)**: PostgreSQL 16 + Drizzle schema (`accounts`, `sessions`,
  `characters`, `bans`) with committed migrations; argon2id password hashing; registration
  (open, dormant invite-code toggle per Q8), login with per-IP throttles, failed-login lockouts
  and timing-safe unknown-name handling; 30-day sliding sessions (hashed tokens); REST API
  (`/api/auth/*`, `/api/characters`) validated with the shared zod schemas. Five integration
  tests run the full flow against a real database.
- **Characters (server)**: five slots per account, world-unique names, class + full appearance
  stored per character, soft delete that frees the name, position/playtime persistence
  (10 s write-behind + on disconnect), single-session-per-account (newest login wins).
- **Protocol v2**: authenticated `Hello` (session token + character id) replaces the P0
  name-claim handshake; `Welcome` carries the spawn (persisted position on relog) and a roster
  with class, level and appearance for every player.
- **Character asset pipeline**: Quaternius Universal Base Characters, Modular Fantasy Outfits
  and Universal Animation Library baked through new rule options (`skinned`, `bodyCut`,
  `imageOverrides`, `animationsOnly`/`animationKeep` — see docs/tech/ASSET_PIPELINE.md §2);
  13 character assets at 6.6 MB total incl. a mesh-free 13-clip animation library; a rig
  verification gate (bone/track-name contract) now runs inside `pnpm assets:report`;
  `pnpm assets:sync` publishes baked assets into the client.
- **Menus & design system v1 (client)**: React 19 front door over the three.js world — login/
  register screen on a live dawn vignette, character select with 3D stage, character creation
  with class carousel (posed, animated rigs), body/skin/outfit/tint/hair/color/beard controls
  on the live model, and the "Cut Facets" design language (Amaranth + Nunito Sans, corner-cut
  panels, gold-seam buttons) as reusable primitives.
- **Character composition (client)**: load-time skeleton rebinding of outfit/hair pieces onto
  the shared 65-bone rig, multiplicative skin/outfit/hair tinting, UAL clips with crossfade.
- **In-world characters**: composed rigs replace the P0 capsules, with a locomotion state
  machine (idle / jog forward-back-strafe / sprint / jump start-loop-land), speed-following
  playback and desynchronized loop phases; appearance and names applied live from the roster.
- **Session resume**: a returning player lands on character select and re-enters the world at
  the exact spot they left (position write-behind + on-disconnect persist).
- **Verification**: both smoke tests now drive the authenticated flow (REST fixtures, token
  bootstrap, character select, v2 handshake); CI runs against a PostgreSQL 16 service with
  migrations; the §7-P1 security checklist was run and recorded (timing-oracle measurement,
  token/session-fixation review); per-IP registration limit set to 10/day.

### Fixed — P1 VPS deploy
- **Registration/login failed on the VPS with a raw SQL error on screen.** Root cause: the
  deploy scripts ran `pnpm db:migrate` without `DATABASE_URL` (the `dawned` user cannot read
  `/etc/dawned/game.env`), the migrator fell back to the dev-default URL and failed password
  auth, and an `|| echo "(no migrations to run)"` swallowed the failure — so the server came
  up against a database with no tables. Three-layer fix:
  - DEPLOY.sh/UPDATE.sh now read `DATABASE_URL` (as root) and inject it into the migration
    step, which **aborts the deploy on failure** instead of pretending nothing happened;
  - the server refuses to boot when the schema is missing ("accounts" table probe) with a
    message pointing at the migration step — no more healthy-looking broken deploys;
  - a Fastify error handler stops internal errors from reaching the client at all: the VPS
    error body contained the failed SQL and its parameters, including the freshly computed
    password hash. Clients now get a generic message; the real error goes to the server log.

### Added — Phase P0: foundations & walking skeleton
- **Monorepo**: pnpm workspaces (`packages/shared`, `packages/server`, `packages/client`,
  `tools`), TypeScript strict everywhere, ESLint 9 + Prettier, Vitest, a single `pnpm check`
  gate (typecheck + lint + format + tests + asset report) and a GitHub Actions workflow.
- **`@dawned/shared`**: binary wire protocol v1 (allocation-free codec, 8 message types,
  fuzz-tested against malformed input), the shared `stepMovement` simulation step both sides
  run, movement/stamina/fall-damage constants, and the P0 dev terrain. 37 unit tests, including
  a 10,000-tick client/server parity test and a reconciliation replay test.
- **Game server**: Fastify + `ws`, drift-corrected 20 Hz tick loop, session management with
  per-opcode rate limiting and backpressure shedding, authoritative movement, snapshot fan-out,
  in-process metrics ring, localhost-only ops API (`/ops/metrics`, `/ops/announce`), graceful
  shutdown.
- **Game client**: three.js scene (vertex-coloured terrain, water, gradient sky, shadows),
  client prediction with reconciliation and smoothed corrections, remote-entity interpolation,
  pointer-lock mouselook camera, sprint/stamina/jump, chat, roster, and a debug HUD with a
  ping graph.
- **Asset pipeline v1**: incremental, hash-based conversion of source packs into
  `assets_baked/` with a manifest; the report gate fails the build on unattributed assets and
  budget violations; the CREDITS per-file ledger is generated from manifest provenance.
  17 starter assets baked (1.2 MB).
- **Deployment**: real `deploy/` scripts — DEPLOY (provision + harden + build + start), UPDATE
  (backup → announce → pull → build → migrate → restart), BACKUP (nightly/quick/verify with
  rotation), ROLLBACK (code, optional double-confirmed DB restore) — plus a Caddyfile with CSP
  and cache rules and four systemd units.
- **Automated Definition-of-Done checks**: `tools/smoke/two-client-sync.mjs` (headless protocol
  test) and `tools/smoke/browser-sync.mjs` (two real Chromium clients: roster, movement,
  replication, convergence, console errors).

### Fixed — P0 code review pass
- **Alt-tab no longer gets you kicked**: the keep-alive ping ran on the render loop, which
  browsers stop entirely in hidden tabs — the server's idle sweep then dropped the player after
  30 s. Pinging now runs on an interval timer and the idle window is sized above Chrome's worst
  background-timer throttling (90 s).
- **Silent clients no longer run away**: when inputs stop arriving, the server used to repeat the
  last movement intent indefinitely — a hidden tab or dying connection walked its character in a
  straight line until the world border. Movement now zeroes after 0.5 s of input starvation
  (verified with a live test: 4.6 m of legal coasting, then a full stop).
- **One bad tick can no longer take the server down**: the simulation tick is guarded — errors
  are logged and tolerated, and only persistent failure (100 consecutive) exits for a clean
  systemd restart. Crash paths now exit non-zero instead of masking themselves as clean stops.
- **Server restarts and rejections have real UX**: the client auto-reloads a few seconds after a
  shutdown notice, and pre-entry rejections (name taken, server full, outdated client) show an
  overlay with a reload button instead of stranding the player on an empty world. UPDATE.sh's
  in-game announcement now describes what actually happens.
- **CI would have failed on GitHub**: pnpm/action-setup errors when both its `version` input and
  the `packageManager` field are set — the workflow now relies on the pinned field alone.
- **Unattended deploys could hang**: corepack's interactive download prompt is disabled in
  DEPLOY/UPDATE/ROLLBACK (it triggers on TTY detection mid-script).
- Shadows now follow the player instead of silently vanishing beyond ±70 m of the world origin;
  fall-damage world events are logged instead of silently discarded (HP consumes them in P4).
- Asset pipeline: manifest paths are normalized to forward slashes (a Windows dev machine would
  have committed backslash paths) and duplicate asset ids across packs are now a build error.
- Docs synced to reality: input send rate is 20 Hz tick-locked (not 30 Hz), the protocol tables
  note the implemented v1 subset, DEPLOYMENT.md §8 documents private-repo deploy keys; removed a
  dead constant, a dead field and an unused re-export; added the missing ChatBroadcast codec
  test (38 tests total).
- **DEPLOY.sh can no longer lock the owner out of the VPS**: it only disables SSH password login
  once an SSH key is actually installed for root (fail2ban guards passwords until then). Added
  `deploy/FIRST_DEPLOY.md` — a beginner walkthrough for the first deployment with private repos.

### Fixed
- Remote players rendered several metres behind their true position on slow clients: the
  interpolation clock was derived from ping/pong offsets, which skew badly when a stalled frame
  inflates the measured RTT. Interpolation is now driven off the snapshot stream with bounded
  lag/lead, so a slow or backgrounded client no longer drags every other player out of place.

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

### Changed
- Folded all 16 initial owner decisions (2026-08-02) into the docs. Highlights: mouselook
  controls confirmed; jumping with light fall damage specced; English-only content; **open
  registration** (invite-code toggle kept available); admin panel at `/admin` with allowlist off;
  off-box backups manual via Hostinger hPanel (local nightly backups unchanged); CC0-first audio
  sourcing confirmed; 5 skin tones added to character creation; and **visual weather added to
  0.1.0 scope** — zone-profiled rain, thunderstorms with distance-delayed thunder, and post-rain
  rainbows, landing in P14 alongside day/night (WORLD.md §4.6, `/weather` GM command,
  `WeatherState` protocol message). Full decision log: USER_QUESTIONS.md.

### Notes
- Phase P0 shipped and verified live at play.pathlands.cc on 2026-08-02 (first deployment via
  `deploy/DEPLOY.sh` on the production VPS). Next phase: P1 — Accounts, Characters & Menus.
