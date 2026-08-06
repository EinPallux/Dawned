# USER_QUESTIONS — owner decision inbox

> Single inbox for design questions to the owner (from both repos). New questions get added here
> with context + a **recommended default**; answered ones move to the decision log below after
> being folded into the docs. Rule of the project: never silently guess a design the owner might
> feel differently about — but never block on an answer either (implement the recommendation,
> note it here).

## Open questions

> Four open questions: **Q26** (per-zone music/sfx), **Q28–Q29** from the P11-E DoD run — both
> already implemented as their recommended default, say the word and either reverts in minutes —
> and **Q30**, which P12 has to answer to build a bridge at all.
> Q27 was answered on 2026-08-05 — the reel is
> left as shipped and judged in the playtest. Q25 was answered by P10 starting — its recommended default WAS "do it in the professions
> phase", and that phase is now under way, so the node schema lands as a P10-A deliverable and the
> map editor's node layer comes alive with it.

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

### Q28 — should a "gather N of these" step get a map circle? (P11-E, 2026-08-06)

QUESTS_POI §1 rule 4 is explicit that an EXPLORE step never marks anything — clue text only. It
says nothing about a COLLECT step, and the pilot set shipped both of its gather steps with no
hint at all. In practice that reads as no instruction: "six good lengths of birch" tells a player
who has never chopped anything nothing whatsoever, and the 13 birch placements are three clusters
180 m apart. Mossbloom is worse — it grows 360 m from the Weald the prose sends you to.

**Recommended default (implemented): give gather steps a circle**, pointed at the nearest real
cluster. The explore rule stays untouched, because the point of an explore step is that finding
the place IS the objective; for a gather step the objective is the picking, and hiding the herb
just adds a scavenger hunt nobody asked for.

If you would rather professions carried their own knowledge — a codex entry, "you have gathered
this before, so the map shows it" — that is a nicer answer and a bigger one, and it belongs with
the professions polish rather than here. Reverting is two `hint` fields.

### Q29 — a quest interactable that never comes back (P11-E, 2026-08-06)

The crate in "The Lost Crate" and the four marked stumps in "What Took Them" were authored
one-shot (`respawnMs: 0`). That means opening the crate BEFORE Torv mentions it ends the quest
before it starts, permanently, with no way back — a quest lost to ordinary curiosity, which is
the exact opposite of §1 rule 2 ("quests are found, not funneled"). Spent state is per-character,
so this is not a shared-loot question.

**Recommended default (implemented): nothing a quest step needs is one-shot.** Both now return
after five minutes. Publish does not enforce this yet — the panel would have to know that an
interactable is named by a step, which it can see; worth adding if you agree it is a rule.

The alternative is to keep one-shot props and make the QUEST tolerant instead (credit the step on
approach if the object is already spent). That is more code in the quest runtime for a case a
respawn timer solves in one field, which is why it is not the recommendation.

### Q30 — a bridge cannot be a bridge, because props have no collision (P12-B, 2026-08-06)

WORLD.md §1 has the isles "joined by bridges", §6 calls bridges landmark art pieces where
"crossing one should feel like a chapter turn", and CONTENT_0.1 counts four of them. P12-A cut
real channels between the isles, and the flood fill confirms each one is now its own landmass.

Then two things met. **No pack we own contains a bridge model** — I searched all 24. And, more
decisively: **walkability comes from the terrain heightfield, not from props.** A player walks on
the walkgrid the map bake computes from the ground; a prop is something they see. So a bridge laid
across a channel is scenery you swim underneath, and the isles stay swim-only.

That is a contradiction with §1, not a missing asset. Two ways out:

1. **Causeways.** Refill a narrow neck of terrain across each strait — 10–14 m wide, at the one
   place the crossing belongs — and dress it with plank and dock props so it reads as a built
   bridge. The link is genuinely walkable, it is a single visible chokepoint, and swimming stays
   the shortcut for the impatient. Cost: the isles are technically one landmass through each
   neck, so "five separate isles" becomes "five isles and four necks".
2. **Give props collision.** A walkgrid props can write into — a real feature touching the bake,
   the shared walkgrid and the server's movement step. It would also fix standing on a rooftop, a
   jetty or a fallen trunk, all of which are decoration today. Nothing else in 0.1.0 needs it.

**Recommended default: causeways (option 1), built now.** It is the only one that makes §1 true
this phase, it costs one new mask kind in the terrain synthesis, and it does not spend a
walkgrid rewrite on a feature four bridges use. If you would rather have real prop collision, say
so and it becomes its own phase after P12 — the causeways would stay as the land under the
bridges either way.

## Decision log

### 2026-08-05 — P9 + P10 accepted (owner: "Mark P9 and P10 as done… We can always finetune after that")

| #   | Topic                            | Decision                                                                                                                                                                                                                                                                       | Folded into                                          |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| —   | P10 DoD: one profession measured | **Accepted.** Woodcutting was walked 1→10 for real; mining, herbalism and fishing share the `rollGather` path and content shape. The owner tests all four in the end-of-project pass rather than gating the phase on it                                                        | ROADMAP P10 status block, PROFESSIONS.md §1.7        |
| —   | P10 DoD: two rarities, not three | **Accepted.** Epic and legendary fish are defined but have no placed water until P12 sculpts Emberwood/Sungraze/Ashcrag; the probe reports the gap rather than claiming three. Re-check when those zones land                                                                  | ROADMAP P10 status block, PROFESSIONS.md §5.3        |
| —   | Phase closure vs. playtest       | **Phases close on the measured DoD, not on a playtest.** The owner's priority is reaching P15 with every phase built; ALL feel/number tuning is one deliberate pass at the end. Do not hold a phase open waiting for a playtest verdict — record what was measured and move on | ROADMAP status table, CLAUDE.md/AGENTS.md both repos |

### 2026-08-05 — the reel's difficulty ladder (owner: "Go with the recommended default")

| #   | Topic                               | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Folded into                                                                                       |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Q27 | How hard a legendary fish should be | **Leave it as shipped and judge it in the playtest.** `MARKER_MAX_SPEED` stays at the measured 0.9/s that makes a T1 common landable through a tick of command delay (it was unwinnable at 1.5); a T3 rare needs real anticipation, and a T5 legendary refuses every simple strategy tried. That is accepted as "legendary means legendary" until the fine-tuning pass at the end of the project. The whole ladder is two numbers in `fishingDifficulty` (drift speed, marker half-width), so re-tuning stays a one-line change with tests that report immediately whether the lower bands still work | `formulas/fishing.ts` as-built note, PROFESSIONS.md §5.2, `fishing.test.ts` delayed-command suite |

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
