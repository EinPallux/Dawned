# Dawned — Progression: Levels, Stats, XP & Unlocks

> Character growth from 1 to 30. All curves live in content tables (Dawned-Admin → XP/Stats editors);
> formulas here are the shipped defaults. Combat math consuming these stats: [COMBAT.md](COMBAT.md) §6.

## 1. Experience

### 1.1 Sources

| Source        | XP rule (defaults)                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Enemy kill    | `8 + 6 × mobLevel^1.15`, ×1.5 elites, ×4 zone bosses; level-gap falloff: −10% per level below you beyond 3 (min 10%), no bonus above (anti-grief safety, generous for friends) |
| Quest turn-in | Authored per quest; guideline 25–60% of current level-need at intended level                                                                                                   |
| Discovery     | Landmark 8%, Vista 12%, zone first-entry 15% of current level-need (percent-based, stored as basis points)                                                                     |
| Gathering     | Small character XP on gather: `4 × nodeTier` (main reward is profession XP, see PROFESSIONS.md)                                                                                |

Kill XP is **individual** (no groups in 0.1.0); tag = ≥10% damage contribution or any heal on the
tagger within the fight (Cleric-safe).

### 1.2 Level curve

`xpToNext(L) = round₁₀(90 × L^1.75)` — stored denormalized in the `content_xp_curve` table
(one published row per level, editable in the panel; the formula regenerates defaults).

| Level | XP to next | Cumulative |     | Level | XP to next | Cumulative |
| ----- | ---------- | ---------- | --- | ----- | ---------- | ---------- |
| 1     | 90         | 0          |     | 16    | 11,520     | 61,360     |
| 2     | 300        | 90         |     | 18    | 14,160     | 85,690     |
| 4     | 1,020      | 1,010      |     | 20    | 17,020     | 115,410    |
| 6     | 2,070      | 3,530      |     | 22    | 20,110     | 150,970    |
| 8     | 3,420      | 8,310      |     | 24    | 23,420     | 192,820    |
| 10    | 5,060      | 15,940     |     | 26    | 26,940     | 241,400    |
| 12    | 6,960      | 26,980     |     | 28    | 30,670     | 297,120    |
| 14    | 9,120      | 41,950     |     | 29→30 | 32,620     | 360,410    |

> Table regenerated formula-exact at P7 (the planning-era table had hand-arithmetic drift of up
> to ~2% — the formula above was always the definition; unit tests now pin these numbers).

Pacing target: mixed play (fighting + quests + discovery + gathering) reaches 30 in ~35–45 h; pure
grinding is slower but viable (sandbox promise). Early levels pop fast (first session ends ~lvl 5–6).

### 1.3 Level-up moment (juice contract)

Gold pillar VFX + `Celebration` anim option (auto-plays if idle), full heal/resource refill, chat
toast, UI burst on the XP bar, unlock toasts (new ability/slot) with click-to-open panel.

## 2. Attributes

5 attributes; base 10 each is replaced by class starting spreads (sum 50) + **3 points per level**
(87 by 30) player-allocated + gear bonuses.

| Attribute           | Grants (per point)                                   |
| ------------------- | ---------------------------------------------------- |
| **Strength (STR)**  | +1 AP (Warrior), +0.5 Armor (all)                    |
| **Agility (AGI)**   | +1 AP (Rogue), +0.04% Crit (all)                     |
| **Intellect (INT)** | +1 SP (Mage dmg; Cleric dmg & healing), +10 max Mana |
| **Vitality (VIT)**  | +12 max HP                                           |
| **Endurance (END)** | +5 max Stamina, +0.2/s stamina regen per 4 points    |

Derived (level 1 base → formula):

```
MaxHP      = 80 + 12×VIT + 6×(level−1)
MaxMana    = 100 + 10×INT                (Mana classes)
MaxStamina = 100 + 5×END + 2×(level−1)
AP         = classPrimary (STR or AGI)   SP = INT
Crit%      = 5 + 0.04×AGI                CritDmg = 150%
Armor      = gearArmor + 0.5×STR         MoveSpeed = 5.5 m/s (jog), ×1.35 sprint
```

Class starting spreads (STR/AGI/INT/VIT/END): Warrior 14/9/6/13/8 · Mage 6/9/15/11/9 ·
Rogue 8/15/6/10/11 · Cleric 9/7/14/12/8.

**Allocation UX:** points bank until spent (no forced spend); Character panel has +/− staging with
Confirm; recommended-build one-click ("Suggested: Warrior — 2 STR 1 VIT") for players who don't want
to think — sandbox respects both.

## 3. Skill Points & Trees

- 1 skill point per level starting at level 2 → **29 points** at cap.
- Trees per class: 3 branches × 8 nodes (see [CLASSES.md](CLASSES.md)); tiers unlock at skill-point
  investment thresholds 0/3/6/9/12 within that branch **or** character level 2/5/10/15/20 — whichever
  is later; capstone requires 8 points in-branch + level 25.
- Total rank capacity per tree ≈ 45 → at most ~64% of one class's tree: permanent-feeling choices,
  fixable via respec.

## 4. Ability Unlocks

Slots unlock at levels 1 / 3 / 6 / 10 / 14 / 18 / 22 / 25 (ultimate). On unlock the ability is
auto-slotted, a toast fires, and the Skills panel highlights it with a short "try it" tip. Basic
combo, dodge, sprint, RMB class action: available from level 1 — the core feel is never gated.

## 5. Profession Progression

Four gathering professions level independently 1–30 (see PROFESSIONS.md): tier gates at 7/13/19/25
align with zone resource tiers, so a fresh 30 still has reasons to revisit early zones (or a
gatherer out-levels combat zones cautiously — sandbox tension we want).

## 6. Respec & Identity

- **Mirror of Dawn** (Dawnhaven): full skill-tree refund for `25×level` gold; attribute re-allocation
  for `50×level` gold (both confirm-gated). Cheap enough to experiment, priced enough to matter.
- Character rename: GM service only (0.1.0). Class change: never — roll an alt (character slots
  exist for this).

## 7. Anti-frustration rules

- No XP loss, no de-leveling, death penalty is the 30 s "Dawned" debuff only.
- Quest/kill XP never rounds to 0; every action ticks the bar.
- Banked stat/skill points show a gentle HUD pip — never a nag modal.
- All curves admin-editable live; XP-rate world modifier (`world_settings.xpRate`, default 1.0) for
  GM events like "Dawn Festival +50% weekend".

---

### As built (P7 server core, 2026-08-04)

Protocol v9 carries the system: `ProgressSync` (the authoritative self sheet, sent on join and
after any change — it doubles as the correction for mispredicted allocation clicks), `XpGained`
(amount + source + absolute bar position) and `LevelUp` (fanned out so bystanders see the
pillar); `AllocateStats`/`AllocateSkill`/`Respec` go up and are re-validated with the SAME
shared gate helpers the client predicts with. Kill XP implements §1.1 exactly: per-enemy raw
damage ledger (`≥10%` tag), heal-assist sets recorded through the healing-threat path
(Cleric-safe), rank multipliers, per-level falloff, per-enemy `xpMult`, `xpRate` last, never 0;
training dummies pay nothing. Zone first-entry XP checks polygons once a second per player
against the baked `zones.json` and dedupes via `character_discoveries`. Level-ups run the §1.3
contract server-side (full HP/stamina/pool refill, +3/+1 banked). Persistence is write-through
per award/allocation (single-statement updates serialized per character; skills replace their
rows transactionally). Respec works from anywhere until P12 places the Mirror of Dawn in
Dawnhaven (the gold price already applies; proximity gate arrives with the interactable).
Dev tools: in-game `/setlevel <1..30> [character]` (gm/admin roles) and `POST /ops/setlevel`
(localhost + secret) — down-leveling refunds all points free (testing tool, not economy).
All 7 node-effect kinds fold live: stat scalars into derived stats/movement/resources,
per-ability rewrites via shared `applyAbilityMods` (both sides run it), conditionals/crit
riders at the damage rolls, stance/passive tweaks at their sites, and the proc runtime
(low-HP heals/auto-shields with ICDs, on-kill buffs, resource-spent stacks, thorns,
melee-attacker debuffs, self-heal speed bursts, every-Nth echo bolts, Flurry empowers,
Archmage surge, consume-bonus finishers, poison jump).
