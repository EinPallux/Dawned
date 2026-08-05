# USER_QUESTIONS — owner decision inbox

> Single inbox for design questions to the owner (from both repos). New questions get added here
> with context + a **recommended default**; answered ones move to the decision log below after
> being folded into the docs. Rule of the project: never silently guess a design the owner might
> feel differently about — but never block on an answer either (implement the recommendation,
> note it here).

## Open questions

> Two open questions: **Q26** (per-zone music/sfx) and **Q27** (how hard a legendary fish should
> be). Q25 was answered by P10 starting — its recommended default WAS "do it in the professions
> phase", and that phase is now under way, so the node schema lands as a P10-A deliverable and the
> map editor's node layer comes alive with it.

### Q27 — how hard should a legendary fish be? (P10-F, 2026-08-05)

P10-F measured the reel bar against a REAL server for the first time and found that the offline
tests had been proving the wrong thing. They play the bar with the decision and the step at the
same instant; no player ever does. Every press goes up, and the server applies it on its next
tick — so the bar the eye is steering is always one tick ahead of the bar being scored. Same
crude strategy the shared test calls "the dumbest there is", twenty seeds, a T1 common:

| command delay | landed | what that is                     |
| ------------- | ------ | -------------------------------- |
| 0 ticks       | 20/20  | all the offline test ever proved |
| 1 tick        | 0/20   | what the game actually does      |

The cause was `MARKER_MAX_SPEED`, not the accelerations: one delayed tick at 1.5/s carried the
marker 0.075, about half a T1 catch zone, so the correction always arrived after the overshoot
and the loop rang instead of settling. **Shipped fix: 1.5 → 0.9/s**, which lands 20/20 through a
tick of delay and is now pinned by tests that include the delay. Proven end to end against the
live server by `tools/smoke/fishing-probe.mjs`.

What is NOT settled is the top of the ladder. With the fix, a T3 rare needs real anticipation to
land and a **T5 legendary refuses every simple strategy tried** — its `markerHalf` is tiny and
its drift fast. A human who reads the sine does better than a bot, so this may be exactly the
"legendary means legendary" feel you want; it may also be a wall.

**Recommended default: leave it as shipped and judge it in the playtest.** The whole ladder is
two numbers in `fishingDifficulty` (drift speed, marker half-width) and re-tuning them is a
one-line change with tests that will tell you immediately whether the lower tiers still work.
This is the fine-tuning you deferred to the end of the project — flagged here rather than guessed
at, because "a legendary you cannot catch" and "a legendary that feels legendary" are the same
measurement with different opinions attached.

### Q26 — a zone has no music or ambient sound yet (A3-e, 2026-08-05)

MAP_EDITOR.md §2.4 lists a zone's ambience as "fog color/density/light tint/**music/sfx set**/
weather weights", and WORLD.md §3 says the same. What `zoneAmbienceSchema` actually holds is
light and colour: fog, sky, sun, hemisphere. No music track, no ambient sfx set, no weather.

The §7 acceptance run therefore zones its islet with custom FOG and says out loud that it could
not set music — rather than adding fields the game has no audio system to read. Same reasoning
as Q24: an editor for data nothing consumes looks finished and does nothing.

What it needs, game-side: a `musicTrack` and `ambientSfx` on the zone ambience, the baked audio
to reference, and a client that cross-fades them on zone entry the way it already cross-fades
fog. AUDIO.md's zone-music section is the design; it is a P-phase of its own.

**Recommended default: leave zone audio out until the audio phase**, then add both fields and
the editor picks up the music/sfx dropdowns for free (the form is schema-driven). If you would
rather have the fields NOW so you can fill them in while building the world, say so — it is a
five-line schema change here plus two selects in the panel, and the game would ignore them until
the audio phase lands.

## Decision log

### 2026-08-05 — the map editor's four open questions (owner: "Q22, Q23, Q24: Your recommendations")

| #   | Topic                         | Decision                                                                                                                                                                                                                                                                                                                       | Folded into                                                            |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Q22 | Bandit Forager's model        | **Keep the Orc** (`Orc.glb`, Quaternius). The doc's KayKit Peasant is not in `assets/`, and the closest human-looking alternative has no `Idle`/`Walk` clip so it would T-pose. Swapping later is one `modelRef` in the panel, no code                                                                                         | NPCS_ENEMIES.md §4 as-built note; the published `enemy_bandit_forager` |
| Q23 | Who owns a spawner's position | **The map publish wins, and the map is where camps live.** Publishing replaces the published spawner rows from the map's spawner layer (delete-and-insert), because a camp deleted in the editor has to stop spawning. The Enemies page stays the surface for the BESTIARY; the map editor's inspector edits the same full row | MAP_EDITOR.md §4.1, CONTENT_EDITORS.md, admin publish pipeline         |
| Q24 | Patrol splines                | **Out of 0.1.0.** The editor half is a day; the missing half is an AI patrol state plus decisions about leash and social aggro on a moving camp. P9 was measured and balanced against stationary camps. Revisit post-0.1.0 as a game-side slice with its own DoD                                                               | MAP_EDITOR.md §2.3, ROADMAP P12 note                                   |
| Q25 | Resource-node schema          | **Closed 2026-08-05** — the recommended default was "leave it until the professions phase", and P10-A shipped `resourceNodeDefSchema` + `nodePlacementSchema` there. The panel's A1-e slice turned the map editor's node layer on against them, so the editor authors placements of definitions rather than rows nothing reads | ROADMAP P10-A, PROFESSIONS.md §1.4                                     |

### 2026-08-04 — P7 + P8 closed (owner playtest: "I tested everything so far and all seems fine")

| #   | Topic                            | Decision                                                                                                                                                                                                                                                                                                                                          | Folded into                                                       |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Q21 | P7 skill-tree authoring defaults | **Keep both shipped defaults**: tier layout by CLASSES.md listed order (nodes 1–2 → tier 1, 3–4 → tier 2, 5–6 → tier 3, 7 → tier 4, 8 = capstone) and per-rank ramps linear to the doc value at max rank. Re-tiering/re-valuing individual nodes is panel work with no code, and the owner has deferred all fine-tuning to the end of the project | the 96 published `content_skill_nodes` rows (seed migration 0010) |

### 2026-08-04 — P6 casters (accepted with the owner's P6 playtest — "classes are fine")

| #   | Topic                      | Decision                                                                                                                                                                                      | Folded into                            |
| --- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Q19 | Ground-target cast UX (P6) | **Quick-cast at the crosshair's terrain point** (one press, range-clamped, sky-aim falls back to max range along the aim). A two-step placement reticle stays a UI-only option if ever wanted | COMBAT.md §4.2, run-world groundAimFor |
| Q20 | Ally-heal targeting (P6)   | **Reticle ally → most injured in range → self**, with the green plate showing the would-be recipient. A "self-cast modifier key" can be added later if wanted                                 | COMBAT.md §4.2, Q20 pick server-side   |

### 2026-08-03 — P4 combat foundation (answered with the round-6 playtest feedback)

| #   | Topic                | Decision                                                                                                                                                            | Folded into                                                                     |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Q17 | Stagger decay tuning | **Keep the shipped default**: meter decays 15/s after 2.5 s without new gain (`STAGGER_DECAY_DELAY_MS`/`STAGGER_DECAY_PER_S`); revisit when elites land at P9       | COMBAT.md §6.4 as-built note, `@dawned/shared/constants.ts`                     |
| Q18 | Training dummy model | **Accept for 0.1.0**: dummies reuse `enemies_mushnub` (scaled, zero damage, never aggro, HP refill); swap `model_ref` in its content row if a prop rig lands at P12 | `content_enemies` seed row (migration 0003), NPCS_ENEMIES.md dummy line as spec |

### 2026-08-02 — initial planning round (16/16 answered, all folded into docs)

| #   | Topic               | Decision                                                                                                               | Folded into                                                                                                |
| --- | ------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Q1  | Camera/controls     | **Mouselook** (pointer-lock, BDO/Farever-style), `Alt` frees cursor                                                    | COMBAT.md §1–2                                                                                             |
| Q2  | Jumping             | **Yes**, with light fall damage (starts >12 m, 6%/m, capped 95%, water negates)                                        | COMBAT.md §2                                                                                               |
| Q3  | Dodge input         | Dedicated key: **`V` + Mouse4**                                                                                        | COMBAT.md §2                                                                                               |
| Q4  | Language            | **English only** for 0.1.0 (i18n-ready string keys regardless)                                                         | CLAUDE.md                                                                                                  |
| Q5  | Death penalty       | Light, as planned: shrine respawn + 30 s −15% dmg debuff, no XP/item loss                                              | WORLD.md §4.2, COMBAT.md §10                                                                               |
| Q6  | Fast travel         | **Shrine-to-shrine** after attunement, scaling gold cost; no mounts ever                                               | WORLD.md §4.2                                                                                              |
| Q7  | Day/night & weather | Visual-only day/night in 0.1.0 **plus visual weather: rain, thunderstorms, post-rain rainbows**                        | WORLD.md §4.6 (new), ROADMAP P14, NETWORKING `WeatherState`, GM `/weather`, AUDIO beds, zone ambience data |
| Q8  | Registration        | **Open registration** (invite-code toggle stays available, off)                                                        | SECURITY.md §1                                                                                             |
| Q9  | Password recovery   | **Admin resets via Dawned-Admin** (no email), audited                                                                  | SECURITY.md §1, Admin docs                                                                                 |
| Q10 | Admin panel URL     | **`play.pathlands.cc/admin`**, IP allowlist **off** for now                                                            | DEPLOYMENT.md §2, Admin ARCHITECTURE.md                                                                    |
| Q11 | Off-box backups     | **Manual via Hostinger hPanel** by the owner; local nightly backups + rotation still run; automation hook kept dormant | DEPLOYMENT.md §6, SECURITY.md §5                                                                           |
| Q12 | Audio sourcing      | **CC0-first**: Kenney + curated freesound/GDC packs, full attribution ledger                                           | AUDIO.md §3, ASSET_PIPELINE.md §5                                                                          |
| Q13 | Character creation  | As planned **plus 5 skin tones** (palette-swap pipeline)                                                               | UI_UX.md §4, ASSET_PIPELINE.md §3, DATABASE.md (`characters.skin`), ROADMAP P1                             |
| Q14 | Farever reference   | Keep the general look & feel; **no blatant copying** — treat it as a style/composition reference only                  | WORLD.md §7 (already worded so)                                                                            |
| Q15 | Cleric identity     | Confirmed: battle-priest with real solo damage (~72% envelope) + healing kit                                           | CLASSES.md §4–5                                                                                            |
| Q16 | 0.1.0 content scope | Confirmed: 6 zones, 28 quests, ~210 items, 36 enemy types + 6 bosses per CONTENT_0.1.md                                | CONTENT_0.1.md                                                                                             |
