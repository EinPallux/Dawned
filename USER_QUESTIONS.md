# USER_QUESTIONS — owner decision inbox

> Single inbox for design questions to the owner (from both repos). New questions get added here
> with context + a **recommended default**; answered ones move to the decision log below after
> being folded into the docs. Rule of the project: never silently guess a design the owner might
> feel differently about — but never block on an answer either (implement the recommendation,
> note it here).

## Open questions

_None right now._ 🎉

---

## Decision log

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
