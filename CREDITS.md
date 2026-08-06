# CREDITS — Dawned

Dawned is built on generously licensed art. This file is partly hand-written (this header + pack
credits) and partly **generated** (the per-file ledger section is produced by the asset pipeline
from manifest provenance data — see docs/tech/ASSET_PIPELINE.md; builds fail if a served asset has
no ledger entry). An in-game credits screen renders this file.

## Asset packs

| Source | Packs (in `assets/`) | License |
|---|---|---|
| **Quaternius** (quaternius.com) | Universal Base Characters, Modular Character Outfits – Fantasy, Universal Animation Library 1 [PRO] & 2 [Standard], Monster Bundle, Animated Fish Bundle, Ultimate Nature Kit 2 [Standard], Stylized Nature MegaKit [Standard], Fantasy Props MegaKit [Standard], **Ultimate Fantasy Buildings Kit [Standard]**, Cube World, Farm, Pirate bundles | CC0 1.0 Universal. Two of these ship `License_Standard.txt` in-folder stating exactly that; **Ultimate Nature Kit 2 and the Buildings Kit do not**, and are shipped on the judgement that they are the same publisher, the same `[Standard]` packaging and the same glTF export as their siblings. Written down rather than assumed — if that is ever wrong, these two are what to pull. |
| **KayKit** (Kay Lousberg, kaylousberg.com) | Adventurers 2.0 FREE, Skeletons 1.1 FREE, Fantasy Weapon Bits, RPG Tools Bits, ResourceBits, Forest Nature Pack, Low Poly Dungeon Pack, Halloween Bundle | CC0 (credit appreciated — hereby given!) |
| **Kenney** (kenney.nl) | Fantasy UI Borders, Particle Pack | CC0 |
| Various (Sketchfab & itch sources) | Low Poly Fantasy Weapons, Misc Weapons MiniPoly, Gems & Ores, Nature/Rocks/Desert/Egypt/**Medieval Village** packs, Noise Texture Pack | Per-pack — **license verification is a gate** before any file is served. P10 wanted the Gems & Ores pack for its ore-in-stone rocks and did **not** use it: the folder carries no license file and its glTF is a third-party conversion, so its provenance cannot be attributed. The mining nodes are tinted KayKit rocks instead. P12 wanted the **Medieval Village Pack** for Sungraze farmsteads and did not use it for the same reason — no license file, FBX/OBJ only, unattributable; the farmsteads come from the Buildings Kit's own `Farm_*` and `Windmill_*` models instead. |
| **Owner-made** | `assets/backgrounds/*` (menu/board art) | Project-internal |

## Icons
Item/ability/UI icons derived from **game-icons.net** — CC BY 3.0. Individual icon authors
(Lorc, Delapouite, and others) are credited per-icon in the generated ledger below and on the
in-game credits screen, per the license's attribution requirement.

## Fonts
- **Amaranth** (Gesine Todt) — SIL OFL 1.1
- **Nunito Sans** (Vernon Adams et al.) — SIL OFL 1.1

## Audio
To be curated (CC0-first) — every file will be listed in the generated ledger with source, author
and license. See docs/design/AUDIO.md.

## Inspiration
Farever, Guild Wars 2 and Black Desert Online inspired the feel. No assets, code, text or maps
from these games are used.

---

<!-- GENERATED LEDGER BELOW — do not edit by hand; `pnpm assets:build` rewrites it -->

## Per-file ledger

### KayKit Dungeon Asset Pack 1.1
Pack id `kaykit-dungeon` · author **Kay Lousberg (KayKit)** · license **CC0-1.0** · https://kaylousberg.itch.io/

- `world_props_chest` — assets/world/KayKit Low Poly Dungeon Pack/Assets/gltf/chest.gltf
- `world_props_pillar_decorated` — assets/world/KayKit Low Poly Dungeon Pack/Assets/gltf/pillar_decorated.gltf

### KayKit Forest Nature Pack 1.0 FREE
Pack id `kaykit-forest` · author **Kay Lousberg (KayKit)** · license **CC0-1.0** · https://kaylousberg.itch.io/

- `world_nature_bush_1_a_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Bush_1_A_Color1.gltf
- `world_nature_bush_1_b_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Bush_1_B_Color1.gltf
- `world_nature_bush_1_c_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Bush_1_C_Color1.gltf
- `world_nature_grass_1_a_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Grass_1_A_Color1.gltf
- `world_nature_grass_1_a_singlesided_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Grass_1_A_Singlesided_Color1.gltf
- `world_nature_grass_1_b_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Grass_1_B_Color1.gltf
- `world_nature_grass_1_b_singlesided_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Grass_1_B_Singlesided_Color1.gltf
- `world_nature_rock_1_a_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Rock_1_A_Color1.gltf
- `world_nature_rock_1_b_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Rock_1_B_Color1.gltf
- `world_nature_rock_1_c_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Rock_1_C_Color1.gltf
- `world_nature_rock_2_a_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Rock_2_A_Color1.gltf
- `world_nature_rock_2_c_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Rock_2_C_Color1.gltf
- `world_nature_rock_2_e_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Rock_2_E_Color1.gltf
- `world_nature_rock_3_d_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Rock_3_D_Color1.gltf
- `world_nature_rock_3_h_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Rock_3_H_Color1.gltf
- `world_nature_tree_1_a_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Tree_1_A_Color1.gltf
- `world_nature_tree_1_b_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Tree_1_B_Color1.gltf
- `world_nature_tree_1_c_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Tree_1_C_Color1.gltf
- `world_nature_tree_2_a_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Tree_2_A_Color1.gltf
- `world_nature_tree_bare_1_a_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Tree_Bare_1_A_Color1.gltf
- `world_nature_tree_bare_1_b_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Tree_Bare_1_B_Color1.gltf
- `world_nature_tree_bare_1_c_color1` — assets/world/KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/Tree_Bare_1_C_Color1.gltf

### KayKit Resource Bits 1.0 FREE
Pack id `kaykit-resourcebits` · author **Kay Lousberg (KayKit)** · license **CC0-1.0** · https://kaylousberg.itch.io/

- `world_nature_wood_log_b` — assets/world/KayKit_ResourceBits_1.0_FREE/Assets/gltf/Wood_Log_B.gltf

### KayKit Skeletons 1.1 FREE
Pack id `kaykit-skeletons` · author **Kay Lousberg (KayKit)** · license **CC0-1.0** · https://kaylousberg.itch.io/

- `enemies_skeleton_mage` — assets/enemy_models/KayKit_Skeletons_1.1_FREE/characters/gltf/Skeleton_Mage.glb
- `enemies_skeleton_minion` — assets/enemy_models/KayKit_Skeletons_1.1_FREE/characters/gltf/Skeleton_Minion.glb
- `enemies_skeleton_rogue` — assets/enemy_models/KayKit_Skeletons_1.1_FREE/characters/gltf/Skeleton_Rogue.glb
- `enemies_skeleton_warrior` — assets/enemy_models/KayKit_Skeletons_1.1_FREE/characters/gltf/Skeleton_Warrior.glb

### KayKit RPG Tools Bits 1.0 FREE
Pack id `kaykit-tools` · author **Kay Lousberg (KayKit)** · license **CC0-1.0** · https://kaylousberg.itch.io/

- `items_tools_axe` — assets/items/KayKit_RPGToolsBits_1.0_FREE/Assets/gltf/axe.gltf
- `items_tools_pickaxe` — assets/items/KayKit_RPGToolsBits_1.0_FREE/Assets/gltf/pickaxe.gltf

### KayKit Fantasy Weapons Bits 1.0 FREE
Pack id `kaykit-weapons` · author **Kay Lousberg (KayKit)** · license **CC0-1.0** · https://kaylousberg.itch.io/

- `items_weapons_axe_a` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/axe_A.gltf
- `items_weapons_axe_b` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/axe_B.gltf
- `items_weapons_axe_c` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/axe_C.gltf
- `items_weapons_dagger_a` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/dagger_A.gltf
- `items_weapons_dagger_b` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/dagger_B.gltf
- `items_weapons_hammer_a` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/hammer_A.gltf
- `items_weapons_hammer_b` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/hammer_B.gltf
- `items_weapons_hammer_c` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/hammer_C.gltf
- `items_weapons_shield_a` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/shield_A.gltf
- `items_weapons_shield_b` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/shield_B.gltf
- `items_weapons_shield_c` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/shield_C.gltf
- `items_weapons_staff_a` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/staff_A.gltf
- `items_weapons_staff_b` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/staff_B.gltf
- `items_weapons_sword_a` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/sword_A.gltf
- `items_weapons_sword_b` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/sword_B.gltf
- `items_weapons_sword_c` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/sword_C.gltf
- `items_weapons_wand_a` — assets/items/KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/wand_A.gltf

### Quaternius Universal Base Characters (Standard)
Pack id `quaternius-base-characters` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `characters_hair_beard` — assets/player_characters/Universal Base Characters[Standard]/Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/Hair_Beard.gltf
- `characters_hair_buns` — assets/player_characters/Universal Base Characters[Standard]/Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/Hair_Buns.gltf
- `characters_hair_buzzed` — assets/player_characters/Universal Base Characters[Standard]/Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/Hair_Buzzed.gltf
- `characters_hair_buzzedfemale` — assets/player_characters/Universal Base Characters[Standard]/Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/Hair_BuzzedFemale.gltf
- `characters_hair_long` — assets/player_characters/Universal Base Characters[Standard]/Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/Hair_Long.gltf
- `characters_hair_simpleparted` — assets/player_characters/Universal Base Characters[Standard]/Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/Hair_SimpleParted.gltf
- `characters_superhero_female_fullbody` — assets/player_characters/Universal Base Characters[Standard]/Base Characters/Godot - UE/Superhero_Female_FullBody.gltf
- `characters_superhero_male_fullbody` — assets/player_characters/Universal Base Characters[Standard]/Base Characters/Godot - UE/Superhero_Male_FullBody.gltf

### Quaternius Ultimate Fantasy Buildings Kit (Standard)
Pack id `quaternius-buildings` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `world_buildings_barracks_firstage_level1` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Barracks_FirstAge_Level1.gltf
- `world_buildings_dock_firstage` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Dock_FirstAge.gltf
- `world_buildings_farm_firstage_level2_wheat` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Farm_FirstAge_Level2_Wheat.gltf
- `world_buildings_houses_firstage_1_level2` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Houses_FirstAge_1_Level2.gltf
- `world_buildings_houses_firstage_2_level1` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Houses_FirstAge_2_Level1.gltf
- `world_buildings_houses_firstage_3_level1` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Houses_FirstAge_3_Level1.gltf
- `world_buildings_houses_secondage_1_level1` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Houses_SecondAge_1_Level1.gltf
- `world_buildings_logs` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Logs.gltf
- `world_buildings_market_firstage_level2` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Market_FirstAge_Level2.gltf
- `world_buildings_mine` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Mine.gltf
- `world_buildings_port_firstage_level2` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Port_FirstAge_Level2.gltf
- `world_buildings_storage_firstage_level1` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Storage_FirstAge_Level1.gltf
- `world_buildings_storage_secondage_level1` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Storage_SecondAge_Level1.gltf
- `world_buildings_temple_firstage_level1` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Temple_FirstAge_Level1.gltf
- `world_buildings_towerhouse_firstage` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/TowerHouse_FirstAge.gltf
- `world_buildings_towncenter_firstage_level2` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/TownCenter_FirstAge_Level2.gltf
- `world_buildings_wall_firstage` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Wall_FirstAge.gltf
- `world_buildings_wall_secondage` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Wall_SecondAge.gltf
- `world_buildings_walltowers_door_firstage` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/WallTowers_Door_FirstAge.gltf
- `world_buildings_walltowers_secondage` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/WallTowers_SecondAge.gltf
- `world_buildings_watchtower_firstage_level2` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/WatchTower_FirstAge_Level2.gltf
- `world_buildings_windmill_firstage` — assets/world/Ultimate Fatasy Buildings Kit[Standard]/glTF/Windmill_FirstAge.gltf

### Quaternius Fantasy Props MegaKit (Standard)
Pack id `quaternius-fantasy-props` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `world_props_banner_2` — assets/world/Fantasy Props Mega Kit[Standard]/Exports/glTF/Banner_2.gltf
- `world_props_crate_wooden` — assets/world/Fantasy Props Mega Kit[Standard]/Exports/glTF/Crate_Wooden.gltf

### Quaternius Animated Fish Bundle
Pack id `quaternius-fish` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `world_nature_goldfish` — assets/world/Quaternius Animated Fish Bundle/Goldfish.glb
- `world_nature_koi` — assets/world/Quaternius Animated Fish Bundle/Koi.glb
- `world_nature_red_snapper` — assets/world/Quaternius Animated Fish Bundle/Red Snapper.glb
- `world_nature_swordfish` — assets/world/Quaternius Animated Fish Bundle/Swordfish.glb
- `world_nature_yellow_tang` — assets/world/Quaternius Animated Fish Bundle/Yellow Tang.glb

### Quaternius Monster Bundle
Pack id `quaternius-monsters` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `enemies_alpaking` — assets/enemy_models/Quaternius Monster Bundle/Alpaking.glb
- `enemies_alpaking_evolved` — assets/enemy_models/Quaternius Monster Bundle/Alpaking Evolved.glb
- `enemies_armabee` — assets/enemy_models/Quaternius Monster Bundle/Armabee.glb
- `enemies_armabee_evolved` — assets/enemy_models/Quaternius Monster Bundle/Armabee Evolved.glb
- `enemies_birb` — assets/enemy_models/Quaternius Monster Bundle/Birb.glb
- `enemies_blue_demon` — assets/enemy_models/Quaternius Monster Bundle/Blue Demon.glb
- `enemies_bunny` — assets/enemy_models/Quaternius Monster Bundle/Bunny.glb
- `enemies_cactoro` — assets/enemy_models/Quaternius Monster Bundle/Cactoro.glb
- `enemies_cat` — assets/enemy_models/Quaternius Monster Bundle/Cat.glb
- `enemies_chicken` — assets/enemy_models/Quaternius Monster Bundle/Chicken.glb
- `enemies_demon` — assets/enemy_models/Quaternius Monster Bundle/Demon.glb
- `enemies_dino` — assets/enemy_models/Quaternius Monster Bundle/Dino.glb
- `enemies_dragon` — assets/enemy_models/Quaternius Monster Bundle/Dragon.glb
- `enemies_dragon_evolved` — assets/enemy_models/Quaternius Monster Bundle/Dragon Evolved.glb
- `enemies_frog` — assets/enemy_models/Quaternius Monster Bundle/Frog.glb
- `enemies_ghost` — assets/enemy_models/Quaternius Monster Bundle/Ghost.glb
- `enemies_ghost_skull` — assets/enemy_models/Quaternius Monster Bundle/Ghost Skull.glb
- `enemies_glub` — assets/enemy_models/Quaternius Monster Bundle/Glub.glb
- `enemies_glub_evolved` — assets/enemy_models/Quaternius Monster Bundle/Glub Evolved.glb
- `enemies_goleling` — assets/enemy_models/Quaternius Monster Bundle/Goleling.glb
- `enemies_goleling_evolved` — assets/enemy_models/Quaternius Monster Bundle/Goleling Evolved.glb
- `enemies_green_blob` — assets/enemy_models/Quaternius Monster Bundle/Green Blob.glb
- `enemies_hywirl` — assets/enemy_models/Quaternius Monster Bundle/Hywirl.glb
- `enemies_monkroose` — assets/enemy_models/Quaternius Monster Bundle/Monkroose.glb
- `enemies_mushnub` — assets/enemy_models/Quaternius Monster Bundle/Mushnub.glb
- `enemies_mushnub_evolved` — assets/enemy_models/Quaternius Monster Bundle/Mushnub Evolved.glb
- `enemies_mushroom_king` — assets/enemy_models/Quaternius Monster Bundle/Mushroom King.glb
- `enemies_ninja` — assets/enemy_models/Quaternius Monster Bundle/Ninja.glb
- `enemies_orc` — assets/enemy_models/Quaternius Monster Bundle/Orc.glb
- `enemies_orc_enemy` — assets/enemy_models/Quaternius Monster Bundle/Orc Enemy.glb
- `enemies_pigeon` — assets/enemy_models/Quaternius Monster Bundle/Pigeon.glb
- `enemies_pink_blob` — assets/enemy_models/Quaternius Monster Bundle/Pink Blob.glb
- `enemies_squidle` — assets/enemy_models/Quaternius Monster Bundle/Squidle.glb
- `enemies_tribal` — assets/enemy_models/Quaternius Monster Bundle/Tribal.glb
- `enemies_wizard` — assets/enemy_models/Quaternius Monster Bundle/Wizard.glb
- `enemies_yeti` — assets/enemy_models/Quaternius Monster Bundle/Yeti.glb

### Quaternius Ultimate Nature Kit 2 (Standard)
Pack id `quaternius-nature-kit2` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `world_nature_birchtree_2` — assets/world/Ultimate Nature Kit2[Standard]/glTF/BirchTree_2.gltf
- `world_nature_bush_small_flowers` — assets/world/Ultimate Nature Kit2[Standard]/glTF/Bush_Small_Flowers.gltf
- `world_nature_deadtree_4` — assets/world/Ultimate Nature Kit2[Standard]/glTF/DeadTree_4.gltf
- `world_nature_flower_1_clump` — assets/world/Ultimate Nature Kit2[Standard]/glTF/Flower_1_Clump.gltf
- `world_nature_flower_2_clump` — assets/world/Ultimate Nature Kit2[Standard]/glTF/Flower_2_Clump.gltf
- `world_nature_flower_4_clump` — assets/world/Ultimate Nature Kit2[Standard]/glTF/Flower_4_Clump.gltf
- `world_nature_flower_5_clump` — assets/world/Ultimate Nature Kit2[Standard]/glTF/Flower_5_Clump.gltf
- `world_nature_mapletree_2` — assets/world/Ultimate Nature Kit2[Standard]/glTF/MapleTree_2.gltf

### Quaternius Modular Character Outfits — Fantasy (Standard)
Pack id `quaternius-outfits-fantasy` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `characters_female_peasant` — assets/player_characters/Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Female_Peasant.gltf
- `characters_female_ranger` — assets/player_characters/Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Female_Ranger.gltf
- `characters_male_peasant` — assets/player_characters/Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Male_Peasant.gltf
- `characters_male_ranger` — assets/player_characters/Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Male_Ranger.gltf

### Quaternius Stylized Nature MegaKit (Standard)
Pack id `quaternius-stylized-nature` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `world_nature_commontree_3` — assets/world/Stylizied Mega Nature Kit[Standard]/glTF/CommonTree_3.gltf
- `world_nature_fern_1` — assets/world/Stylizied Mega Nature Kit[Standard]/glTF/Fern_1.gltf
- `world_nature_twistedtree_2` — assets/world/Stylizied Mega Nature Kit[Standard]/glTF/TwistedTree_2.gltf

### Quaternius Universal Animation Library 1 (PRO)
Pack id `quaternius-ual1` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `characters_ual1` — assets/player_characters/Universal Animation Library 1[PRO]/Unreal-Godot/UAL1.glb

### Quaternius Universal Animation Library 2 (Standard)
Pack id `quaternius-ual2` · author **Quaternius** · license **CC0-1.0** · https://quaternius.com/

- `characters_ual2_standard` — assets/player_characters/Universal Animation Library 2[Standard]/Unreal-Godot/UAL2_Standard.glb

