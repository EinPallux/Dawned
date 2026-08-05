# Dawned — Items, Inventory, Loot & Economy

> Item taxonomy, equipment, rarities, loot generation, gold and vendors for 0.1.0. Item content is
> data (Dawned-Admin → Item Editor); this doc fixes the _system_ and initial value curves.
> Icons: every item gets a unique icon — pipeline in [../tech/ASSET_PIPELINE.md](../tech/ASSET_PIPELINE.md) §Icons.

## 1. Item Taxonomy

| Category   | Examples                                | Stack  | Notes                                                                                     |
| ---------- | --------------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| Weapon     | sword, staff, dagger pair, hammer       | 1      | Class-locked; **visible on character** (hand/back sockets, real models from weapon packs) |
| Offhand    | shields (Warrior/Cleric)                | 1      | Visible; Mage staves are 2H (block offhand), Rogue dagger pairs are one item              |
| Armor      | head/chest/legs/boots/gloves            | 1      | Stats only — **no visual change** (outfit chosen at creation stays)                       |
| Jewelry    | ring ×2, amulet, trinket                | 1      | Pure stat sticks + (Epic+) minor effects                                                  |
| Consumable | HP/Mana potions, food, elixirs          | 20     | E quick-slot; potions share 15 s cooldown                                                 |
| Material   | logs, ore, herbs, fish, hides, essences | 50     | Gathering output; sinks arrive with crafting (0.2) — sellable meanwhile                   |
| Quest item | letters, relics, heads…                 | varies | Zero sell value, auto-removed on completion, can't drop                                   |
| Junk       | cracked shells, torn cloth              | 50     | Exists to make vendoring feel good (flavor names + good sell value)                       |
| Currency   | **Gold**                                | ∞      | Single currency 0.1.0, held per character                                                 |

## 2. Equipment Slots & Stat Budgets

11 slots: MainHand, OffHand, Head, Chest, Legs, Boots, Gloves, Ring1, Ring2, Amulet, Trinket.

**Item level (ilvl)** ≈ intended character level. Budget formula (validated by Item Editor,
overridable per item):

```
statBudget = slotWeight × (4 + 1.1 × ilvl) × rarityMult
slotWeight: Chest/MainHand 1.0 · Legs 0.85 · Head 0.7 · Boots/Gloves 0.6 · OffHand 0.6
            Amulet 0.55 · Ring 0.4 · Trinket 0.5
rarityMult: Common 1.0 · Uncommon 1.15 · Rare 1.35 · Epic 1.6 · Legendary 1.9
```

Budget buys attribute points (1.0 ea), armor points (armor slots get base armor free by
`armorClass × slotWeight × ilvl` — Heavy 6 / Medium-heavy 5 / Medium 4 / Light 3 per ilvl·weight),
weapon damage (weapons: `weaponDmg avg = 3 + 1.6×ilvl`, min/max = ±12%).

| Rarity    | Color            | Stats rolled                                                         | Drop feel                                                                     |
| --------- | ---------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Common    | White `#E8E4D8`  | 1 attribute                                                          | trash-tier fill                                                               |
| Uncommon  | Green `#3FBF5A`  | 2 attributes                                                         | regular reward                                                                |
| Rare      | Blue `#3E8FE8`   | 3 attributes                                                         | camp elites, chests, quest chains                                             |
| Epic      | Purple `#A44FE0` | 3 attributes + 1 minor effect (e.g. "+3% sprint speed", "heals +4%") | zone bosses, rare spawns, hidden caches                                       |
| Legendary | Orange `#F08A24` | handcrafted uniques with a named effect                              | 6 handcrafted in 0.1.0 (one per zone + Elder Grove), very rare targeted drops |

Attributes on gear roll from per-item templates (Item Editor defines allowed pools per class-tag —
no INT swords). Class lock on weapons/offhands only; armor/jewelry usable by all (stats self-select).

## 3. Inventory & Loot UX

- Grid inventory **48 slots** fixed (0.1.0), drag/drop, shift-split, sort button, search filter,
  junk-highlight. Equipment paper-doll around the character (rotatable 3D preview using the real
  rig + outfit + weapons).
- Tooltips: name (rarity color), slot/type, ilvl, damage/armor, attributes, effect text, flavor
  line, sell value, compare-on-hover vs equipped (delta arrows).
- **Loot flow:** kills drop a **loot bag** at the corpse (60 s lifetime, beam colored by best
  rarity). `F` opens loot panel; Shift+F loots all. Loot is **per-player instanced** (each tagger
  gets their own roll — friends never fight over drops). Gold auto-picks with a coin burst + counter
  tick. Materials from gathering go straight to bag with a toast stack.
- Overflow: full inventory → loot stays in bag (bag persists 5 min then mails-to-nothing: it just
  stays until zone cleanup; no mail system) + red bag pulse warning.

## 4. Loot Tables (data model)

```
loot_tables:  id, name
loot_entries: tableId, ref(item|table|gold), weight, minQty, maxQty,
              conditions? (minKillerLevel, questActive, firstKillOnly)
```

- Tables nest (enemy → "T3 humanoid" → "T3 generic gear") for reuse; Item Editor previews 1,000
  simulated rolls.
- Enemy binding: each enemy type gets `gold: min–max`, `rolls: n` (usually 1–2), tableId; elites +1
  roll; bosses use dedicated tables with guaranteed rarity floor.
- Gathering nodes and chests use the same table system (see PROFESSIONS.md / WORLD.md).
- Initial curve targets: at-level trash → Uncommon every ~8–12 kills, Rare every ~40–60; elite →
  Rare ~1 in 6; zone boss → guaranteed Rare+, Epic ~1 in 5, its Legendary ~1 in 25 (pity: +2%
  per boss kill without one, resets on drop — stored per character).

## 5. Gold & Economy (single-player-economy per character; no trading in 0.1.0)

| Faucets (defaults)                              | Sinks                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| Kills: `~1.2 × mobLevel` avg                    | Vendor gear (fills slot gaps between drops)                               |
| Quests: 15–80 × level                           | Consumables (potions/food)                                                |
| Junk & surplus vendoring (25% of item value)    | Fast travel between shrines (`2 × distance-in-chunks`, ~5–40 g) [^travel] |
| Chests & caches                                 | Respec (25×level / 50×level)                                              |
| Rare "treasure" junk items (high value, flavor) | Post-0.1: crafting, cosmetics, housing…                                   |

Vendor **sell** price = 25% of item `value`; buy = 100%. `value = statBudget × 3 + base` auto-derived,
overridable. Target: a leveling player is comfortably potion-funded but must choose between "that
nice vendor blue" and respec experiments.

[^travel]:
    **As built (2026-08-05):** the travel price is `fastTravelCost` in `@dawned/shared`
    (`packages/shared/src/formulas/travel.ts`), floored at 5 g and capped at 40 g. It lives there
    because the map editor previews the whole shrine-to-shrine matrix while the owner is placing
    shrines (Dawned-Admin MAP_EDITOR.md §2.4) — a panel that quotes a price the game will not
    charge is the drift `@dawned/shared` exists to prevent. Nothing charges it yet: shrines become
    interactable with the world-objects phase.

## 6. Vendors (0.1.0 set)

| Vendor             | Where                           | Stock                                                                                |
| ------------------ | ------------------------------- | ------------------------------------------------------------------------------------ |
| General Goods      | every settlement                | HP/Mana potions (tiered to zone), food, torch (cosmetic light prop), 3 flavor curios |
| Weaponsmith        | Dawnhaven, Cinderfall, Rustpick | class weapons ilvl-banded per zone, Uncommon quality, one rotating Rare (daily seed) |
| Armorer            | Dawnhaven, Sunwatch             | armor/jewelry fill pieces, Uncommon + one Rare                                       |
| Alchemist          | Dawnhaven, Mosshollow           | better potions, elixirs (+10 min stat food), antidotes                               |
| Collector (flavor) | Dawnhaven harbor                | **buys** junk/materials at +10% (small QoL sink-reverse), sells nothing              |

Vendor UI: buy/sell tabs, buyback (last 10 sold, session-scoped), shift-click quantities.

## 7. Consumables (initial list)

| Item                                    | Tier gates     | Effect                                                                                      |
| --------------------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| Minor/Lesser/Greater/Superior HP Potion | ilvl 1/8/16/24 | Heal 30% / 35% / 40% / 45% MaxHP instantly, 15 s shared CD                                  |
| Mana Potion tiers                       | same           | Restore 35% Mana (Rage/Energy classes: 25 Stamina instead — same item slot family "tonics") |
| Traveler's Rations tiers                | —              | Food: sit-eat 3 s → +6% HP/s for 10 s OOC + "Well Fed" +N primary stat 10 min               |
| Zone elixirs (5)                        | per zone       | +N to one attribute 10 min (Alchemist specialty per settlement)                             |
| Antidote                                | —              | Cleanse poison/bleed (8 s CD) — Rogue-enemy counterplay for non-Clerics                     |

## 8. Item Identity Rules

- Every item has: unique string id (`weapon_sword_emberbrand`), display name, icon (unique,
  game-icons.net derived, rarity-framed), model ref (weapons/offhands), flavor line (worldbuilding
  budget: 1 sentence), value, and content-versioned row (see tech/DATABASE.md).
- Naming voice: concrete + evocative, no procedurals in 0.1.0 ("Mosshollow Skinning Knife", not
  "Dagger of the Bear +2"). The 6 Legendaries carry zone lore (e.g. **Emberbrand**, blade quenched
  in Cinderfall's last fire — Epic effect: basic step-3 leaves a 2 s burn).

## 9. As built (P8, 2026-08-04)

The design above shipped with these decisions worth writing down:

- **Nothing is predicted.** Item ops (`ItemOp`, the one client-authored JSON
  envelope) are requests; the answer is the next full `InventorySync`, which is
  also what snaps a refused drag back. That single rule is the anti-dupe story
  on the client — the fuzz suite covers the server side.
- **Item ids** read `item_<category>_<name>` (`item_weapon_axe_tidesplitter`),
  one level deeper than §8's sketch, so a bare id sorts by category in the
  panel and in the database.
- **Bags are per-player and instanced**: every tagged killer rolls the table
  independently, so nobody watches a bag they cannot take. 60 s, 4 m reach,
  gold auto-picked, `nothing` weighted like any other entry.
- **Vendors carry an `anchor` (x/z/radius)** and, until P12 stands real NPCs
  in real settlements, each one shows in the world as a market post — a stake,
  a banner in its trade's colour, a crate. The server owns the lease: walk out
  of the radius and it closes the panel. The client raises the `F` prompt a
  little inside the radius so the press always lands within the server's copy
  of it, and reaching for a post that is genuinely too far now answers "Too far
  away." rather than a refusal about slots.
- **The pack and the sheet are different screens** (owner call, 2026-08-04):
  `I` is the bag, `C` is the character — worn gear, the rig wearing it, and the
  stats it produces. Right-click equips from the bag and takes gear off the
  sheet; the sheet folds gear through the shared `equipmentBonus` the server
  derives with, so the numbers agree by construction.
- **Visible gear is weapons only** (§1): the roster carries `mainhandModel` /
  `offhandModel`, the client hangs the baked model off the hand bone, and
  armour never changes the silhouette. Shields ride the forearm rather than
  hanging from a grip.
  Two things a new weapon pack has to respect (learned the hard way, 2026-08-04):
  **scale** — packs are modelled at their own heroic size (the first axe arrived
  1.16 m long, the "buckler" 0.98 m, which on a 1.75 m character read as a farm
  tool and a door), so held models are rescaled to a target length for their
  KIND, derived from the manifest id the pipeline assigns (`items_weapons_axe_a`
  → axe → 0.76 m; dagger 0.42, wand 0.46, sword 0.78, hammer 0.8, staff 1.35,
  shield 0.5) and gripped a little way up the shaft, not by the very end; and
  **which bone** — character composition rebinds every outfit and hair piece
  onto the base skeleton but leaves each piece's own armature in the tree, so a
  rig carries several bones named `hand_r` and only the one inside the visible
  mesh's skeleton ever moves. Weapons are attached from that skeleton, never by
  searching the node tree (a name search picks a bind-pose duplicate, which
  reads in game as a weapon floating beside the character).
- **The first catalogue** is 62 items across T1–T2 (ilvl 1–8), 5 loot tables
  and 5 Dawnhaven vendors, authored in Dawned-Admin and published — the
  formulas in §2 generated the numbers, the panel's budget meter checks them.
