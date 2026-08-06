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

**As built (P9-D) — how each tell reaches the screen.** The archetype language above is only worth
anything if a player can read it mid-fight, so each row has a concrete presentation:

- **Caster** — an ability with `cast: true` draws a draining bar over the nameplate for its whole
  wind-up (schema-enforced ≥ 800 ms, so the window is always reactable). Landing a stun shatters
  the bar red with a ring and an impact hit; the bar holds broken for half a second, because the
  interrupt is the payoff for reading it. Its `self_shield` shows as an absorb bubble plus a chip
  with the pool remaining, and hits the shield eats read as absorbed rather than as damage that
  did nothing.
- **Charger** — the rect decal it draws is the exact lane the per-tick sweep will test, and the
  overshoot stagger it ends in is the punish window (never 0 by schema).
- **Elite / Boss** — the "named plate" is a **drawn** mark beside the name (a diamond for elite,
  a star per boss tier) plus a per-rank tint; drawn as canvas paths, not characters, so a machine
  without the glyph cannot silently erase an elite's only warning.
- **Boss** — a top-of-screen frame on aggro (not on proximity): name, level, HP, and **a tick mark
  for every declared phase threshold**, so the next beat is visible before it lands. Crossing one
  flashes the frame and prints the phase's `announce` line, which is read from the published enemy
  row on the client — the panel can rewrite a boss's shout with no protocol change. The frame
  releases on death, on leash, and when the player leaves the arena.
- Every enemy wind-up also has a **sound** scaled by distance (swings whoosh, casts and pools hum),
  so a telegraph behind the camera still reaches the player.

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
| Bandit Forager                  | 4–6 | Ranged (thrown)      | Q Orc[^forager]             |
| Spore Lobber (P5 test camp)     | 3–5 | Ranged (spore bolt)  | Q Mushnub (until KA bandit) |
| **Mossback** (mini-boss, quest) | 6   | Elite Grunt          | Q Glub Evolved (scale 1.6)  |

[^forager]:
    **As built (P9-C, owner decision 2026-08-05 — USER_QUESTIONS Q22):** the KayKit Adventurers
    peasant this row originally called for is not in `assets/`, and the closest human-looking
    stand-in in the packs we do have (`Tribal.glb`) is rigged in the flyer family with no `Idle`
    or `Walk` clip, so it would have T-posed on the ground. Shipped as Quaternius `Orc.glb` — a
    camp of orcish foragers reads fine on the Dawnshore. Swapping to a human bandit later is one
    `modelRef` in the Enemies editor plus the pack on disk; no code.

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

| Enemy                           | Lvl   | Archetype                                              | Model                                      |
| ------------------------------- | ----- | ------------------------------------------------------ | ------------------------------------------ |
| Skeleton Minion                 | 12–14 | Swarm                                                  | KS Skeleton_Minion                         |
| Skeleton Rogue                  | 13–15 | Charger (lunge, backstab bonus) — was Grunt, see §4.1  | KS Skeleton_Rogue                          |
| Skeleton Mage                   | 14–16 | Caster (bone bolt, bone-wall self-shield)              | KS Skeleton_Mage                           |
| Skeleton Warrior                | 15–17 | Charger (shield bash; frontal 50% mitigation — flank!) | KS Skeleton_Warrior                        |
| Ember Cactoro                   | 13–15 | Ranged (needle spray cone)                             | Q Cactoro                                  |
| Feral Monkroose                 | 14–16 | Charger                                                | Q Monkroose                                |
| Grave Wisp                      | 15–17 | Caster (haunt DoT)                                     | Q Ghost Skull                              |
| Ashen Marauder                  | 16–18 | Grunt (melee) — the zone's swing, see §4.1             | Q Ninja (hooded bandit, ember tint)        |
| **Bonelord Varkas** (zone boss) | 18    | Boss: blade waves, summon minions, safe-wedge scream   | KS Skeleton_Warrior (scale 1.5, dark tint) |

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

### 4.1 As built — what the models can actually do (P12-C, 2026-08-06)

40 enemy models are baked, covering every row above. Two findings changed the design.

**The four KayKit skeletons animated nothing, and now they do.** They baked with zero clips,
because the pack ships meshes and animations in SEPARATE files — the clips live in
`Animations/gltf/Rig_Medium/{General,MovementBasic}.glb`, the same split our own player rigs use.
The enemy pipeline bakes one model per file and the enemy renderer expects the clips to be inside
it, so a skeleton stood frozen and slid. The pipeline gained a `mergeClips` rule option
(ASSET_PIPELINE.md §2.1) that stitches a shared rig's clips into a character by NAME — the two
documents carry the same 23 joints, so every channel rebinds onto the mesh's own skeleton. Each
skeleton now carries `Idle_A/B`, `Walking_A`, `Running_A`, `Hit_A`, `Death_A`, `Interact`, `Throw`.

Found by `pnpm assets:clips`, which regenerates `ENEMY_MODEL_CLIPS` from the bakes — until P12-C
that regeneration was a comment in the file rather than a command, and the empty list had been
sitting in shared since P9-C baked `Skeleton_Minion` with nobody noticing.

**There is still no melee swing, and that is a design constraint, not a gap to paper over.**
KayKit keeps the combat set in a paid `Rig_Medium_Combat` file the FREE pack does not include, and
the Quaternius rigs name their bones differently, hang them off a different hierarchy and rest them
in a different pose — retargeting is a different job from rebinding, and the merge REFUSES a
foreign rig rather than dropping the channels it cannot match. So the Emberwood skeletons are the
three archetypes this rig can play honestly:

- **Swarm** (Minion) — contact damage, no swing to miss.
- **Charger** (Rogue, Warrior) — the lunge IS the attack; `Running_A` is the whole animation, which
  is already how P9's chargers read. The Rogue keeps its backstab bonus and the Warrior its 50 %
  frontal mitigation; flanking is still the answer to both.
- **Caster** (Mage, and Varkas's blade waves / summon / scream) — casters gesture, and `Interact`
  is a real forward reach. `Throw` covers a thrown bone shard.

The zone's melee grunt is the **Ashen Marauder** on Q Ninja, which owns a real `Bite_Front` strike.
That replaces the designed Bandit Ranger (KA Ranger + bow_A): the Adventurers pack has the same
split AND the same missing combat set, so a bow-drawing bandit is not available either.

**Enemies carry a `tint` now** (`#rrggbb`, content, nullable). §4 asks for a gold Sun Cactoro, an
ember Skull Swarm and a dark Bonelord Varkas, and scale alone does not carry that — Varkas wears
the same mesh as four of the minions standing around him, and a boss nobody can pick out of its
own guard is not a boss. It multiplies into the base colour on the client, so it survives the hit
flash.

**Four things the shipped systems cannot do, recorded rather than faked:**

1. **No summon.** The ability schema has no summon kind, so the Mushroom King's "minion call" and
   Varkas's "summon minions" are both a guard camp standing with the boss instead. It reads
   correctly and it is not the same beat.
2. **Ambient fauna do not flee.** §2 promises passive fauna that run; there is no passive-flee AI
   state, so the bunnies, chickens and shore birds ship as the `dummy` archetype — never aggro, pay
   no XP, drop nothing, killable. The alternative was a 2 m aggro radius, which makes a chicken
   attack people.
3. **The Elder Treant's "root walls" are a ring you leave**, not geometry. The walkgrid is baked
   and nothing writes to it at runtime (Q30).
4. **The Skeleton Warrior's 50 % frontal mitigation is not a stat**, because the schema has no
   directional mitigation field. Its charger kit is what makes flanking the answer.

### 4.2 As placed — the camps (P12-C, 2026-08-06)

**124 camps, 400 enemies**, and every P4–P9 camp moved: they stood on the dev island, which the
Dawnlands put under open water.

A camp is authored as a WISH — zone, bearing from that isle's heart, distance — and resolved
against the real height field by the panel's `placeAll`, which spirals outward until it finds
ground above water, under 22° (14° for a boss arena), inside the right zone, clear of every town
and clear of the other camps. **The spiral is capped at 120 m on purpose**: an unbounded search
always succeeds and quietly moves a camp a third of an isle away, which turns an authored
difficulty gradient into scatter and looks like it worked.

| Zone          | Camps | Enemies | Band  |
| ------------- | ----- | ------- | ----- |
| Dawnshore     | 24    | 82      | 1–6   |
| Verdant Weald | 24    | 77      | 6–12  |
| Emberwood     | 24    | 80      | 12–18 |
| Sungraze      | 24    | 85      | 18–24 |
| Ashcrag       | 22    | 64      | 24–30 |
| Elder Grove   | 6     | 12      | 30    |

Measured from the GAME, not the publish button: `/ops/camps` reports **124 spawners, 400 enemies
wanted, 400 alive, 0 unresolved refs, 0 camps that produced nothing**, with a per-zone breakdown
identical to the panel's offline placement. Tick p95 **1.67 ms** of the 25 ms budget with all 400
seeded and no players; RSS 186 MB of 700. §2's "≤150 active-combat enemies (spawn director caps)"
is about enemies IN COMBAT, and no director is built — 400 idle is affordable and the number to
watch is a loaded one, which is P12-G's job.

The six Elder Grove camps validate with **"in an unreachable pocket"**, which is correct: WORLD.md
§3.6 makes the grove a long swim or the one-way Ashcrag portal, so the walkgrid flood fill from
the spawn point cannot reach it by design.

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
