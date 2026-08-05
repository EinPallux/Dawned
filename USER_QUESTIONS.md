# USER_QUESTIONS — owner decision inbox

> Single inbox for design questions to the owner (from both repos). New questions get added here
> with context + a **recommended default**; answered ones move to the decision log below after
> being folded into the docs. Rule of the project: never silently guess a design the owner might
> feel differently about — but never block on an answer either (implement the recommendation,
> note it here).

## Open questions

### Q24 — patrol splines need AI, not just an editor (A3-b, 2026-08-05)

MAP_EDITOR.md §2.3 asks the spawns mode for a **patrol spline editor with per-node wait times**.
Drawing one is the easy half. The other half does not exist: `spawnerDefSchema` has no patrol
field, and more importantly the enemy AI has no patrol state — idle enemies stand at their spawn
until something perceives them.

**Not shipped, on purpose.** Adding the field and the path editor now would put data in the
database that nothing reads. Project rule 1 calls that a placeholder, and this is exactly the
shape it warns about: it would look finished in the panel and do nothing in the world.

What it actually needs, as a game-side slice: a `patrol` array on the spawner schema, an AI state
that walks it at a stroll speed and honours the wait at each node, and the interaction with leash
and social aggro decided (does a patroller return to its LAST node or its spawn? does pulling one
member of a moving camp drag the whole line?). That is enemy-behaviour work, so it belongs with
the game's AI phase rather than being smuggled in as an editor feature.

**Recommended default: leave patrols out of 0.1.0.** Everything else in spawns mode shipped —
camp links, aggro/leash rings, per-zone population against the CONTENT_0.1 budget, and a
deterministic simulate-populate — and a world of stationary camps is what P9 was measured and
balanced against. If you want patrols, say so and it becomes a game-side task with its own DoD
(the editor half is a day on top).

---

### Q23 — who owns a spawner's position, the map editor or the Enemies page? (A3, 2026-08-05)

Camps can now be placed in two places: **Content → Enemies → Spawners** (where they have been
since A1-d) and the **Map Editor's Place tool** (where you can see the hill you are putting them
on). They are the same rows — the game reads spawners from `content_spawners` either way.

Shipped for now: **the map publish wins.** Publishing the map replaces every published spawner
row from the map's spawner layer, delete-and-insert in one transaction, because a camp you
DELETED in the editor has to stop spawning and an update-only pass would leave it live forever.

The cost of that: if you move a camp on the Enemies page and then publish the map, the map's
copy of that camp overwrites it.

**Recommended default: keep it, and treat the map as the place camps live.** Position is a
spatial decision and the Enemies page cannot show you the terrain; the map editor's inspector
edits the same full row (entries, counts, respawn timer), so nothing is lost by doing all of it
there. The Enemies page stays the right surface for the BESTIARY.

If you would rather keep the Enemies page authoritative, say so and the map publish becomes an
update-in-place that never deletes — the trade is that a camp removed in the map editor would
keep spawning until you also delete it on the Enemies page.

---

### Q22 — Bandit Forager's model (P9, 2026-08-04)

NPCS_ENEMIES.md §4 casts the Dawnshore **Bandit Forager** as "KA Peasant-look + dagger" — a
KayKit Adventurers rig. That pack is not in `assets/` (we have KayKit Skeletons and the
Quaternius Monster Bundle). Everything else in the Dawnshore + Weald bestiary matched a model
already on disk; this is the one gap.

Shipped for now: **`Orc.glb`** from the Quaternius bundle. It is the closest humanoid that
actually walks — the first pick, `Tribal.glb`, _looks_ the part but is rigged in the pack's
flyer family with no `Idle` or `Walk` clip at all, so it would have T-posed on the ground.

**Recommended default: keep the Orc.** A bandit camp of orcish foragers reads fine on the
Dawnshore, and it costs nothing. If you would rather have a human bandit, dropping the free
KayKit Adventurers pack into `assets/enemy_models/` and changing one `modelRef` in the panel is
the whole job — no code. Either way this is a one-line content edit, not a rebuild.

---

## Decision log

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
