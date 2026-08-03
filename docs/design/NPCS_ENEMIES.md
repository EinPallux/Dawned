# Dawned — NPCs, Enemies & AI

> Enemy archetypes, the AI model, spawn direction, the full 0.1.0 bestiary mapped to real asset
> models, and friendly NPCs. Enemy stats/abilities/loot are content rows (Dawned-Admin → Enemy
> Editor); archetype behaviors are engine systems parameterized by that data.

## 1. Enemy Archetypes (behavior templates)

| Archetype             | Behavior signature                                                                               | Telegraph pattern                                         |
| --------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| **Grunt** (melee)     | walks/runs at target, 1–2 melee swings, occasional heavy                                         | heavy = anim wind-up ≥0.6 s + small arc decal             |
| **Ranged**            | keeps 8–15 m, kites at 60% speed, projectile volleys, panic-melee inside 3 m                     | volley = draw anim; no decal (dodgeable projectile)       |
| **Caster**            | stationary casts, a ground-AoE, a self-shield once; interruptible (cast bar shown)               | AoE decal + cast bar; interrupt window is the counterplay |
| **Charger**           | lines up → telegraphed charge (rect decal) → overshoot stagger (punish window)                   | rect decal 0.8 s                                          |
| **Swarm**             | weak, fast, aggro in groups of 4–8, surround behavior (spread ring positions)                    | none (weakness is the telegraph)                          |
| **Elite**             | any above +30% stats, +1 extra ability, stagger-resistant (75% meter gain)                       | named plate, bigger scale ×1.15                           |
| **Boss** (zone/world) | scripted ability rotation (3–5 abilities), phase at 50% HP (+1 ability or modifier), arena leash | full decal suite incl. safe-wedge patterns                |

Rank multipliers (on base stats at level): Normal ×1 · Elite ×(HP 2.5, dmg 1.3) · Zone Boss ×(HP 8,
dmg 1.6) · World Boss (Ashwing) ×(HP 20, dmg 1.9, stagger-immune outside mechanic windows).

## 2. AI Model (server-side, 10 Hz decisions, 20 Hz motion)

FSM per enemy: `IDLE/PATROL → ALERT → COMBAT → RETURN(leash) → DEAD`.

- **Perception:** aggro radius (per type, 8–16 m; swarm 10 m shared), 140° vision cone + 4 m
  all-around "hearing"; social aggro: allies within 12 m of an aggroed camp-mate join (camp-tagged).
  Passive fauna (Bunny/Chicken/…) never aggro — they flee (nice for chases/quests).
- **Alert:** 0.5 s notice beat (head turn / `No` clip) — the player's "I've been seen" tell before
  commitment.
- **Combat:** target from threat table (COMBAT.md §6.5); movement via steering (seek + separation +
  strafe orbit for ranged) on the walkability grid; attack selection = per-type weighted list with
  cooldowns & range conditions (data-driven rows: `abilityId, weight, cooldown, rangeMin/Max,
hpThreshold?`); repositions between attacks (never statue-DPS).
- **Leash:** beyond camp radius (default 40 m) or 20 s without valid target → RETURN: sprint home
  invulnerable, full heal, threat wipe (classic, exploit-proof).
- **Pathing:** walkability grid (baked at map publish) + A* for RETURN and stuck-resolution;
  steering handles 95% of combat motion. Water is unwalkable to land enemies (shore-line kiting is
  legal player tech, leash covers abuse).
- Perf budget: ≤150 active-combat enemies world-wide (spawn director caps), decisions staggered
  round-robin (see tech/ARCHITECTURE.md §server loops).

## 3. Spawn Direction

- **Spawners** placed in Map Editor: point/area, enemy type(s) + weights, count, respawn timer
  (default 90 s, camps 120–180 s), rank overrides, patrol path (optional polyline), camp-tag for
  social aggro, active-window flag (night-only ghosts — day/night arrives P14; flag ships inert).
- Respawn is per-spawner ticket-based (kill → ticket queued) with jitter ±20%, paused while a player
  stands inside spawn radius <8 m (no face-spawns).
- **Population governor:** per-zone live cap; spawner priority ensures quest targets & bosses always
  refill first. Boss spawners announce respawn to zone via subtle world cue (Ashwing: distant roar).

## 4. Bestiary (0.1.0 — model-verified against `assets/`)

~36 types + 6 bosses. Model sources: Q = Quaternius Monster Bundle, KS = KayKit Skeletons, KA =
KayKit Adventurers (humanoid enemies use Adventurer rigs + weapon bits).

### Dawnshore (1–6)

| Enemy                           | Lvl | Archetype            | Model                       |
| ------------------------------- | --- | -------------------- | --------------------------- |
| Shore Glub                      | 1–2 | Swarm                | Q Glub                      |
| Meadow Blob / Bog Blob          | 2–4 | Grunt (slow, bouncy) | Q Green/Pink Blob           |
| Young Mushnub                   | 3–5 | Grunt                | Q Mushnub                   |
| Cliff Pigeon (aggressive)       | 3–4 | Swarm (dive)         | Q Pigeon                    |
| Bandit Forager                  | 4–6 | Ranged (thrown)      | KA Peasant-look + dagger    |
| Spore Lobber (P5 test camp)     | 3–5 | Ranged (spore bolt)  | Q Mushnub (until KA bandit) |
| **Mossback** (mini-boss, quest) | 6   | Elite Grunt          | Q Glub Evolved (scale 1.6)  |

### Verdant Weald (6–12)

| Enemy                         | Lvl   | Archetype                                                 | Model                           |
| ----------------------------- | ----- | --------------------------------------------------------- | ------------------------------- |
| Weald Frog                    | 6–8   | Grunt (tongue lash = short charge)                        | Q Frog                          |
| Mushnub Warrior               | 7–9   | Grunt                                                     | Q Mushnub Evolved               |
| Armabee Drone / Soldier       | 8–11  | Swarm / Charger                                           | Q Armabee / Evolved             |
| Gloom Ghost                   | 9–11  | Caster (drain bolt)                                       | Q Ghost                         |
| Weald Stalker                 | 10–12 | Charger (pounce)                                          | Q Cat (dark recolor, scale 1.3) |
| Outcast Hexer                 | 10–12 | Caster                                                    | Q Wizard                        |
| **Mushroom King** (zone boss) | 12    | Boss: spore AoE rings, minion call (Mushnubs), stomp cone | Q Mushroom King                 |

### Emberwood (12–18)

| Enemy                           | Lvl   | Archetype                                            | Model                                      |
| ------------------------------- | ----- | ---------------------------------------------------- | ------------------------------------------ |
| Skeleton Minion                 | 12–14 | Swarm                                                | KS Skeleton_Minion                         |
| Skeleton Rogue                  | 13–15 | Grunt (fast, backstab bonus)                         | KS Skeleton_Rogue                          |
| Skeleton Mage                   | 14–16 | Caster (bone bolt, bone-wall self-shield)            | KS Skeleton_Mage                           |
| Skeleton Warrior                | 15–17 | Grunt (shielded: frontal 50% mitigation — flank!)    | KS Skeleton_Warrior                        |
| Ember Cactoro                   | 13–15 | Ranged (needle spray cone)                           | Q Cactoro                                  |
| Feral Monkroose                 | 14–16 | Charger                                              | Q Monkroose                                |
| Grave Wisp                      | 15–17 | Caster (haunt DoT)                                   | Q Ghost Skull                              |
| Bandit Ranger                   | 16–18 | Ranged (bow)                                         | KA Ranger + bow_A                          |
| **Bonelord Varkas** (zone boss) | 18    | Boss: blade waves, summon minions, safe-wedge scream | KS Skeleton_Warrior (scale 1.5, dark tint) |

### Sungraze Savanna (18–24)

| Enemy                          | Lvl   | Archetype                                                | Model                          |
| ------------------------------ | ----- | -------------------------------------------------------- | ------------------------------ |
| Alpaking Grazer / Bull         | 18–21 | Grunt / Charger                                          | Q Alpaking / Evolved           |
| Steppe Raptor                  | 19–21 | Swarm (pack pounce)                                      | Q Dino                         |
| Orc Raider                     | 20–22 | Grunt                                                    | Q Orc                          |
| Orc Headhunter                 | 21–23 | Ranged (axe throw)                                       | Q Orc Enemy                    |
| Tribal Windcaller              | 21–23 | Caster (Hywirl summon gust)                              | Q Tribal                       |
| Dust Hywirl                    | 20–22 | Swarm (whirl contact dmg)                                | Q Hywirl                       |
| Sun Cactoro                    | 22–24 | Ranged                                                   | Q Cactoro (gold recolor)       |
| **Alpaking Prime** (zone boss) | 24    | Boss: herd stampede lines, wool-quake PBAoE, enrage <30% | Q Alpaking Evolved (scale 1.7) |

### Ashcrag Canyons (24–30)

| Enemy                        | Lvl   | Archetype                                                                                                | Model                        |
| ---------------------------- | ----- | -------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Ash Goleling                 | 24–26 | Grunt (stagger-resist)                                                                                   | Q Goleling                   |
| Crag Goleling                | 26–28 | Elite Grunt (slam AoE)                                                                                   | Q Goleling Evolved           |
| Canyon Demon                 | 25–27 | Grunt (fire trail dash)                                                                                  | Q Demon                      |
| Void-Touched Demon           | 27–29 | Caster (fire rain AoE)                                                                                   | Q Blue Demon                 |
| Yeti                         | 26–28 | Charger (boulder toss ranged mix)                                                                        | Q Yeti (both variants)       |
| Rift Squidle                 | 25–27 | Caster (toxic pool)                                                                                      | Q Squidle                    |
| Skull Swarm                  | 27–29 | Swarm                                                                                                    | Q Ghost Skull (ember tint)   |
| Orc Warlord Guard            | 28–30 | Elite                                                                                                    | Q Orc + KA gear bits         |
| Ashcrag Dragon (rare roamer) | 28    | Elite Charger (dive strafe)                                                                              | Q Dragon                     |
| **Ashwing** (world boss)     | 30    | Boss: fire breath cone, wing-gust ring, dive rect, ember rain w/ safe wedges, 50% phase: airborne volley | Q Dragon Evolved (scale 2.0) |

### Elder Grove (30 elite pocket)

Elder Sporeling (elite Mushnub, glow), Grove Sentinel (elite Goleling, moss), **Elder Treant**
(boss: root walls, sap AoE, summon sporelings) — Q Goleling Evolved (giant, foliage dressing).

Ambient (non-combat): Bunny, Cat, Chicken, Pigeon, Birb, Fish schools, Alpaking calves near herds.

## 5. Enemy Stats (base at-level, before rank multipliers)

```
HP     = 40 + 22×L^1.28          dmg per swing = (3 + 2.1×L) × archetypeMod
Armor  = 8×L (Grunt/Elite) | 4×L (others)      magicResist = 10% base (Caster 20%)
XP/gold per PROGRESSION.md / ITEMS_LOOT.md
archetypeMod: Grunt 1.0 · Ranged 0.8 · Caster 1.1 · Charger 1.2 · Swarm 0.45 · per-ability coefs on top
```

Every value is a column in the Enemy Editor with these formulas as "suggest" buttons — designers
tweak per type, the curve keeps them honest.

## 6. Friendly NPCs

- **Types:** Vendor, Quest Giver, Trainer (flavor lore + respec pointer), Villager (ambient),
  Hermit (Elder Grove). Data: id, name, title, model (KA Adventurer variants + Q Base Characters w/
  outfits), position/waypoints, dialogue set, vendor/quest bindings, routine (waypoint idles with
  UAL clips: `Counter_*` shopkeeping, `Sitting_*`, `Farm_*`, `Fixing_Kneeling` smith, `Drink`
  tavern).
- Invulnerable, non-blocking (soft collision); enemies ignore them (no NPC-death states in 0.1.0).
- Nameplates: name + role glyph at 12 m; quest `!/?` glyphs at 25 m + through-wall tint at 8 m.
- Population: Dawnhaven ~14 NPCs, villages ~6, camps ~4 — enough motion to feel inhabited (P3).
