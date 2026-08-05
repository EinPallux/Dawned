# Dawned — Quests, Dialogue & Points of Interest

> Dawned is exploration-first: quests are **side quests only**, scattered across the world as
> discoveries themselves. This doc defines the quest system, dialogue presentation, and how POIs and
> quests interlock. Authoring happens in Dawned-Admin → Quest Editor. World-side POI catalog:
> [WORLD.md](WORLD.md) §4.1; full 0.1.0 quest list: [../CONTENT_0.1.md](../CONTENT_0.1.md).

## 1. Design Rules

1. **No main quest.** Nothing ever says "go here next". Zones self-gate by enemy level.
2. **Quests are found, not funneled.** Givers sit at natural stops (settlements, roadside NPCs,
   objects: a note on a corpse, a message in a bottle, a quest board). ~30% of quests start from
   world objects, not NPCs.
3. **Short and flavorful.** 1–3 steps typical; chains max 4 quests (each zone gets one such
   "mini-saga" that tells the zone's story).
4. **Respect the sandbox.** Objectives say _what_, the map hints _roughly where_ (circle region, not
   an X), and tracking can be disabled per quest. "Explore" quests never mark anything — clue text
   only.
5. **Every reward is worth the walk:** gold + XP always; gear/consumable/recipe-teaser at chain ends;
   at least one Rare per zone chain.

## 2. Quest Data Model (authored in Quest Editor)

```
quests: id, name, zoneId, suggestedLevel, giver (npcId | objectId | boardId),
        prerequisites (level? questIds? discoveryId?), repeatable=false (0.1.0),
        steps[] (ordered), rewards { xp, gold, items[], title? }, journalText (found-voice prose)
steps:  type KILL(enemyType|tag, n) | COLLECT(itemId, n; source: drops|gather|world-prop)
      | DELIVER(itemId → npcId) | TALK(npcId) | EXPLORE(regionPolygon — untracked)
      | INTERACT(objectId, n) | USE_AT(itemId @ regionId)
      per-step: tracker text, optional map hint circle, optional on-complete dialogue/emote
```

Server owns quest state per character (`character_quests`: questId, step, counters[], state).
All counter events flow through the server event bus (kills, gathers, interacts) — client only
renders progress.

## 3. Dialogue Presentation

- Lower-third dialogue panel (portrait-free; low-poly NPCs _are_ the portrait — camera gently frames
  the speaker over-shoulder, NPC plays `Idle_Talking_Loop`/`Counter_*` gestures).
- Typewriter text (fast, skippable), 1–3 choice buttons max: `[Accept]` `[Not now]` + occasional
  flavor question (pure lore, zero branching state in 0.1.0).
- Voice: none (text only), but every NPC gets a "voice" via writing style + name + one-line description.
- Ambient barks: villagers emit proximity one-liners (text bubbles) on a cooldown — cheap life.

## 4. Quest UI

- **Journal (`L`)**: list by zone with state icons; entry shows journal prose (written in-world:
  "Marla swears the bees weren't this big last spring…"), steps with counters, rewards, abandon.
- **Tracker (HUD right)**: up to 3 pinned quests, step + counter lines, subtle progress ticks
  (counter bump animation on event). Auto-pin nearest-zone quest, player can re-pin.
- Map: giver icons (`!` styled as a dawn-ray glyph) appear only within discovered regions; hint
  circles for tracked steps; turn-in `?` glyph.
- Toasts: accept / step complete / done (with reward icons). Turn-in moment gets a small fanfare +
  NPC emote (`Yes`/`Celebration`).

### 4.1 As built (P11-D, 2026-08-05)

Shipped: the tracker (three quests, counters only on steps that COUNT — a deliver or an explore
is one act, and "0/1 Find the logging site" is noise), the journal `L` grouped by zone with the
found-voice prose and each step's progress, the lower-third dialogue with a typewriter reveal and
the per-class reward pick sent WITH the turn-in, discovery banners, quest toasts, and the world
map `M` with fog, pins per kind, dashed hint circles and the shrine network priced by
`fastTravelCost`.

Three things are worth naming because they are decisions rather than implementations:

- **The world map frames on the chunks the BAKE emitted**, not on the 2048 m world and not on the
  pins. The whole world is mostly ocean (the island was a smudge with four labels overprinting);
  the pins alone zoom past the coastline into a flat green field. The bake's own chunk list is the
  only source that answers "where is there a world" and keeps answering it when P12 raises four
  more isles.
- **Undiscovered POIs are ABSENT from the map, not greyed.** A grey pin where a secret is turns
  exploration into walking to the grey pins, which is the opposite of §1 rule 1.
- **The quest glyph over an NPC's head is server-decided.** Availability depends on gates the
  client does not evaluate, so an offer mark only appears once the server has said so — the same
  rule that keeps the client from deciding what `F` means.

Deferred, deliberately: the over-shoulder camera framing during dialogue (§3) — the panel is a
lower third and the NPC is already in frame at interact range; the `Yes`/`Celebration` turn-in
emote (§4) — the hook exists and rides the entity-event lane; and the minimap, which is P12's
work alongside the real world it would show.

## 5. POI ↔ Quest Interlock

- Each zone: 1 chain (3–4 quests) telling the zone story + 3–5 one-offs + 1 "found object" quest +
  1 profession-flavored quest (e.g. Fishing rare request).
- Chains route players past POIs deliberately (objective inside a Landmark's view, giver at a
  Vista base) — quests advertise exploration, never replace it.
- **Discovery-gated quests:** 3 quests in 0.1.0 only appear after finding their POI (e.g. the Elder
  Grove hermit's chain) — rewards for the curious, invisible otherwise.

## 6. Example Specs (authoring reference quality bar)

**"Boil Trouble" — Dawnshore one-off, lvl 3.** Giver: Marla (Dawnhaven gate farmer, worried idle).
Step 1 KILL: Bog Blobs ×8 (hint circle: Blob Bog). Step 2 COLLECT: Unpopped Boil ×3 (75% drop from
same — kill-and-collect overlap keeps it one trip). Turn-in: Marla. Rewards: 220 XP, 35 g, `Marla's
Preserves` ×3 (food). Journal voice: _"Marla's fence posts are dissolving. She'd like the bog to
stop doing that."_

**"The Loggers' Silence" — Verdant Weald chain (4), lvl 8–11.** Q1 TALK/EXPLORE: find the abandoned
logging site (clue text only). Q2 INTERACT: inspect 4 marked stumps & a shattered cart → spawns
ambush (scripted spawn hook on final interact). Q3 COLLECT: Mossbloom ×5 (herbalism cross-sell;
buyable-from-nothing prevented: nodes only) + DELIVER poultice to hurt logger NPC hiding in a
hollow trunk (hidden-ish: light search). Q4 KILL: **Mushroom King** (zone boss, soloable at 12).
Chain reward: Rare weapon choice (one per class), title "Friend of the Weald".

**"Message in a Bottle" — found-object, any level.** Fishing proc item starts quest → EXPLORE:
identify the sandbar from the note's sketch (drawn art asset) → INTERACT: dig at the right spot
(shovel prop appears) → Hidden Cache loot + 1 of 6 collectible "Castaway Log" lore pages (codex).

### 6.1 As built (P11-C, 2026-08-05)

The eight pilot quests are live content — authored in the panel's A4 editor, published, and frozen
into seed migration 0019. Between them they run every one of the seven step types, all four giver
kinds, both gate kinds, a `toast` hook and a per-class reward choice. Four deviations from the
specs above, each because the built world could not carry the spec version yet:

| Spec                                                             | As built                                                                                 | Why                                                                                                                                                                              |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Boil Trouble" step 2 COLLECT Unpopped Boil ×3                   | dropped; the quest is the KILL step alone                                                | there is no `item_material_unpopped_boil` in the published catalogue and inventing a drop for one quest is P12's content pass, not this slice's                                  |
| Q2 "…& a shattered cart → spawns ambush"                         | four marked stumps sharing the tag `Marked Stump`, then a KILL step for 3 Weald Stalkers | the ambush IS the second step rather than a `spawnGroup` hook: the stalker camp already stands at the cut, so a scripted spawn would have added a second population on top of it |
| Q3 "DELIVER poultice"                                            | delivers the Mossbloom itself to Bran                                                    | a poultice item does not exist; the herb the player just gathered is the thing they carry                                                                                        |
| Rewards name flavour items (`Marla's Preserves`)                 | the published equivalents — Traveler's Rations, Lesser Healing Potion                    | same shape, real rows; bespoke reward items are P12's catalogue work                                                                                                             |
| Every quest's `zoneId` is `dawnshore`, including the Weald chain | —                                                                                        | the journal groups by this id and only one landmass is built; the `verdant_weald` polygon is open water until P12. Four fields to re-point when it is not.                       |

"Message in a Bottle" is **not** built: it needs a drawn sketch asset and a dig interaction, both
P12/P14 work. The `item` giver kind it would use is implemented and schema-gated, so the quest is
authoring away rather than code away.

## 7. Quest Boards

Settlement boards hold 2–3 posted one-offs (fixed in 0.1.0; the _system_ supports adding rotating
repeatables post-0.1). Board interact → parchment list UI → accept without NPC — the "always
something to do from town" valve.

## 8. Scripting Hooks (kept tiny on purpose)

Steps can fire whitelisted hooks: `spawnGroup(spawnId)`, `despawn(tag)`, `playEmote(npcId, clip)`,
`toast(text)`, `grantBuff(buffId)`. No arbitrary scripting language in 0.1.0 — the hook set grows
deliberately. Every hook is usable from the Quest Editor dropdowns (no code for designers).
