# Dawned — World Design: The Dawnlands

> The open world for 0.1.0: an island archipelago modeled on the structure of the Farever world map
> (`assets/example_screenshots/Farever_World_Map.png`): distinct color-coded island biomes separated
> by ocean, joined by bridges, each with its own settlement, palette, enemies and resources.
> Technical terrain representation: [../tech/ARCHITECTURE.md](../tech/ARCHITECTURE.md). Content counts: [../CONTENT_0.1.md](../CONTENT_0.1.md).

## 1. Overview

**The Dawnlands** are a 2048 m × 2048 m world space: five major isles and a handful of islets in a
warm sea. Land covers roughly 55–60% of the space. Progression flows counter-clockwise from the
south-western starter isle, with bridges gating the natural path (higher-level isles are visibly
"further"). Swimming lets daring players shortcut — the water is safe near shore, but low-level
players who land on a level-25 beach will regret it, which is exactly the sandbox promise.

Reference layout (mirrors Farever's composition, not its exact shapes):

```
                          NW islet                NE
   [Elder Grove]  ~sea~        [ASHCRAG CANYONS  lvl 24–30]
      (30+, hidden)                red rock / mesas / mines
                                        |bridge
              [EMBERWOOD 12–18]         |
               crimson forest —bridge— [SUNGRAZE SAVANNA 18–24]
                  |bridge                golden dry plains
   [VERDANT WEALD 6–12]                     |
     deep green forest                   ~sea~
        |bridge
   [DAWNSHORE 1–6]  ←  spawn, main town Dawnhaven
     lush meadows, beaches (S/SW)
```

## 2. Zone Roster

Zone = gameplay region with level band, palette, fog/lighting profile, music mood, enemy roster,
resource tier and one settlement/camp. Zones are painted as polygons in the Admin Map Editor and
drive: nameplate banner on entry, minimap label, enemy/resource spawn tables, ambience.

| #   | Zone                 | Levels     | Biome & palette                                                                               | Settlement                           | Resource tier      |
| --- | -------------------- | ---------- | --------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------ |
| 1   | **Dawnshore**        | 1–6        | Lush spring meadows, flower fields, white beaches; fresh greens + warm sand                   | **Dawnhaven** (main town, safe zone) | T1                 |
| 2   | **Verdant Weald**    | 6–12       | Dense old forest, giant trees, mossy rocks, fireflies; deep greens, teal shade                | **Mosshollow** (village)             | T2                 |
| 3   | **Emberwood**        | 12–18      | Crimson/autumn forest, red maples, ruins overgrown with red ivy; reds, oranges, warm browns   | **Cinderfall** (ruined-town camp)    | T3                 |
| 4   | **Sungraze Savanna** | 18–24      | Golden dry grassland, acacia-style trees, abandoned farmsteads, rock outcrops; yellows, ochre | **Sunwatch** (palisade outpost)      | T4                 |
| 5   | **Ashcrag Canyons**  | 24–30      | Red-rock mesas, canyons, scree, sparse dead trees, mining scars; rust reds, purple shadow     | **Rustpick Camp** (mining camp)      | T5                 |
| 6   | **The Elder Grove**  | 30 (elite) | Small hidden islet, luminous ancient grove, giant mushrooms; saturated emerald + glow accents | — (one hermit NPC)                   | T5 rare            |
| —   | **The Dawnsea**      | n/a        | Ocean, beaches, shallows, tiny sandbars with chests                                           | —                                    | Fishing everywhere |

Zone asset sourcing (all packs already in `assets/world/`): Dawnshore & Verdant Weald ← KayKit Forest
Nature, Low Poly Nature Models, Stylized Mega Nature Kit, Nature Mega Pack; Emberwood ← recolored
nature kits + Halloween Bundle (gnarled trees, fitting ruins) + Fantasy Free Pack ruins; Sungraze ←
Farm Bundle, Medieval Village (farmsteads), savanna recolors; Ashcrag ← Low Poly Desert Assets, Egypt
Assets (weathered ruins), Low Poly Rocks and Cliffs; settlements ← Ultimate Fantasy Buildings Kit,
Medieval Village Pack, Fantasy Props Mega Kit (interiors/props); Pirate Bundle → coasts, wrecks,
harbor of Dawnhaven.

## 3. Zone Details

### 3.1 Dawnshore (1–6) — "the first hour is sacred"

- **Function:** Teach by playing: movement, sprint, first combat, first gather of each profession,
  first quest, first vendor, first shrine. No tutorial popup walls — signposts, NPC one-liners and a
  handful of "Getting Started" side quests.
- **Layout beats:** Beach spawn cove (soft framing: wreck debris, crabs=Glubs) → meadow bowl with
  Dawnhaven on the hill → flower fields (herbalism showcase) → light birch grove (woodcutting) →
  shallow copper outcrops (mining) → fishing pier (fishing) → bridge gate to Verdant Weald at the
  north with a level-7 "wall" camp signaling the step up.
- **Dawnhaven (safe zone):** bank-less but has: General Goods vendor, Armorer, Weaponsmith, Alchemist
  (potions), profession trainers (flavor NPCs, no cost), quest board, shrine (respawn + fast travel
  anchor), harbor, tavern (rested-XP hook post-0.1). Safe zone = no enemy spawns, no damage.
- **Enemies:** Glub, Bunny (passive), Pink/Green Blobs, Mushnub, young Boar-type (Monster Bundle
  "Dino" recolor), bandit Peasant (KayKit Adventurer rigs as humans). Camp: Blob Bog. Mini-boss:
  **Mossback the Ancient Glub** (lvl 6, quest target).

### 3.2 Verdant Weald (6–12)

- **Feel:** canopy shade, god-ray shafts, fireflies at all hours, mossy boulders; verticality via
  fallen giant trunks as ramps.
- **Beats:** Mosshollow treetop-adjacent village → herb hollows (T2 herbs) → old logging site
  (T2 trees + quest chain about what stopped the loggers) → spider-less spooky dell (Ghost/Ghost
  Skull at night edges) → Mushroom Circle camp (Mushnub Evolved + **Mushroom King** zone boss, lvl 12)
  → hidden waterfall grotto POI (chest + vista).
- **Enemies:** Mushnub/Evolved, Frog, Armabee (+Evolved at hives), Ghost (ruin edges), Wizard-tribe
  outcasts (Monster Bundle Wizard/Tribal), wolves (Cat model recolor "Weald Stalker").

### 3.3 Emberwood (12–18)

- **Feel:** perpetual autumn; red leaf-fall particle ambience; ruins of the old kingdom (Fantasy
  Free Pack / Dungeon Pack pieces surface-dressed).
- **Beats:** Cinderfall camp in a ruined plaza → leaf-buried road network (discovery rewards for
  following side roads) → Armabee orchards gone feral → ruined chapel (Skeleton camps: KayKit
  Skeletons full set) → the Ember Vault sealed door (dungeon teaser for post-0.1) → **Bonelord
  Varkas** (Skeleton_Warrior elite, lvl 18) at the necropolis.
- **Enemies:** Skeleton Minion/Rogue/Mage/Warrior, Ghost/Ghost Skull, Cactoro (ruin gardens),
  Monkroose (feral orchards), bandit Rangers (KayKit Adventurer Ranger).

### 3.4 Sungraze Savanna (18–24)

- **Feel:** wide open sightlines — the "learn to pick your fights" zone; heat shimmer, tall golden
  grass patches that hide swarms; abandoned farmsteads to loot.
- **Beats:** Sunwatch palisade → dust road with ambush points → three farm ruins (each a themed camp:
  scarecrow field, barn cellar, windmill) → dry ravine with T4 ore seams → tar pit with bones
  (Dino pack use) → **Alpaking Prime** (lvl 24 elite herd boss) on the high steppe.
- **Enemies:** Alpaking/Evolved herds, Dino raptors, Orc & Orc Enemy warbands, Tribal hunters,
  Chicken/Bunny ambient, Cactoro Evolved, dust Hywirls.

### 3.5 Ashcrag Canyons (24–30)

- **Feel:** hostile, vertical, echoing; wind gusts; narrow choke fights and mesa-top vistas; the
  endgame zone where sprint/stamina and dodge mastery are assumed.
- **Beats:** Rustpick Camp clinging to a cliff → switchback descent into the Great Rift → abandoned
  mine complex (T5 ore, Dungeon Pack modules as open-air mine dressing) → demon-scorched terrace
  (fire palette break) → Yeti caves in the shaded north face → **Ashwing** (Dragon Evolved, lvl 30
  world boss with full telegraph suite, soloable-but-hard) roosting on the highest mesa.
- **Enemies:** Demon, Blue Demon, Goleling/Evolved, Yeti (both variants), Ghost Skull swarms, Orc
  elite guards, Squidle (toxic pools), Dragon (roaming lvl 28 rare).

### 3.6 The Elder Grove (30, elite islet)

- Hidden: no bridge, no map label until discovered; reachable only by a long swim from Verdant Weald's
  north cape (stamina check) or a one-way ancient portal POI in Ashcrag.
- Content: elite versions of forest fauna, the hermit NPC (lore + one long quest), T5-rare herb
  **Dawnpetal** (only source), **Elder Treant** boss (Goleling Evolved giant-scale), vista that
  overlooks the whole archipelago (discovery achievement).

## 4. World Systems

### 4.1 Points of Interest & Discovery

- POI types: **Vista** (climbable lookout, camera flourish + XP), **Landmark** (named place, XP on
  first entry), **Hidden Cache** (chest behind light platforming/searching), **Camp** (enemy
  concentration with named elite), **Ancient Shrine** (respawn + fast-travel node), **Curiosity**
  (one-off scripted interactable, e.g. a ringable bell, a wishing well that eats 1 gold).
- Discovery = first-time XP + world-map reveal of that POI icon + chat toast. Target ~45 POIs total
  (see CONTENT_0.1.md).
- Zone discovery: entering a zone first time = banner + XP + map region un-grays.

### 4.2 Shrines, death & fast travel

- Each zone has 1–2 **Ancient Shrines** + towns/camps have one. Attuning (interact once) unlocks it.
- Death → soul screen → respawn at last-attuned or nearest-attuned shrine with 30 s "Dawned"
  weakness debuff (-15% damage dealt). No XP loss, no durability (0.1.0 keeps death light; revisit
  post-0.1).
- Fast travel: from any attuned shrine to any other attuned shrine, costs gold scaling with distance
  (small sink), 3 s channel. Keeps the world walked early (few shrines attuned) but respects time
  later. No mounts ever — sprint + shrines is the travel model.

### 4.3 Interactables (world objects with verbs)

Framework object (see tech/ARCHITECTURE.md §entities): prompt radius, hold-or-press F, per-type
server logic, cooldown/one-shot/respawn policy, optional loot table, optional quest hook.
0.1.0 set: chests (common/rare, respawning), resource nodes (see PROFESSIONS.md), quest props
(levers, notes, corpses to inspect...), shrines, campfires (sit → +regen "Cozy" buff 60 s), signposts
(world flavor + directions), doors/gates (settlements), the Elder portal, quest boards, vendor stalls.

### 4.4 Zone system (technical contract)

- Zones are painted polygons (admin editor) with properties: id, name, level band, ambience profile
  (fog color/density, light tint, music track id, ambient SFX set), safe-zone flag, respawn shrine
  list, spawn-table bindings.
- Server: zone lookup via point-in-polygon grid baked at map publish; drives spawn director and
  discovery. Client: same baked data drives banners, fog/light lerp (5 s blend on crossing), music
  crossfade, minimap label.

### 4.5 Ambient life (P3 "alive" pillar)

Non-combat critters with wander AI: Bunny, Cat, Chicken, Pigeon, Birb (flight loops), Fish schools
(Animated Fish Bundle) in shallows; butterflies/fireflies as particles; NPC villagers with tiny
routines (2–3 waypoints + idle anims: Counter__, Sitting__, Farm_* from UAL packs).

### 4.6 Weather (visual, lands in P14 with day/night)

- A world-level **weather director** rolls per-zone states from each zone's ambience-profile
  weights (`clear / overcast / rain / storm`, duration 4–10 min per state). Everyone in a zone
  sees the same sky (server-broadcast `WeatherState`, ~10 s blend transitions).
- **Rain:** particle sheets + darkened sun/fog tint + ambience crossfades to a rain bed.
  **Storm:** rain + lightning flashes (directional-light pulses) with distance-delayed thunder.
  **Rainbow:** 20% chance for ~90 s after daytime rain ends — billboard arc anchored over the sea.
- Zone flavor: Dawnshore/Weald rain often; Sungraze rarely; Ashcrag storms hard but briefly;
  the Elder Grove never rains (it shimmers instead).
- Strictly visual in 0.1.0 — no gameplay modifiers. Gameplay hooks (storm events, night spawns)
  are 0.4+ candidates. GM override: `/weather` (GM_TOOLS.md).

## 5. World Map & Minimap

- **World map (M):** stylized top-down render of the archipelago (baked from actual terrain at map
  publish, palette-graded to look hand-drawn like the Farever reference). Fog-of-unknowing: zones
  gray until entered, POIs hidden until discovered. Player marker, shrine icons (click = fast
  travel), quest markers for accepted quests, coordinates readout for GM use.
- **Minimap (HUD):** circular, rotates with camera (toggle north-lock), shows nearby: players, quest
  targets in range, discovered POIs, resource nodes of professions above threshold? → no: nodes only
  while unlocked profession and within 40 m ("prospector sense" keeps exploration honest).

## 6. Terrain & environment art targets

- Heightmap terrain, 1 m grid, painted with 8 splat layers per zone set (grass, lush grass, dirt,
  path, sand, rock, red-leaf litter, ash/scree — final set per zone in Admin editor), cliffs from
  rock meshes where slope > 55° (painted rock walls, not stretched terrain).
- Water plane at world sea level y=0 with shore blend; rivers as sloped water meshes (Weald,
  Emberwood); waterfalls as particle + scrolling mesh at the grotto.
- Wind sway on all foliage; per-zone fog + hemisphere/sun tint (see zone table); skybox: gradient +
  Farever-like soft clouds; distant sea sparkle.
- Bridges are landmark art pieces (Fantasy Buildings/Pirate packs) — crossing one should feel like a
  chapter turn.

## 7. Authoring pipeline

The world ships **pre-built by us** but 100% editable: it is authored _in the Dawned-Admin Map
Editor_ (terrain sculpt/paint, prop placement, spawn/zone/POI painting) on top of a generated base
(island masks → heightmap synth → auto-splat pass), then hand-dressed per the beats above. The owner
can extend it, or wipe any layer (props/spawns/paint) per zone and redecorate from scratch. Nothing
about the shipped world is special-cased in code.

### 7.1 As built — the terrain (P12-A, 2026-08-06)

The base is a whole-world mask synthesis run from the panel
(`tools/content/world-data.ts` + `pnpm world:author`), previewable offline with
`pnpm world:preview`. **Measured: 57.6 % land** — inside §1's 55–60 % — over 766 chunks of 1024,
with **all six isles confirmed separate landmasses by flood fill** and every land vertex standing
in a zone.

Two things about the shape are decisions rather than implementation:

- **The isles are generated OVERLAPPING and the straits are cut afterwards.** §1 asks for two
  things at once: 55–60 % of a 2048 m box as land, and bridges that gate the natural path. Six
  landmasses far enough apart to leave open water between them cannot cover that much of the box.
  So the masks merge into one continent and six `carve` masks sever it — which is also what a
  strait _is_. Bank steepness is depth over half-width and terrain past 55° is auto-unwalkable
  (§6), so every channel is wide relative to its depth: swimmable, with beaches on both shores.
- **A strait's geometry is derived from the two isles it separates**, not typed. Typed, three of
  the five original channels severed nothing — the isles joined around the ends of the cuts, and
  one carve sat at nearly a right angle to where it belonged. A depth probe at each channel's own
  centre reported open water for all five, which was true and useless; only a flood fill answers
  "is this still one landmass".

Three deviations from the text above, each reported rather than quietly absorbed:

| Spec                                                     | As built                                                                          | Why                                                                                                                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §1's diagram puts a small islet in the **north-west**    | it stands in the southern Dawnsea instead                                         | at 57 % coverage Emberwood, Sungraze and Ashcrag fill that third of the map between them. Three attempts up there came back either absorbed into Ashcrag or cut in half by the Emberwood channel — no water. |
| a sandbar **halfway across** the Dawnshore↔Weald channel | the wreck bar sits in open sea off Dawnshore's north-east cape                    | carves apply after every land mask, so a bar in the deepest part of a 76 m strait would have to be a 76 m mountain to break the surface. The rest-stop beat costs the channel; the bar keeps its shore.      |
| **The Dawnsea** is "n/a" in §2's zone table              | it is a real zone row, listed LAST so the six land zones win the first-match test | publish blocks on land in no zone, and the sandbars stand in water no isle's ring reaches. Its ambience is the open-ocean profile the zones file would otherwise carry as `defaultAmbience`.                 |

Rivers, per-chunk water overrides and the waterfall grotto (§6) are **not** in the base pass — they
are hand-dressing on top of it, and the map editor's per-chunk water tool is what places them.
