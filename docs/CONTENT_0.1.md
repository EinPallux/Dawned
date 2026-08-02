# Dawned — 0.1.0 Content Targets (the countable contract)

> "Fully playable Early Access" in numbers. This is the checklist the world-building and content
> phases (P8–P12) fill and the release phase (P15) audits. Every row is content data authored via
> Dawned-Admin. Systems these plug into: see design docs.

## 1. World

| Item                                  | Target                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Zones                                 | 6 (Dawnshore, Verdant Weald, Emberwood, Sungraze Savanna, Ashcrag Canyons, Elder Grove) + Dawnsea water |
| Settlements                           | Dawnhaven (main, ~14 NPCs) + Mosshollow, Cinderfall, Sunwatch, Rustpick (~5–7 NPCs each)                |
| Ancient Shrines (respawn/fast travel) | 9 (1 per settlement=5 + 1 extra per larger zone)                                                        |
| POIs                                  | ≥45 total: 8 Vistas, 14 Landmarks, 8 Hidden Caches, 10 named Camps, 5 Curiosities                       |
| Interactables (non-node)              | ≥60 placed: ~25 chests, 9 shrines, 8 campfires, ~12 signposts, quest props, Elder portal                |
| Bridges (landmark builds)             | 4 + hidden swim route                                                                                   |
| Baked world map + minimap tiles       | 1 set, regenerated on map publish                                                                       |

## 2. Enemies & NPCs

| Item             | Target                                                                     |
| ---------------- | -------------------------------------------------------------------------- |
| Enemy types      | 36 regular (list locked in design/NPCS_ENEMIES.md §4)                      |
| Zone bosses      | 5 (Mossback, Mushroom King, Bonelord Varkas, Alpaking Prime, Elder Treant) |
| World boss       | 1 — Ashwing (Dragon Evolved)                                               |
| Rare roamers     | 3 (Ashcrag Dragon, Ghostfin-tier rares baked as spawner entries)           |
| Spawners placed  | ~140 (camps, patrols, ambient) within population governor caps             |
| Friendly NPCs    | ~40 (vendors 12, quest givers ~18, flavor/villagers ~10)                   |
| Ambient critters | 8 types placed liberally                                                   |

## 3. Items (≈210 total)

| Category                    | Count        | Notes                                                                        |
| --------------------------- | ------------ | ---------------------------------------------------------------------------- |
| Weapons                     | 60           | 4 classes × 5 zone tiers × ~2 variants + rarity uprolls + 6 named Rare/Epics |
| Armor (5 slots)             | 55           | tiered sets per zone band × armor classes, stat templates                    |
| Jewelry                     | 24           | rings/amulets/trinkets across tiers                                          |
| Legendaries                 | 6            | handcrafted, one per zone + Elder Grove (Emberbrand etc.)                    |
| Consumables                 | 22           | potion/tonic tiers, foods, 5 zone elixirs, antidote                          |
| Materials                   | 30           | 5 tiers × (log, ore, herb) + gems ×6 + procs (resin, heartwood, geode…)      |
| Fish                        | 12           | 10 + 2 trophy rares                                                          |
| Quest items                 | ~20          | per quest needs                                                              |
| Junk/treasure               | 12           | flavor vendor trash incl. 3 "treasure" high-value                            |
| **Every item: unique icon** | 210 mappings | game-icons pipeline, zero reuse                                              |

## 4. Abilities & Progression

| Item                  | Target                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------- |
| Player abilities      | 32 (4 classes × 8) + 4 basic-combo chains + 4 RMB actions                                |
| Skill tree nodes      | 96 (4 × 24)                                                                              |
| Enemy ability entries | ~55 (archetype kits + boss kits)                                                         |
| Buffs/debuffs defined | ~40 (class effects, enemy effects, food, zone/campfire)                                  |
| XP curve rows         | 30 · Profession curves: 4 × 30                                                           |
| Titles                | 8 (profession masters ×4, Friend of the Weald, castaway codex, Elder discovery, Ashwing) |

## 5. Quests & Dialogue

| Item                      | Target                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Side quests               | 28: Dawnshore 6 (incl. 4-part starter-ish chain "Getting Started" flavored), Weald 5 (chain 4 + 1), Emberwood 5, Sungraze 5, Ashcrag 4, Elder Grove 2, found-object 1 (bottle) |
| Quest chains (mini-sagas) | 5 (one per main zone)                                                                                                                                                          |
| Dialogue sets             | ~45 NPCs × 2–6 nodes + ~30 ambient bark lines                                                                                                                                  |
| Codex collections         | Castaway Logs ×6, per-profession codices                                                                                                                                       |
| Quest boards              | 5 (one per settlement, 2–3 posts each)                                                                                                                                         |

## 6. Gathering

| Item                     | Target                                                            |
| ------------------------ | ----------------------------------------------------------------- |
| Resource node placements | ~370: trees ~120, ore ~95, herbs ~95, fish spots ~40 + 8 deep-sea |
| Node types               | 5 tiers × 4 professions + Dawnpetal + geode variants              |
| Fishing minigame         | 1 tuned (parameters per fish rarity)                              |

## 7. Audio (per design/AUDIO.md)

7 zone tracks + login + 2 combat layers · 9 ambience beds (incl. rain/storm) · ~11 emitters
(incl. thunder set) · ~135 SFX/vocal files.

## 8. UI Surfaces

All 18 screens/surfaces of design/UI_UX.md §4 complete, animated, rebindable controls, settings
persist. GM panel full. 4 onboarding hints. Credits screen (auto-generated attributions).

## 9. Release Audit (P15 gate)

- [ ] Every table above at 100% (counts verified by a `pnpm content:report` script against the DB)
- [ ] Every class × every zone leveling path playtested (matrix signoff)
- [ ] Every quest completed on a fresh character (scripted + manual)
- [ ] Every item icon unique; every enemy has full anim/SFX set; zero placeholder assets
- [ ] Perf budgets green (client 60 FPS scenes list; server tick p95 with 25 bots)
- [ ] Security checklist re-run (tech/SECURITY.md §7)
