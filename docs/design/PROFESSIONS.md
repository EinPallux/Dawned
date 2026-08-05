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

## 6. Why gather in 0.1.0 (pre-crafting honesty)

- Gold: materials vendor well (Collector +10%), deliberately decent — gathering is a legitimate
  income build.
- Quests & codex: several side quests want materials; per-profession codex completion (collection UI
  checkmarks) with a cosmetic title each ("Master Angler").
- Elixir access: Alchemist trades some elixirs only-for-materials (barter rows in vendor editor —
  first taste of crafting).
- Head start: materials bank toward 0.2 crafting (communicated honestly in-game via codex blurb).
