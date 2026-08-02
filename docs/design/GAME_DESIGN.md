# Dawned — Game Design Document (Core Vision)

> The single source of truth for what Dawned *is*. Every other design doc refines a part of this one.
> Related: [WORLD.md](WORLD.md) · [COMBAT.md](COMBAT.md) · [CLASSES.md](CLASSES.md) · [PROGRESSION.md](PROGRESSION.md) · [ITEMS_LOOT.md](ITEMS_LOOT.md) · [PROFESSIONS.md](PROFESSIONS.md) · [QUESTS_POI.md](QUESTS_POI.md) · [NPCS_ENEMIES.md](NPCS_ENEMIES.md) · [UI_UX.md](UI_UX.md) · [GM_TOOLS.md](GM_TOOLS.md) · [AUDIO.md](AUDIO.md)

## 1. What is Dawned?

Dawned is a **low-poly, vibrant, 3D action-combat sandbox MMORPG that runs in the browser**. It is an
open-world exploration game for a small private community (5–20 concurrent players), inspired by the
*feel* of Farever (art style, island world, vibrancy), Guild Wars 2 (active combat, events-in-the-world
philosophy, exploration rewards) and Black Desert Online (sandbox structure, gathering, flow of combat).

Version 0.1.0 is **not** an MVP, prototype or skeleton. It is the complete first playable of a real
MMORPG: 4 fully animated classes, an authored open world across an island archipelago, real action
combat, progression to level 30, gathering professions, side quests, loot, chat, and GM tooling —
running on a 4 GB / 1-core VPS at `play.pathlands.cc`.

**Genre:** Sandbox Open-World Action-Combat MMORPG
**Platform:** Desktop browser (WebGL2), designed for 1080p and 1440p screens
**Session shape:** Drop-in persistent world, solo-friendly, optional social play
**Audience:** The developer's friend group; players who like exploring, fighting, gathering, and slowly building a character

## 2. Design Pillars

Every feature decision is tested against these five pillars, in order:

### P1 — Combat you feel in your hands
Action combat with free aim, movement during fights, dodge rolls, telegraphs, hit-stop, and readable
animations. No tab-targeting, no auto-attacking from 40 meters. If a fight could play itself, it is
wrong. Every ability has an animation, a sound, a visual effect, and a reason to exist.

### P2 — A world worth wandering
The world is the content. Distinct, color-coded island biomes (Farever-style), points of interest that
reward curiosity, resources that pull players into corners of the map, vistas, secrets, and named
places. Quests are seasoning, not the spine — exploration is the spine.

### P3 — Alive, vibrant, handcrafted
Saturated colors, moving foliage, ambient creatures, animated everything (UI included). Low-poly is a
style, not an excuse. The game should feel warm and alive at first glance, like a toy box world with
real danger in it.

### P4 — Solo-friendly, never lonely
All 0.1.0 content is clearable solo by every class (including the Cleric). Other players are a bonus
you bump into — visible in the world, in chat, at town — never a requirement. Group systems arrive
post-0.1.0 without invalidating solo play.

### P5 — Built to be edited
Everything that defines content — items, enemies, spawns, zones, quests, the terrain itself — lives in
data, editable through the Dawned-Admin panel without touching code. The game is a platform its owner
can keep growing for years.

## 3. Core Gameplay Loops

### Minute loop — the fight
Spot enemy camp → position, open with an ability → weave basic-attack combos and abilities → dodge
telegraphed attacks → manage resource (Rage/Mana/Energy) and stamina → loot the corpses → HP/resource
recovery beat → next pull.

### Session loop — the excursion (20–60 min)
Leave a town/shrine with a light goal (a quest, a resource, an unexplored POI on the map edge) →
travel through the open world (sprint/stamina management, avoid or fight elites) → reach the goal, do
it → inventory fills with loot and materials → return (or push deeper) → sell/stash, spend stat and
skill points, maybe a new gear piece → log off at a shrine or town.

### Progression loop — the character (weeks)
Level 1→30 through mixed XP (kills, quests, gathering, discovery) → stat points shape the build →
skill tree specializes the class → gear upgrades from loot, quest rewards and vendors → profession
levels unlock higher-tier nodes in higher-level zones → finish: max level, completed map, geared
character; post-0.1.0 systems (crafting, duels, groups) extend from here.

### World loop — the server (persistent)
Resource nodes deplete and respawn on schedules → enemy camps repopulate → day/night tint shifts
and weather passes over the isles (rain, thunderstorms, post-rain rainbows — visual, phase 14) →
players cross paths, chat globally and locally → GMs run events by spawning enemies and
broadcasting.

## 4. Feature Summary for 0.1.0 (contract)

These ship in 0.1.0, fully working — see [ROADMAP.md](../../ROADMAP.md) for phases and
[CONTENT_0.1.md](../CONTENT_0.1.md) for exact content counts:

| Area | Scope |
|---|---|
| Accounts | Register/login (account name + password), session persistence, character slots |
| Characters | Creation (name, class, body, outfit, hair), selection screen, deletion with confirmation |
| Classes | Warrior (Tank, Rage), Mage (DPS, Mana), Rogue (DPS, Energy+Combo), Cleric (Healer, Mana) — 8 abilities each, full animation sets |
| Combat | Server-authoritative action combat: free-aim, melee arcs, projectiles, ground AoE telegraphs, dodge roll, hit reacts, floating damage, death/respawn at shrines |
| Progression | Level cap 30, XP curve, 3 stat points/level, class skill tree (1 point/level), ability unlocks |
| Items | Inventory, equipment slots, rarities, tooltips, loot tables, world drops, gold, vendors, consumables, unique icons per item |
| Professions | Woodcutting, Mining, Herbalism, Fishing (with minigame) — own levels 1–30, tiered nodes per zone |
| World | Hand-built island archipelago (6 zones, level 1–30), zone system, POIs, discovery, interactables, world map + minimap, visual day/night & weather (rain, thunder, rainbows) |
| Quests | ~25–30 side quests scattered in the world (kill/collect/deliver/explore/interact), dialogue UI, quest log/tracker |
| Movement | WASD + camera, jump, stamina-based sprint (stamina grows with END/level), swim (surface) |
| Social | Chat (global/local/whisper/system), player nameplates; no grouping yet |
| GM | GM/Admin roles, full in-game command suite + GM help panel, audit logging |
| Admin | Dawned-Admin web panel: map editor, quest editor, database editors, live ops (separate repo) |

**Explicitly out of 0.1.0** (planned later): crafting/processing, groups/XP share, duels, drop-trading,
dungeons, mounts (never planned — sprint is the travel skill), open-world PvP (not planned), guilds
(not planned), raids (not planned), gear enhancing (not planned).

## 5. The Player Fantasy

You wash up on the shores of the Dawnlands — a scatter of islands where the sun always seems to be
rising somewhere. There is no chosen-one plot. You are a settler-adventurer: you fight what prowls the
wilds, chop, mine, pick and fish your way to self-sufficiency, map the isles bridge by bridge, and
grow from a peasant with a rusty blade into a named force on the archipelago. The world doesn't queue
you into content; it just sits there, colorful and dangerous, daring you to walk further from town.

## 6. Tone & Art Direction

- **Look:** Low-poly, flat-shaded/palette-textured meshes (Quaternius / KayKit style), saturated
  vibrant colors per biome, soft stylized lighting, colored distance fog, simple stylized water with
  shore foam, big readable silhouettes.
- **Mood:** Warm, adventurous, a little whimsical (Monster Bundle enemies: Mushnubs, Glubs,
  Alpakings) but with real menace in high zones (Demons, Dragons, Yetis in the canyons).
- **Motion:** Everything idles, sways, bobs or breathes. Foliage wind-sway shader, ambient critters
  (bunnies, birds, cats, fish), UI elements animate in/out. See P3.
- **Readability first:** enemy telegraphs, rarity colors, resource node glints and interactable
  outlines are always readable against every biome palette.

## 7. Key Numbers (canonical)

| Constant | Value | Rationale |
|---|---|---|
| Level cap (0.1.0) | 30 | Spec requirement |
| Classes | 4 | Warrior / Mage / Rogue / Cleric |
| Abilities per class | 8 + basic combo + dodge | Hotkeys 1–8 |
| Stat points per level | 3 | Into STR/AGI/INT/VIT/END |
| Skill points | 1 per level from 2 (29 total) | Class skill tree |
| Target time to cap | ~35–45 h casual solo | Friend-group pacing |
| Concurrent players | 5–20 | Sizing for netcode & VPS |
| World size | 2048 m × 2048 m bounds (archipelago + ocean) | See WORLD.md |
| Server tick | 20 Hz | See tech/NETWORKING.md |
| Client target | 60 FPS @ 1080p on mid-range hardware | Desktop-first |

## 8. What "no shortcuts" means in practice

- Systems are finished vertically: an ability ships with its animation, VFX, sound hook, tooltip,
  server validation, and skill-tree interactions — or it doesn't ship.
- No placeholder-forever: placeholder art/sounds are tracked in the phase checklist and replaced
  before the phase closes.
- Server authority everywhere (see tech/SECURITY.md) — no "client says so" logic, even at 20 players.
- Content lives in data with editors (see Dawned-Admin), not hardcoded — even when hardcoding would
  be faster today.
- Every phase in ROADMAP.md has a Definition of Done and gets play-tested before the next begins.
