# Dawned — Asset Inventory & Usage Map

> What actually lives in `assets/` (verified by exploration, ~1.7 GB: 471 GLB, 892 glTF, 1537 FBX,
> 899 OBJ, 1100 PNG, 195 .blend), what license it carries, and what each pack is earmarked for.
> Everything runtime-served goes through the pipeline ([tech/ASSET_PIPELINE.md](tech/ASSET_PIPELINE.md)).
> Licenses verified per-pack license files at Phase 0 ingestion; attribution auto-generated into CREDITS.md.

## 1. Player Characters (`assets/player_characters/`) — the core rig stack

| Pack                                                            | Contents                                                                                                                                                                                                                                                                                                                                                                                                         | Use                                                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Universal Base Characters [Standard]** (Quaternius)           | `Superhero_Male/Female_FullBody` (gltf+fbx) + 7 hairstyles + eyebrows ×2 + beard (both "origin at 0" and head-bone-rigged variants)                                                                                                                                                                                                                                                                              | THE player body (M/F) + creation hair/beard options                                     |
| **Modular Character Outfits – Fantasy [Standard]** (Quaternius) | Outfits `Male/Female_Ranger`, `Male/Female_Peasant` (full + modular parts: arms/legs/torso), texture sets incl. recolor bases                                                                                                                                                                                                                                                                                    | The two outfit families chosen at character creation; recolor variants per class accent |
| **Universal Animation Library 1 [PRO]** (Quaternius)            | `UAL1.glb` (+ root-motion `_RM` + FBX): **120 clips** — 8-way jog, sprint, crouch set, crawl, climb, swim, jumps, `Roll`, `Dodge_Left/Right`, sword set (`Sword_Attack`, `Sword_Idle`…), `Spell_Simple_*` + `Spell_Double_*` families, punches/kick, 5 hit reacts, 2 deaths, `Interact`, `PickUp_*`, `Drink`, sit/ground-sit sets, counter/shop set, `Celebration`, `Dance_Loop`, `Idle_Torch_Loop`, push, turns | Locomotion + casting + hits + world interactions for players and humanoid NPCs          |
| **Universal Animation Library 2 [Standard]** (Quaternius)       | `UAL2_Standard.glb`: **43 clips** — `Sword_Regular_A/B/C(+_Rec)`, `Sword_Heavy_Combo`, `Sword_Block`, `Sword_Dash`, `Shield_Dash`, `Shield_OneShot`, `Idle_Shield_*`, `Melee_Hook`, `OverhandThrow`, `TreeChopping_Loop`, `Farm_*` (harvest/plant/water), `Chest_Open`, `Consume`, `Hit_Knockback`, slide set, ninja-jump set, zombie set, `Yes/No`, `Walk_Carry_Loop`                                           | Combat combos/blocks/dashes, professions, chests, food — the combat-feel backbone       |
| + `Mannequin_F` (UAL2)                                          | female test mannequin                                                                                                                                                                                                                                                                                                                                                                                            | rig validation in pipeline tests                                                        |

**Clip gaps identified** (plan accordingly): no dedicated fishing-idle/reel, no mining-specific, no
dual-wield set, no bow-draw for players (fine — no player bows in 0.1.0), no hammer-specific.
Covered by documented retargets/retimes in [design/CLASSES.md](design/CLASSES.md) +
[design/PROFESSIONS.md](design/PROFESSIONS.md) (e.g. mining = `TreeChopping_Loop` retarget;
fishing = `OverhandThrow` + idle + custom reel loop cut from `Fixing_Kneeling`).

## 2. Enemies (`assets/enemy_models/`)

| Pack                          | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Use                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Quaternius Monster Bundle** | ~46 rigged GLBs w/ per-model clips (`Idle/Walk/Run/Punch/Weapon/HitReact/Death/Duck/Jump/No/Yes/Wave`, fliers add `Flying_Idle/Fast_Flying/Headbutt`): Glub(+Evolved), Green/Pink/Spiky Blobs, Mushnub(+Evolved), **Mushroom King**, Armabee(+Evolved), Frog, Cactoro ×2, Monkroose, Ghost, Ghost Skull, Wizard, Tribal, Ninja ×2, Orc, **Orc Enemy**, Demon, **Blue Demon**, Goleling(+Evolved), Yeti ×2, **Dragon, Dragon Evolved**, Alpaking(+Evolved), Dino, Hywirl, Squidle, Alien ×2, plus ambient Cat/Bunny/Chicken/Pigeon/Birb/Fish | The entire bestiary (see design/NPCS_ENEMIES.md §4 mapping) + ambient life. Aliens unused (theme), Ninja reserved (possible post-0.1 bandit elite) |
| **KayKit Skeletons 1.1**      | `Skeleton_Minion/Rogue/Mage/Warrior` GLBs + shared Rig_Medium animation GLBs (`Idle_A/B`, `Death_A/B(+Pose)`, `Hit_A/B`, `Spawn_Air/Ground`, `Throw`, `Use_Item`, `Interact`, `PickUp` + MovementBasic pack) + prop bits (blade, axe, crossbow, staff, shields, quiver, arrows)                                                                                                                                                                                                                                                             | Emberwood undead faction incl. **Bonelord Varkas**; `Spawn_Ground` = graveyard emergence moment                                                    |
| **KayKit Adventurers 2.0**    | `Knight/Mage/Rogue(+Hooded)/Barbarian/Ranger` GLBs + Rig_Medium anims + gear bits (weapons, shields, mug, arrow bundle)                                                                                                                                                                                                                                                                                                                                                                                                                     | **Humanoid NPCs & bandits** (vendors, quest givers wear these too)                                                                                 |

## 3. Items & Weapons (`assets/items/`)

| Pack                           | Contents                                                                                                                                                     | Use                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **KayKit Fantasy Weapon Bits** | `sword_A–E`, `dagger_A/B`, `axe_A–C`, `hammer_A–C`, `staff_A/B`, `wand_A`, `spear_A`, `halberd`, `bow_A/B(±string)`, `arrow_A/B`, `shield_A–C`, fist weapons | Player weapon models: Warrior swords+shields, Rogue daggers, Mage staves/wand, Cleric hammers+shields; tier/rarity via recolor variants in pipeline |
| **Misc Weapons MiniPoly**      | `Talwar`, `Devil's Sword`, `Devils Axe`, `Cleaver`, `Dagger`, `Axe` ×2, `Trident`                                                                            | High-tier/Legendary silhouettes (e.g. Emberbrand = Devil's Sword retint)                                                                            |
| **Low Poly Fantasy Weapons**   | single combined GLB/gltf scene                                                                                                                               | split in pipeline; extra variety where silhouettes fit                                                                                              |
| **KayKit RPG Tools Bits**      | `axe`, `pickaxe`, `saw`, `lantern`, `torch`, `bucket`, `anvil`, `grindstone`, `journal/map/compass` props + workshop bits                                    | Profession tool props (auto-shown), settlement dressing, interactable props                                                                         |

## 4. World (`assets/world/`, 24 packs — counts are model files found)

| Pack (count)                                                                            | Use                                                                                                                                   |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| KayKit **Dungeon Pack** (849)                                                           | Ruins, mine interiors dressing, Ember Vault teaser, Ashcrag mine modules, chests, torches, gates                                      |
| KayKit **Forest Nature** (420)                                                          | Dawnshore/Weald trees, rocks, plants, mushrooms                                                                                       |
| KayKit **ResourceBits** (304)                                                           | Ore veins & material props: copper/iron/gold nuggets+bars (mining node dressing, vendor displays)                                     |
| **Low Poly Nature Models** (300)                                                        | broadleaf/pine variety, stumps, logs                                                                                                  |
| **Fantasy Props Mega Kit** (282)                                                        | settlement & interior props: anvils, barrels, beds, books, cauldron, chests, coins, candles, banners… (vendors, taverns, quest props) |
| **Stylized Mega Nature Kit** (272)                                                      | hero nature pieces, big cliffs, stylized trees (zone landmarks)                                                                       |
| **Ultimate Fantasy Buildings Kit** (128)                                                | Dawnhaven & village buildings                                                                                                         |
| **Medieval Village Pack** (88)                                                          | Sungraze farmsteads, fences, carts, wells                                                                                             |
| **Quaternius Cube World** (85)                                                          | stylization-mismatch risk — quarry for icons/props only, flagged review                                                               |
| **Pirate Bundle** (71)                                                                  | Dawnhaven harbor, wrecks, coast POIs, sandbar treasure dressing                                                                       |
| **Nature Mega Pack** (68)                                                               | filler variety                                                                                                                        |
| **Halloween Bundle KayKit** (63)                                                        | Emberwood gnarled trees, graves (Varkas necropolis), pumpkins (curiosity POIs)                                                        |
| **Animated Fish Bundle** (52 incl. 5 fishing rods)                                      | fishing rods (tier visuals), water ambience schools, catch hold-ups                                                                   |
| **Fantasy Free Pack** (42)                                                              | ruins bits                                                                                                                            |
| **Ultimate Nature Kit 2** (36)                                                          | large terrain heroes                                                                                                                  |
| **Low Poly Desert** (24) + **Egypt Assets**                                             | Ashcrag mesas, dead trees, weathered ruin flavor                                                                                      |
| **Farm Bundle** (10)                                                                    | Sungraze crops/farm props                                                                                                             |
| **Gems & Ores Pack** (combined scene)                                                   | Dawnstone/gem nodes + gem items (split in pipeline)                                                                                   |
| Rocks / Rocks and Cliffs / Misc Environment / Mega Pack / Forest Pack (combined scenes) | split in pipeline; cliff shells for slope>55° dressing                                                                                |

## 5. Textures & UI (`assets/textures/`)

- **Fantasy UI Borders (Kenney)** — PNG+vector border/frame set → accent seams only per UI_UX.md.
- **Particle Pack (Kenney)** — flame/magic/smoke/spark sheets → the VFX atlas backbone.
- **Noise Texture Pack** — terrain splat breakup, water caustics-ish scroll, dissolve masks.

## 6. Backgrounds (`assets/backgrounds/`, made by the owner)

16 `mmorpg_bg_*.png` + themed boards (tavern, stable, weaponshop, town map, missions, pets, patrol).
Use: menu/loading fallbacks & flavor boards inside UI (quest board texture, vendor headers). The
live 3D login vignette remains primary (UI_UX.md).

## 7. Reference (`assets/example_screenshots/`)

`Farever_World_Map.png` — the archipelago composition model for [design/WORLD.md](design/WORLD.md)
(distinct biome color blocking, bridges, island scatter). Style target, not a copy source.

## 8. Gaps & Acquisitions (tracked; CC0-first policy)

| Gap                              | Plan                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Audio: entirely absent**       | Source per design/AUDIO.md §3 (Kenney CC0 + curated CC0/CC-BY) — **decided 2026-08-02**                         |
| Fonts                            | Amaranth + Nunito Sans (OFL) self-hosted — download at P1                                                       |
| Skin-tone variants               | 5 palette-swap variants of the base-character texture (approved) — texture pipeline, P1                         |
| Weather VFX                      | rain sheets from Kenney particle pack + lightning flash (light pulse) + rainbow billboard (generated art) — P14 |
| Icons                            | game-icons.net SVGs (CC BY 3.0) via pipeline — P8                                                               |
| Water/sky                        | shader-generated (no assets needed)                                                                             |
| Splat ground textures            | hand-painted flat-color ramps + noise (generated in-pipeline, Farever-vibrant)                                  |
| Savanna/acacia + red-maple trees | recolor pipeline variants of existing trees (palette swap pass) — verified feasible with palette textures       |

## 9. License Ledger (to verify & lock at Phase 0)

Quaternius packs: CC0 (site-stated; PRO/Standard packs are patron builds — **verify redistribution
terms in included licenses**, expected permissive; flag: do not re-serve raw packs publicly beyond
game use). KayKit FREE packs: CC0 (credit appreciated → CREDITS.md anyway). Kenney: CC0.
Sketchfab-sourced packs (`scene.gltf` pattern: Low Poly Fantasy Weapons, Gems & Ores…): licenses
**must be confirmed** from their `.txt`/source URLs in-folder before shipping — Phase 0 checklist
item; anything non-redistributable gets replaced or excluded from served builds.
