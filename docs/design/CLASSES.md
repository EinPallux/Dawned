# Dawned — Classes, Abilities & Skill Trees

> Four classes, each with: identity, resource, weapon models (real assets), a basic combo, an RMB
> action, 8 abilities (slots 1–8; 8 = ultimate) and a 3-branch skill tree (24 nodes). All numbers are
> initial values, stored as content data and tunable in Dawned-Admin. Formulas: [COMBAT.md](COMBAT.md) §6.
> `coef` multiplies `(weaponDmg + AP|SP)`. Unlock levels: slots at 1 / 3 / 6 / 10 / 14 / 18 / 22 / 25.

## 0. Shared

- **Rig & animations:** all player characters use the Quaternius Universal Base Characters
  (male/female) + Modular Fantasy Outfits (Ranger/Peasant sets chosen at creation) + hairstyles, all
  driven by Universal Animation Library 1 [PRO] + 2 [Standard] clips (see
  [../ASSET_INVENTORY.md](../ASSET_INVENTORY.md) for clip lists). Class weapon models attach to hand
  sockets; weapons visually change with equipped item — armor look stays as chosen at creation.
- **Locomotion set (all classes):** `Idle_Loop`, 8-way `Jog_*`, `Sprint_Loop` (+Enter/Exit),
  `Jump_Start/Loop/Land`, `Roll` (dodge), `Swim_*`, `Crouch_*` (unused 0.1.0), turn-in-place `Turn90_*`.
- **Shared combat clips:** hits `Hit_Chest/Head/Shoulder_L/R/Stomach`, `Hit_Knockback`,
  `Death01/02`, gather clips (see PROFESSIONS.md), `Interact`, `PickUp_*`, `Drink` (potions),
  `Consume` (food), sit/campfire `GroundSit_*`.
- **Respec:** gold cost at Dawnhaven "Mirror of Dawn" (see PROGRESSION.md §6): refunds all skill
  points (stat points separately).

> **As built (P5, 2026-08-03):** the Warrior (§1) and Rogue (§3) kits are live as
> `content_abilities` rows — 8 slot abilities each plus all 12 basic-combo steps (all four
> classes), authored through the Dawned-Admin abilities editor and published via publish v1;
> exact shipped numbers live in the rows (panel-tunable without restart), with migration 0005
> as the deploy seed. Resource model implemented per §0: Rage 100 (builds +4/landed basic,
> +5/hit taken, +15 perfect block; decays 2/s out of combat), Energy 100 at 12/s with combo
> points ×5 (builder-granted, finishers spend all), Mana `100 + 10×INT` (P6 casters). RMB
> stances live: Warrior Block (frontal 120°, 60 % mitigation, 12 stamina per absorb, 200 ms
> perfect-block window → riposte stagger + 15 Rage) and Rogue Evasive (+10 % speed, −10 dodge
> stamina, 3 Energy/s). Slot unlock levels [1,3,6,10,14,18,22,25]. Mage/Cleric kits are P6
> data on the same schema.

### Class overview

| Class   | Archetype              | Resource                                           | Weapons (asset refs)                                                                                             | Damage stat              | Armor class                |
| ------- | ---------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------- |
| Warrior | Tank / bruiser         | **Rage** 0–100 (builds in combat, decays out)      | 1H swords + shields — KayKit `sword_A..E`, `shield_A..C`, MiniPoly `Talwar`, `Devil's Sword`, Adventurer shields | STR → AP                 | Heavy (highest gear armor) |
| Mage    | Ranged DPS             | **Mana** (pool, regen)                             | Staves & wands — KayKit `staff_A/B`, `wand_A`, Skeleton `Staff` variants                                         | INT → SP                 | Light                      |
| Rogue   | Melee DPS              | **Energy** 100 (fast regen) + **Combo Points** 0–5 | Dual daggers — KayKit `dagger_A/B`, MiniPoly `Dagger`, `Cleaver`                                                 | AGI → AP                 | Medium                     |
| Cleric  | Healer / battle-priest | **Mana** (pool, regen)                             | 1H hammers + shields — KayKit `hammer_A..C`, `shield_A..C`                                                       | INT → SP (dmg & healing) | Medium-heavy               |

Resource details: Mana pool `= 100 + 10×INT`, regen `4%/s OOC, 1.5%/s combat`. Energy regen `12/s`
always. Rage: +4 per basic-combo hit, +5 when damaged, +15 on Charge, decays 2/s out of combat, all
gains ×1 in combat only.

---

## 1. Warrior — "the wall that hits back"

Sword-and-board bruiser. Sticky, disruptive, hard to kill; damage is front-loaded into arcs and
slams. Solo identity: pull big, survive big. RMB **Block**: 60% frontal mitigation while held
(stamina drain per absorbed hit; 0.2 s perfect-block window staggers the attacker +15 Rage,
`Sword_Block`/`Idle_Shield_Loop`).
Basic combo: `Sword_Regular_A → B → C` (coef 0.55/0.55/0.85, step 3 cleaves 120°, +4 Rage per hit).

| #   | Ability (lvl)              | Cost / CD      | Type                 | Effect                                          | Anim                       |
| --- | -------------------------- | -------------- | -------------------- | ----------------------------------------------- | -------------------------- |
| 1   | **Crushing Blow** (1)      | 25 Rage / —    | Melee arc 90°, 3 m   | coef 1.6 phys + 20 stagger                      | `Sword_Attack`             |
| 2   | **Shield Bash** (3)        | 20 Rage / 10 s | Melee arc 60°, 2.5 m | coef 0.8 + **stun 1.5 s** + interrupt           | `Shield_OneShot`           |
| 3   | **Charge** (6)             | Free / 12 s    | Dash 12 m            | coef 0.5 on impact + slow 30%/3 s, **+15 Rage** | `Shield_Dash`              |
| 4   | **Rending Slash** (10)     | 30 Rage / 8 s  | Melee arc 90°, 3 m   | coef 0.9 + bleed DoT coef 0.9 over 9 s          | `Sword_Regular_B`          |
| 5   | **Taunting Shout** (14)    | Free / 15 s    | PBAoE 8 m            | Taunt 3 s + enemies −10% dmg for 6 s            | `Counter_Angry`            |
| 6   | **Whirlwind** (18)         | 40 Rage / 12 s | PBAoE 4 m ×2 ticks   | coef 1.1 per spin, move at 70% during           | `Sword_Heavy_Combo` (spun) |
| 7   | **Shield Wall** (22)       | Free / 45 s    | Self 6 s             | −50% damage taken, knockback-immune             | `Idle_Shield_Loop` overlay |
| 8   | **Earthshatter** (25, ult) | 50 Rage / 60 s | Cone 120°, 6 m       | coef 2.5 + knockdown 2 s + fills stagger        | `Melee_Hook` + ground VFX  |

**Skill tree** (branches × 8 nodes; tiers unlock at 2/5/10/15/20, capstone needs 8 pts in branch):

| Branch                        | Nodes (name — ranks — effect per rank)                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bulwark** (survive)         | Toughened — 3 — +3% MaxHP · Plated — 3 — +5% Armor · Stalwart Block — 2 — Block −8% stamina cost · Thick Skull — 1 — CC on you −20% duration · Retribution — 2 — Blocked hits deal coef 0.2 back · Unbreakable — 2 — Shield Wall +1 s / −5 s CD · Second Wind — 1 — At <25% HP: heal 20% (90 s ICD) · **Capstone: Immovable** — 1 — Shield Wall also 30% heal over duration; perfect blocks refund 10 stamina     |
| **Warlord** (damage)          | Sharpened — 3 — +2% phys damage · Brutality — 2 — Crushing Blow +10% coef · Deep Wounds — 2 — Rending bleed +15% & +2 s · Momentum — 2 — Charge grants +10% dmg 5 s · Cleaving Blows — 2 — basic step-3 arc +15°, +1 target cap · Executioner — 2 — +5% dmg vs targets <30% HP · Rampage — 1 — Whirlwind spins +1 tick · **Capstone: Warbringer** — 1 — Earthshatter CD −15 s, +0.5 coef                          |
| **Juggernaut** (rage/utility) | Boiling Blood — 3 — +1 Rage on basic hits · Enraging Defense — 2 — +2 Rage when hit · Fleet — 2 — +3% move speed · Battle Roar — 1 — Taunting Shout also +10% your dmg 6 s · Steadfast Charge — 1 — Charge breaks roots/slows · Relentless — 2 — Stun/knockdown you cause +0.25 s · Marathon — 2 — Sprint −1/s stamina · **Capstone: Colossus** — 1 — Every 30 Rage spent: +3% dmg & +3% armor stack 10 s (max 3) |

---

## 2. Mage — "glass cannon with an escape plan"

Ranged artillery: projectiles, ground AoE, control (chill/root), and Blink. Fragile — the kit answers
with range and CC, not tankiness. RMB **Focus**: hold to slow-strafe with tightened reticle, +10%
projectile speed. Passive **Attunement**: every 3rd basic bolt refunds 5 Mana and cuts active
cooldowns by 0.5 s.
Basic combo: 3-bolt `Spell_Simple_Shoot` chain (coef 0.5/0.5/0.8 magic, projectile).

| #   | Ability (lvl)           | Cost / CD      | Type                       | Effect                                                                            | Anim                          |
| --- | ----------------------- | -------------- | -------------------------- | --------------------------------------------------------------------------------- | ----------------------------- |
| 1   | **Fireball** (1)        | 20 Mana / —    | Projectile (spd 22, r 0.4) | cast 1.2 s (move 60%), coef 1.8 + burn coef 0.4/6 s                               | `Spell_Simple_*`              |
| 2   | **Ice Lance** (3)       | 15 Mana / —    | Projectile (spd 35)        | instant, coef 1.0, applies **Chill** (−20% move, 4 s); +50% dmg vs chilled/rooted | `Spell_Simple_Shoot`          |
| 3   | **Frost Nova** (6)      | 25 Mana / 14 s | PBAoE 5 m                  | coef 0.7 + **root 2 s**                                                           | `Spell_Double_Shoot`          |
| 4   | **Blink** (10)          | 10 Mana / 12 s | Teleport 10 m              | breaks roots/slows; brief 0.3 s untargetable                                      | custom FX + `NinjaJump_Start` |
| 5   | **Ember Wave** (14)     | 30 Mana / 10 s | Cone 60°, 7 m              | cast 0.8 s, coef 1.4 + refreshes burns                                            | `Spell_Double_*`              |
| 6   | **Mana Shield** (18)    | 15 Mana / 8 s  | Self buff                  | absorbs damage at 2 Mana per point until Mana out or recast                       | `Spell_Simple_Enter` overlay  |
| 7   | **Arcane Barrage** (22) | 35 Mana / 12 s | Channel 2.4 s              | 6 homing bolts × coef 0.55 at soft-target, move 40%                               | `Spell_Double_Shoot_Loop`     |
| 8   | **Meteor** (25, ult)    | 50 Mana / 60 s | Ground AoE r 5 m, ≤25 m    | telegraph 1.5 s → coef 3.2 + burn + 40 stagger                                    | `Spell_Double` slam + VFX     |

**Skill tree:**

| Branch                         | Nodes                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pyromancy** (burst)          | Kindling — 3 — +2% fire-tag dmg · Ignition — 2 — burn DoTs +15% · Fireball Mastery — 2 — Fireball cast −0.1 s · Combustion — 1 — Ember Wave consumes burns: +coef 0.3 per burning target hit (max 3) · Scorched Ground — 2 — Meteor leaves burning field 4 s coef 0.3/s · Critical Mass — 2 — +2% spell crit · Backdraft — 1 — Blink resets Ember Wave · **Capstone: Supernova** — 1 — Meteor radius +1.5 m, stun 1 s at epicenter (2 m) |
| **Cryomancy** (control)        | Frostbite — 3 — chilled targets take +2% your dmg · Deep Chill — 2 — Chill slow +7% · Wide Nova — 2 — Frost Nova +0.75 m radius · Shatter — 2 — Ice Lance crit +15% vs rooted · Permafrost — 1 — Nova root +0.5 s · Glacial Armor — 2 — melee attackers chilled, you take −3% dmg · Cold Snap — 1 — Nova CD −4 s · **Capstone: Winter's Grasp** — 1 — Ice Lance vs chilled adds stacking −5% enemy dmg (max 3)                           |
| **Arcana** (resource/mobility) | Clarity — 3 — +5% max Mana · Flow — 2 — +10% Mana regen · Swift Recovery — 2 — Attunement refund +2 Mana · Elastic Blink — 2 — Blink +1.5 m · Barrier Tuning — 2 — Mana Shield 1.75 Mana per dmg · Quickened Barrage — 1 — Barrage channel −0.6 s · Traveler — 2 — +3% move speed · **Capstone: Archmage** — 1 — Ult cost −20; every Blink refunds 10 Mana & next cast is instant (10 s ICD)                                             |

---

## 3. Rogue — "in, shred, out"

Dual-dagger skirmisher: energy + combo points, positional crits, target access via Shadowstep.
Highest sustained melee damage, medium armor, thrives on dodge discipline. RMB **Evasive Stance**
(hold): +10% move, dodge cost −10, drains 3 Energy/s. Passive **Ambusher**: rear attacks (>120°
behind) +15% crit; basic-crit grants +1 Combo Point (1 s ICD).
Basic combo: dual-dagger flurry (retimed `Sword_Regular_*` dual-wield retarget; coef 0.45/0.45/0.7,
**+1 CP on step 3**).

| #   | Ability (lvl)             | Cost / CD    | Type                        | Effect                                                                                           | Anim                           |
| --- | ------------------------- | ------------ | --------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| 1   | **Twin Strike** (1)       | 25 En / —    | Melee arc 70°, 2.5 m        | 2 hits × coef 0.6, **+1 CP**                                                                     | dual `Sword_Regular_A`         |
| 2   | **Shadowstep** (3)        | 20 En / 10 s | Dash-teleport ≤12 m         | lands behind soft-target, +1 CP, next attack +20%                                                | `Sword_Dash` + smoke           |
| 3   | **Eviscerate** (6)        | 30 En / —    | Melee arc 60°, 2.5 m        | **Finisher:** coef 0.9 + 0.5 × CP spent                                                          | `Sword_Attack_Standing`        |
| 4   | **Fan of Knives** (10)    | 30 En / 8 s  | Cone 90°, 8 m (projectiles) | coef 0.7 all targets, +1 CP if ≥2 hit                                                            | `OverhandThrow`                |
| 5   | **Crippling Strike** (14) | 20 En / 6 s  | Melee arc 70°, 2.5 m        | coef 0.7 + slow 40% 5 s, +1 CP                                                                   | `Sword_Regular_C`              |
| 6   | **Poisoned Blades** (18)  | 25 En / 20 s | Self buff 12 s              | attacks apply poison coef 0.25/6 s (stacks 3)                                                    | `Sword_Enter` flourish         |
| 7   | **Smoke Veil** (22)       | 25 En / 40 s | Self 3 s                    | AI drops you as target (threat wipe-lite), +30% move; next attack +30%                           | `Roll` + smoke VFX             |
| 8   | **Death Mark** (25, ult)  | 40 En / 60 s | Single ≤15 m                | instant coef 1.5 + mark 8 s (+20% dmg taken from you); kill on marked → +50 En, Shadowstep reset | `OverhandThrow` fast + mark FX |

**Skill tree:**

| Branch                           | Nodes                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Assassination** (crit/single)  | Honed Edges — 3 — +2% phys dmg · Lethality — 3 — +1.5% crit · Opportunist — 2 — Ambusher rear crit +5% · Deep Cuts — 2 — Eviscerate +0.1 coef per CP · Ruthless — 1 — Death Mark +5% dmg taken · Flensing — 2 — vs poisoned/bleeding +4% dmg · Killer's Rhythm — 1 — killing blow: +20% attack speed 6 s · **Capstone: Perfect Kill** — 1 — Eviscerate at 5 CP: guaranteed crit (12 s ICD)                                                         |
| **Swiftblade** (energy/mobility) | Conditioning — 3 — +5 max Energy · Vigor — 2 — +1 Energy/s · Fleetfoot — 2 — +3% move speed · Momentum Step — 1 — Shadowstep CD −3 s · Endless Knives — 2 — Fan of Knives −5 Energy · Combo Flow — 2 — finishers refund 5 En per CP ≥3 · Acrobat — 2 — dodge −5 stamina · **Capstone: Flurry** — 1 — After Shadowstep: next 3 basics +40% attack speed and +1 CP each                                                                              |
| **Toxicologist** (poison/aoe)    | Virulence — 3 — poison dmg +8% · Numbing Toxin — 2 — poisoned enemies −4% dmg · Spreading Blades — 1 — Fan of Knives applies 1 poison stack · Lingering — 2 — poison +1.5 s · Cripple Mastery — 2 — Crippling slow +8% · Smoke Trickery — 1 — Smoke Veil +1 s · Caustic Burst — 2 — Eviscerate consumes poisons: +0.15 coef per stack · **Capstone: Plaguebearer** — 1 — poisons can crit; on poisoned-target death, poison jumps to nearest enemy |

---

## 4. Cleric — "the dawn is a weapon"

Battle-priest: real solo damage (Smite/Hammer) with the only dedicated healing kit in the game.
Solo: a durable caster-melee hybrid. Social: back-line lifesaver (heals target soft-targeted allies,
fall back to self). RMB **Block** (40% frontal, as Warrior without perfect-block rage). Passive
**Grace**: self-healing +15%; Smite hits reduce next Mend cast by 0.1 s (stacks 3).
Basic combo: `Holy Spark` 3-bolt chain (Spell_Simple retint; coef 0.5/0.5/0.75 magic-holy).

| #   | Ability (lvl)           | Cost / CD      | Type                       | Effect                                                                      | Anim                          |
| --- | ----------------------- | -------------- | -------------------------- | --------------------------------------------------------------------------- | ----------------------------- |
| 1   | **Holy Smite** (1)      | 15 Mana / —    | Projectile (spd 28)        | coef 1.3 holy                                                               | `Spell_Simple_Shoot`          |
| 2   | **Mend** (3)            | 25 Mana / —    | Ally-soft ≤20 m / self     | cast 1.5 s (move 60%), heal coef 2.2                                        | `Spell_Simple_*`              |
| 3   | **Hammer of Wrath** (6) | 20 Mana / 8 s  | Melee arc 90°, 3 m         | coef 1.4 + 15 stagger + self-heal coef 0.3                                  | `Sword_Attack` (hammer)       |
| 4   | **Radiant Burst** (10)  | 30 Mana / 12 s | PBAoE 6 m                  | heal allies coef 1.2 **and** damage enemies coef 0.8                        | `Spell_Double_Shoot`          |
| 5   | **Sanctuary** (14)      | 35 Mana / 20 s | Ground circle r 4 m, ≤20 m | 8 s zone: HoT coef 0.35/s to allies inside                                  | `Spell_Double_*` + gold decal |
| 6   | **Purify** (18)         | 15 Mana / 8 s  | Ally-soft / self           | cleanse 1 debuff + heal coef 0.6                                            | `Spell_Simple_Shoot`          |
| 7   | **Aegis** (22)          | 30 Mana / 25 s | Ally-soft / self           | absorb shield coef 2.0, 8 s                                                 | `Spell_Simple_Enter`          |
| 8   | **Dawnlight** (25, ult) | 50 Mana / 75 s | PBAoE 10 m                 | heal coef 2.5 + cleanse all; enemies coef 1.5 holy + blind-flash stagger 30 | `Spell_Double` + sunburst     |

**Skill tree:**

| Branch                       | Nodes                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Light** (healing)          | Devotion — 3 — +3% healing done · Swift Mending — 2 — Mend cast −0.1 s · Blessed Ground — 2 — Sanctuary +1 s / +0.5 m · Cleansing Light — 1 — Purify heals +0.4 coef · Guardian Aegis — 2 — Aegis +10% absorb · Overflow — 2 — Mend overheal becomes 4 s HoT (30%) · Faithful — 2 — +5% max Mana · **Capstone: Dawn's Embrace** — 1 — Dawnlight leaves Sanctuary at your feet free                                                                   |
| **Wrath** (damage)           | Zeal — 3 — +2% holy dmg · Heavy Hand — 2 — Hammer of Wrath +10% coef · Searing Smite — 2 — Smite applies searing DoT coef 0.2/4 s · Righteous Echo — 1 — every 3rd Smite fires a free bonus bolt coef 0.5 · Retribution Aura — 2 — melee attackers take coef 0.15 · Judgement — 2 — +4% dmg vs stunned/staggered · Warpriest — 1 — Radiant Burst dmg part +30% · **Capstone: Avenging Dawn** — 1 — Dawnlight dmg +1.0 coef; after ult: +15% dmg 10 s |
| **Warden** (defense/utility) | Sturdy Faith — 3 — +3% MaxHP · Shield Training — 2 — Block +5% mitigation · Pilgrim — 2 — +3% move speed · Serenity — 2 — +10% Mana regen · Unshakeable — 1 — CC on you −20% duration · Martyr's Pace — 2 — healing yourself in combat grants +10% move 3 s · Beacon — 1 — Sanctuary also grants +10% armor inside · **Capstone: Guardian of Dawn** — 1 — At <30% HP: free auto-Aegis (60 s ICD)                                                     |

---

## 5. Balance guardrails

- Every class solos every 0.1.0 zone at level: verified per phase via scripted bot duels vs. zone
  archetypes + manual playtest matrix (class × zone) in P15.
- Single-target DPS envelope at level 30 (self-buffed, training dummy, 3 min): Rogue 100% > Mage 97%
  > Warrior 80% > Cleric 72%. Cleric compensates with sustain; Warrior with durability/CC.
- Kill-time targets per COMBAT.md §12 hold for **all four** classes vs at-level trash camps.
- Skill trees never gate the "fun button": ultimates and core mobility are level unlocks, trees only
  enhance.
