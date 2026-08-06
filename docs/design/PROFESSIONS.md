# Dawned — Gathering Professions

> Four gathering professions — Woodcutting, Mining, Herbalism, Fishing — each leveling 1–30
> independently. They are the sandbox's second engine: reasons to move through the world that aren't
> combat, feeding the (0.2+) crafting economy and selling for gold meanwhile.
> Node placement is authored in the Admin Map Editor (spawn layer) — see Dawned-Admin/docs/MAP_EDITOR.md.

## 1. Shared System

### 1.1 Gathering flow

1. Approach node → interact prompt (`F — Chop/Mine/Pick/Fish`) with profession + tier shown.
2. Tier check: node tier locked if profession level below gate (7/13/19/25 for T2–T5) → prompt shows
   requirement instead (no fail-rolls; deterministic gates keep it kind).
3. Hold-to-gather: 3.0 s channel (interrupted by damage/movement; −25% time at profession level ≥
   tier-gate+4). Character plays the profession animation with an auto-shown tool prop (no tool
   items required in 0.1.0; tools become craftable boosters in 0.2).
4. Yield: materials to inventory (toast), profession XP, small character XP, node **depletes**
   (visual: tree falls with physics-lite topple + stump, rock crumbles, herb picked bare, fish spot
   ripples out) → respawns server-side after 90–180 s (per node, editable).
5. Rare procs (see tables): bonus material, gems, or a "curiosity" vendor treasure. Proc chance
   `3% + 0.2% × profLevel`.

### 1.2 Animations & props (real assets)

| Profession  | Channel anim (UAL)                                                        | Tool prop shown                               |
| ----------- | ------------------------------------------------------------------------- | --------------------------------------------- |
| Woodcutting | `TreeChopping_Loop`                                                       | KayKit RPG Tools `axe`                        |
| Mining      | `TreeChopping_Loop` retargeted at rock height + `Fixing_Kneeling` accents | RPG Tools `pickaxe`                           |
| Herbalism   | `PickUp_Kneeling` loop cut                                                | none (hand-pick)                              |
| Fishing     | `OverhandThrow` (cast) → idle hold → reel loop                            | Quaternius `Fishing Rod` (5 variants by tier) |

### 1.3 Profession XP & levels

`profXpToNext(L) = round₁₀(60 × L^1.6)`; gather XP = `12 × nodeTier` (×0.5 when node tier is below
your current gate tier — soft push toward frontier nodes). Level 30 in one profession ≈ focused
casual week. Professions panel (`J`): level bars, tier gates, discovered-material codex per
profession (collection-completion itch).

### 1.4 Node distribution rules (world building contract)

- Every zone carries its tier's nodes of **all four** professions (fishing via coasts/rivers/ponds).
- Cluster placement: 3–6 nodes per cluster, clusters near landmarks/POIs (gathering tours double as
  sightseeing); ~15% of nodes in risky spots (inside camps, cliff ledges) with +1 proc bonus roll.
- Density target per zone: ~25 tree, ~20 ore, ~20 herb, ~8 fish spots (counts in CONTENT_0.1.md).

### 1.5 As built (P10-A) — a node's definition and its placements are separate rows

The obvious shape is one row per tree. The shipped shape is the one enemies already use: a
**definition** (`content_resource_nodes`) says what a birch IS — profession, tier, what it
yields, what it can proc, how long the hold is, how long until it regrows, which model stands
and which stump replaces it — and a **placement** in the map bake says where one is. Two
hundred birches share one definition, so retuning birchwood is one row in the panel rather
than two hundred, and a placement stays small enough that a forest costs the bake almost
nothing.

The gates are DETERMINISTIC end to end: nothing in `rollGather` can fail to produce the
ordinary yield. §1.1's "no fail-rolls" is a rule the code cannot break rather than a number
someone chose. The only randomness is which yield entry, how many, and whether the proc lands
— and all three arrive as explicit rolls the caller supplies, so the panel's gathering preview
and the live drop run the same function rather than two similar ones.

### 1.6 As built (P10-E) — what is authored, and what is planted

The **definitions** are complete: 21 resource nodes covering all five tiers of all four
professions plus Dawnpetal, and 42 material/gem/proc/fish items, authored through the panel's
Professions editor and frozen into migration 0017. Every node has its own model — one tree per
tier, one flower per tier, a fish you can see under the surface per water, and five ore rocks
whose atlas is tinted per ore, because the rock pack ships one grey boulder and five identical
grey boulders would make mining tierless.

The **placements** are T1–T2 only: 65 nodes across Dawnshore and the Verdant Weald, which are
the zones that exist. T3–T5 nodes stand nowhere until P12 sculpts Emberwood, Sungraze and
Ashcrag. Authoring coordinates for ground nobody has made would be content written to be
deleted.

Two things the shipped rows say that this document did not:

- **Stone is a yield, not a proc.** §3 lists a "stone side-yield every gather"; it is a second
  weighted entry on every vein rather than a proc, because a proc is a surprise and stone is
  simply what mining mostly gives you.
- **Dawnpetal was re-tiered.** P8 shipped it as an ilvl-4 Dawnshore loot material, before this
  ladder existed. §4 makes it the Elder Grove's T5 rare, so the item was re-authored at ilvl 27
  and the Dawnshore spore table now drops Meadowbell instead — the herb that shore actually
  grows. Found by a test asserting that every node yields something from its own tier band, not
  by reading the rows.

### 1.6b As built (P12-E) — the ladder is planted

§1.6's "T1–T2 only, 65 nodes" is closed: **362 placements across all six zones**, every one of
the 21 definitions with a home and none without. 120 trees, 95 ore seams, 107 herb patches and
40 fishing spots — the counts §1.4 asks for, give or take the herbs, which came out 107 rather
than 95 because the herb clusters are the smallest and the world gained a sixth zone.

Per zone: Dawnshore, the Verdant Weald, the Emberwood, Sungraze and Ashcrag hold **70 each**
(24 trees, 19 ore, 19 herbs, 8 fishing) and the Elder Grove holds **12** — its Dawnpetal and
nothing else, because §4 makes the Grove a place you walk to for one thing.

**All five fishing bands have water.** §5.3 measured every bar the placed waters could show and
reported that epic and legendary had definitions and nowhere to play them; the ember run, the
dune water and the deep sea exist now, so the reel ladder is complete content rather than a
gap the run had to name.

Two things this cost, both worth keeping:

- **A cluster is a wish, not a coordinate.** Zone, bearing from the isle's heart, distance —
  resolved against the real height field, with a per-member ground check and a retry that
  shrinks toward the centre. A fishing cluster next to a shoreline loses half its spots without
  that retry (measured: 3 of 8 → 8 of 8).
- **A zone constraint has to reach the members, not just the centre.** 39 of 322 land nodes
  stood in a region they were never authored for, because only the cluster centre was ever
  asked. Tier bands are the whole point of §4's zone assignment — a T5 vein in the T4 savanna
  is reachable by someone the ladder is supposed to gate — and 4 of the 12 Dawnpetal were
  growing outside the Grove, which is §1.6's re-tiering undone by geometry rather than by data.
  The publish rail now warns when one node id's placements split across zones.

### 1.7 As built (P10-G) — what 1→10 actually costs

§1.3 says "level 30 in one profession ≈ focused casual week" and never says what the first ten
levels cost. Measured on the live server by `tools/smoke/browser-p10.mjs`, which grinds a real
character with real `GatherOp`s rather than granting XP:

| milestone | gathers | closed form                      | note                                              |
| --------- | ------- | -------------------------------- | ------------------------------------------------- |
| level 2   | 4       |                                  |                                                   |
| level 5   | 94      |                                  |                                                   |
| level 7   | 248     | 2980 xp ÷ 12 = 248.3             | the T2 gate opens — the run moves to the wealdoak |
| level 10  | 458     | + 5040 xp ÷ 24 = 210 → **458.3** | 210 of them T2                                    |

**The live server reproduces §1.3's curve to the gather.** Summing `profXpToNext` over levels
1–6 and dividing by a T1 node's 12 xp predicts the gate at gather 248; levels 7–9 over a T2
node's 24 xp predicts 210 more. The run measured 248 and 210. Nothing about that was asserted
in advance — the grind counts gathers and the formula was checked against it afterwards — so it
is evidence that the XP pipeline, the tier gates and the ×0.5 halving all fold the way the
design says rather than merely running without error.

**The T2 gate falls almost exactly at the halfway mark**, which is the shape the halving is for:
the second half is only worth grinding on the higher tier, and the ladder opens it right when
you can reach it.

The run's 1290 s is NOT a play-time estimate. It holds a `/ops/respawnnodes` lever open so a
node is always ready, which deletes the thing that actually paces gathering: a tree is a 90–180 s
regrow, so a real session is a walk between clusters, not a stand at one trunk. The number worth
keeping is the gather COUNT; wall-clock is the owner's feel pass.

Only woodcutting was walked end to end. Mining, herbalism and fishing run the identical
`rollGather` path over content of the same shape, so the machinery is proven once rather than
four times — the same argument as testing one class's resource lane. Whether each one _feels_
good is a playtest judgement, deferred with all other tuning.

## 2. Woodcutting

| Tier (gate)                                                                                        | Wood            | Zone             | Node models (assets)                       |
| -------------------------------------------------------------------------------------------------- | --------------- | ---------------- | ------------------------------------------ |
| T1 (1)                                                                                             | Birchwood Logs  | Dawnshore        | KayKit Forest birch/common trees           |
| T2 (7)                                                                                             | Wealdoak Logs   | Verdant Weald    | big oaks, mossy variants (Nature packs)    |
| T3 (13)                                                                                            | Emberbark Logs  | Emberwood        | red-canopy maples, Halloween gnarled trees |
| T4 (19)                                                                                            | Sungraze Acacia | Sungraze Savanna | flat-top acacia recolors                   |
| T5 (25)                                                                                            | Ashwood Logs    | Ashcrag Canyons  | dead/petrified trees (Desert assets)       |
| Procs: Resin (T1–3), Golden Sap (T4–5), rare **Heartwood** (any tier ≥2, future crafting jackpot). |

## 3. Mining

| Tier                                                                                                 | Ore            | Zone            | Node models                                                         |
| ---------------------------------------------------------------------------------------------------- | -------------- | --------------- | ------------------------------------------------------------------- |
| T1 (1)                                                                                               | Copper Ore     | Dawnshore       | rock + copper veins (ResourceBits copper nuggets on Low Poly Rocks) |
| T2 (7)                                                                                               | Iron Ore       | Verdant Weald   | iron-flecked boulders                                               |
| T3 (13)                                                                                              | Silverline Ore | Emberwood ruins | silver recolor veins                                                |
| T4 (19)                                                                                              | Gold Ore       | Sungraze ravine | gold veins (ResourceBits gold)                                      |
| T5 (25)                                                                                              | Dawnstone      | Ashcrag mines   | glowing amber crystal rock (Gems & Ores pack)                       |
| Procs: rough gems (Gems & Ores pack models/icons: 6 gem types), rare **Geode** (opens via interact → |
| mini loot table). Stone side-yield every gather (future building material, vendors buy).             |

## 4. Herbalism

| Tier                                                                                          | Herb          | Zone             | Visual                                       |
| --------------------------------------------------------------------------------------------- | ------------- | ---------------- | -------------------------------------------- |
| T1 (1)                                                                                        | Meadowbell    | Dawnshore        | blue bell cluster (nature-pack flowers)      |
| T2 (7)                                                                                        | Mossbloom     | Verdant Weald    | glowing moss tuft                            |
| T3 (13)                                                                                       | Cinderleaf    | Emberwood        | red spiral fern                              |
| T4 (19)                                                                                       | Sunblossom    | Sungraze         | tall gold flower                             |
| T5 (25)                                                                                       | Duskthorn     | Ashcrag          | purple thorn bush                            |
| T5-rare                                                                                       | **Dawnpetal** | Elder Grove only | luminous white flower, long respawn (10 min) |
| Procs: Seeds (future gardening hook), Pollen Cloud curiosity (harmless bee swarm FX + Armabee |
| aggro nearby — tiny emergent danger). Herbs feed Alchemist vendor lore + 0.2 alchemy.         |

## 5. Fishing (the involved one)

**Waters carry fish tables** (per zone waterbody, painted in the map editor): coast, river, pond,
deep-sea (sandbars).

Minigame: cast (`OverhandThrow`, aim reticle onto water, distance = hold strength) → bobber idles
2–6 s → **bite** ("!" + sharp sound + bobber plunge) → press `F` within 0.8 s to hook → **reel bar**:
a fish icon drifts within a bar, hold/release `F` to keep the catch marker over it ~6 s to fill
progress; marker slips = progress drains; empty = escape. Higher-tier & rare fish drift faster with
smaller markers. Success → catch splash + hold-up-the-fish beat (`PickUp_Table` retimed) + toast.

| Tier                                                                                            | Signature fish (per water)  | Rares                                                 |
| ----------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------- |
| T1                                                                                              | Dawn Sprat, Tidenibbler     | Sunscale (T1 rare)                                    |
| T2                                                                                              | Mossgill Perch, Weald Trout | Ghostfin (night-flag waters)                          |
| T3                                                                                              | Emberkoi, Ashback Carp      | Cinder Eel                                            |
| T4                                                                                              | Goldjaw Bass, Steppe Pike   | Duneswimmer                                           |
| T5                                                                                              | Crag Fang, Deepsea Drum     | **The Old One** (deep-sea, trophy item + title toast) |
| Fish models: Quaternius Animated Fish Bundle (world ambience + catch hold-up); items get icons. |
| Procs: Sunken Cache (mini loot table: gold, rings, messages in bottles → tiny treasure-map      |
| curiosities pointing at Hidden Caches).                                                         |

### 5.1 As built (P10-C) — a fishing SPOT is a resource node

§5 says "waters carry fish tables, painted in the map editor". Shipped: a fishing
spot is a resource node whose profession is `fishing`, and the node's yields ARE its
fish table. That buys the whole of the rest of gathering for free — tier gates, XP,
respawn, the codex, the first-tap claim — instead of a second, parallel system that
would need its own version of each. Coast, river, pond and deep-sea variety comes from
authoring different node definitions and placing them on the right water, which is the
same expressiveness with tools that already exist; a waterbody-tagging brush is A-phase
work the editor does not have.

**Not shipped, deliberately:** the cast's aim reticle and hold-strength distance. The
minigame §5 describes is bite + reel, and that is built; the cast is its entry, and
"walk to the ripple and hold" keeps one interaction framework rather than two. Aiming
is polish worth adding later, not a mechanic that is missing.

The reel's numbers were set by MEASUREMENT, not taste. The first physics pass left the
marker lagging so far behind the fish that the crudest possible strategy — hold whenever
the marker is under the fish — could not land a T1 common in eighteen seconds at any
seed. That is not difficulty, it is a broken minigame, and §5 wants the first fish a
player ever hooks to be caught.

### 5.2 As built (P10-F) — the measurement that was missing

The second pass over-corrected, and only a run against a LIVE server found it. Every
test above plays the bar with the decision and the step at the same instant; no player
ever does. A press goes up, the server applies it on its next tick, and the bar the eye
is steering is always a tick ahead of the bar being scored. Same crude strategy, twenty
seeds, a T1 common:

| command delay | landed | what that is                     |
| ------------- | ------ | -------------------------------- |
| 0 ticks       | 20/20  | all the offline test ever proved |
| 1 tick        | 0/20   | what the game actually does      |

The cause was the marker's TOP SPEED, not its accelerations: one delayed tick at 1.5/s
carried it 0.075 — half a T1 catch zone — so the correction always arrived after the
overshoot and the loop rang instead of settling. `MARKER_MAX_SPEED` is 0.9/s now, and
the tests that pin "beatable" include a tick of delay, because the zero-latency version
of that claim is not about this game. A T3 rare needs real anticipation to land; a T5
legendary refuses every simple strategy tried, which may be right and is flagged as
USER_QUESTIONS Q27 rather than guessed at.

Proven end to end by `tools/smoke/fishing-probe.mjs`, which plays the real protocol at
the tick rate. It is headless on purpose: the browser probe renders at ~4 fps in a
container and steps the reel once a frame, so it could only ever measure the container.
Feel remains the owner's end-of-project pass.

### 5.3 As built (P10-G) — every bar the world can present, played on purpose

The DoD asks for the minigame "tuned across 3 rarities". Fishing until a rare turns up
does not measure that: a rare is one weight in ten, so a handful of casts usually never
opens the bar in question, and a run that fails on the roll has found nothing. `/ops/fish`
puts a named fish on the line, and the probe walks the ladder deliberately — one
representative fish per rarity each placed water stocks, then plays it for real.

| water       | tier | rarity | drift | half-width | landed on |
| ----------- | ---- | ------ | ----- | ---------- | --------- |
| Shore Shoal | T1   | common | 0.180 | 0.160      | cast 1    |
| Weald Pool  | T2   | common | 0.195 | 0.149      | cast 2    |
| Shore Shoal | T1   | rare   | 0.210 | 0.139      | cast 1    |
| Weald Pool  | T2   | rare   | 0.225 | 0.129      | cast 1    |

Four bands, four DISTINCT bars, all winnable through a real server. The rungs matter more
than the labels: `fishingDifficulty` folds tier and rarity into one step, so a T1 rare and
a T2 common are different bars despite sharing neither word — and the four measured pairs
are a clean monotone ladder rather than two settings with a name each.

**Only two of the five rarities are reachable, and that is content, not tuning.** Epic and
legendary fish live on the T3–T5 waters, which have definitions and deliberately no
placements until P12 sculpts their zones (§1.6). The probe says so rather than implying
three; the harder rungs stay pinned by the shared delayed-command tests, and how hard a
legendary should FEEL is Q27, answered "leave it as shipped and judge it in the playtest".

One thing the run found on the way, which had nothing to do with difficulty: a caught fish
depletes the spot, and a spot regrows on the same 90–180 s timer as everything else. The
probe's second cast of a band was therefore refused and then sat out its whole deadline,
which printed as a lost bar. It respawns nodes between casts now, and — more importantly —
it LISTENS to refusals instead of watching only the fishing state, so a refused cast says
why immediately rather than costing 70 s of silence. The first run to reach the weald pool
spent six minutes being told "your profession level is too low" without hearing it.

## 6. Why gather in 0.1.0 (pre-crafting honesty)

- Gold: materials vendor well (Collector +10%), deliberately decent — gathering is a legitimate
  income build.
- Quests & codex: several side quests want materials; per-profession codex completion (collection UI
  checkmarks) with a cosmetic title each ("Master Angler").
- Elixir access: Alchemist trades some elixirs only-for-materials (barter rows in vendor editor —
  first taste of crafting).
- Head start: materials bank toward 0.2 crafting (communicated honestly in-game via codex blurb).
