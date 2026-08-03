# USER_QUESTIONS — owner decision inbox

> Single inbox for design questions to the owner (from both repos). New questions get added here
> with context + a **recommended default**; answered ones move to the decision log below after
> being folded into the docs. Rule of the project: never silently guess a design the owner might
> feel differently about — but never block on an answer either (implement the recommendation,
> note it here).

## Open questions

### 2026-08-03 — P4 combat foundation

**Q17 — Stagger decay tuning.** COMBAT.md §6.4 defines how the enemy stagger meter fills and
what happens at 100, but not how it drains. Implemented default (feels right in dev, one knob
each): **after 2.5 s without new stagger gain, the meter decays 15/s** — sustained pressure
keeps progress toward the stagger payoff, disengaging for a few seconds forfeits it, and a
camp reset always returns to zero. Alternative extremes: no decay at all (stagger becomes
inevitable in long fights, weaker as a "keep the pressure up" reward) or instant decay on
leaving combat only. **Recommended: keep the shipped default**; both constants
(`STAGGER_DECAY_DELAY_MS`, `STAGGER_DECAY_PER_S`) are in `@dawned/shared/constants.ts` and
worth revisiting once elites (0.75× gain) exist at P9. _Playtest it during the P4 demo — does
breaking off an attack feel appropriately costly?_

**Q18 — Training dummies wear the Mushnub model.** The dummy line south of the spawn shrine
reuses `enemies_mushnub` (scaled 1.25×, renamed "Training Dummy", deals zero damage, never
aggroes, 300 HP that refills a few seconds after you stop hitting it — and a 15 s respawn if
someone actually burns one down) because the asset packs have no straw-dummy prop rig, and a
T-posed static mesh would break rule 1 (no placeholder-forever: dummies need hit reacts and
HP feedback to read as dummies). **Recommended: accept for 0.1.0** (they read
fine in dev — mushroom punching bags by the shrine have their own charm); alternative is
commissioning/sourcing a dummy model at P12 world-building and swapping the `model_ref` in
its `content_enemies` row (one field, no code).

---

## Decision log

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
