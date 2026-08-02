# Dawned — Action Combat System

> The heart of the game (Pillar P1). This doc defines controls, targeting, the ability framework,
> damage math, status effects, threat, telegraphs, and the "feel" contract. Server-side enforcement:
> [../tech/NETWORKING.md](../tech/NETWORKING.md) + [../tech/SECURITY.md](../tech/SECURITY.md). Class kits: [CLASSES.md](CLASSES.md).

## 1. Combat Model at a Glance

- **True action combat.** No tab-target, no lock-on. Attacks are aimed with the character's facing /
  camera reticle and connect via geometric checks (arcs, projectiles, ground areas) on the server.
- **Mouselook control scheme** (BDO/Farever style): pointer-locked camera by default; character turns
  with camera; LMB/RMB are combat verbs, not cursor clicks. `Alt` frees the cursor for UI.
- **Soft-target assist:** a light reticle highlight on the best candidate in front (for tooltips,
  heal-targeting and projectile magnetism ≤ 4°). It never turns aiming off — misses are real.
- **Movement is combat.** Full movement while attacking (with per-ability move-speed multipliers),
  dodge roll with i-frames, sprint disengages, positioning matters (backstabs, cleave shapes).
- **Server-authoritative.** Client predicts animation/FX instantly; the server validates position,
  cost, cooldown, hit geometry (with lag rewind) and is the only source of damage/state truth.

## 2. Controls (default, all rebindable — see UI_UX.md §Settings)

| Input                   | Action                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `W A S D`               | Move (camera-relative)                                                                                                                                            |
| Mouse                   | Camera / aim (pointer lock)                                                                                                                                       |
| `Space`                 | Jump                                                                                                                                                              |
| `Shift` (hold)          | Sprint (drains stamina, see §7)                                                                                                                                   |
| `V` or `Mouse4`         | **Dodge roll** in movement direction (i-frames, stamina cost)                                                                                                     |
| `LMB`                   | Basic attack combo (class weapon chain)                                                                                                                           |
| `RMB` (hold)            | Class guard/aim action: Warrior/Cleric block (shield), Mage focus-aim (slow strafe, tighter reticle), Rogue evasive stance (+dodge distance, energy trickle cost) |
| `1–8`                   | Abilities (slot 8 = class ultimate, unlocked lvl 25; `Q` ships as an alternate binding for slot 8)                                                                |
| `E`                     | Consumable quick-slot (potion/food)                                                                                                                               |
| `F`                     | Interact / loot (hold for gather)                                                                                                                                 |
| `Tab`                   | Toggle nameplate focus info of soft-target (inspect HP/level/name)                                                                                                |
| `Alt` (hold)            | Free cursor (UI mode; character keeps velocity, camera locks)                                                                                                     |
| `C / I / K / M / L / J` | Character / Inventory / Skills / Map / Quest log / Professions                                                                                                    |
| `Enter`                 | Chat                                                                                                                                                              |

Gamepad: out of scope for 0.1.0 (desktop-first), input layer is abstracted so it can be added.

**Jumping & falling** (decided): jump is free (no stamina cost). Fall damage starts beyond 12 m of
drop: 6% MaxHP per meter past 12, capped at 95% — a full-HP character survives any fall, a wounded
one may not. Landing in swimmable water negates it entirely (diving off cliffs into the sea is a
sanctioned Dawnlands pastime). Drop height and damage are server-computed in the shared movement
step.

## 3. Basic Attacks & Combo Chains

Every class has an LMB **combo chain** (3 steps, UAL2 `Sword_Regular_A/B/C` pattern retargeted per
weapon; Mage/Cleric use spell-bolt equivalents):

- Step timing: press LMB during the current swing's **link window** (last 40% of anim) → chains to
  next step; else chain resets after 0.6 s.
- Each step: damage coefficient, small resource _generation_ (Warrior Rage +4, Rogue Energy is
  time-based instead, Mage/Cleric minor Mana refund on step 3), forward micro-lunge with soft
  collision, per-step SFX/VFX.
- Step 3 is the payoff: bigger coefficient + stagger buildup (see §6.4) + class rider (e.g. Warrior
  step 3 cleaves 120°).
- Basic attacks are never resource-gated — the floor of the rotation always works.

## 4. Ability Framework (data-driven)

Every ability is a content row (editable in Dawned-Admin) interpreted by one shared execution
pipeline. Fields (superset; unused = null):

```
id, classId, slot, name, icon, description(template with #{numbers})
costType (rage|mana|energy|stamina|none), costAmount, comboPointGen/Spend (rogue)
cooldownMs, gcdMs (default 400; heavy abilities may add own), chargeCount (default 1)
castTimeMs (0 = instant), channelMs+tickEvery, castWhileMoving (bool | speedMult)
range, targeting: SELF | MELEE_ARC(angle°, reach) | PROJECTILE(speed, radius, maxRange, pierce?)
             | GROUND_AOE(radius, maxRange, telegraphMs) | CONE(angle°, reach) | DASH(dist, speed)
             | ALLY_SOFT(range, fallbackSelf)
effects[]: DAMAGE(coef, school) | HEAL(coef) | SHIELD(coef, durMs) | DOT/HOT(coef, tickMs, durMs)
        | STUN/ROOT/SLOW(pct)/KNOCKBACK(m)/TAUNT/INTERRUPT (durMs) | BUFF/DEBUFF(statMod, durMs)
        | RESOURCE(gain) | TELEPORT | SUMMON_ZONE(radius, durMs, tickEffect)
animMap { cast?, loop?, release?, recover? } → UAL clip names, vfxMap, sfxMap
moveLockMs, turnLockMs, cancelableAfterMs (dodge always cancels unless flagged)
threatMult (default 1; taunts/heals special-cased §6.5)
```

Rules of the pipeline (identical client-predicted & server-validated):

1. **Request** (client → server, with client aim direction + timestamp).
2. **Validate**: alive, not stunned/casting-locked, cooldown ready, resource sufficient, range/LoS
   for targeted types, GCD clear. Reject → client rolls back predicted state (never plays damage).
3. **Commit**: pay cost, start cast/instant, broadcast `AbilityStart` (others see cast bars/wind-ups).
4. **Resolve** at impact time: geometric hit test in the **lag-rewound world** (≤ 250 ms, see
   NETWORKING.md), apply effect list, broadcast results (damage numbers, status applies, kills).
5. Casts are interruptible by: own dodge (cancels, 50% cost refund), stun/knockback (full loss),
   moving when `castWhileMoving=false` (grace 150 ms).

## 5. Hit Detection Shapes (server truth)

| Shape        | Used by                  | Check                                                                                                                  |
| ------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Melee arc    | swords, hammers, daggers | sector (reach r, angle θ) from attacker origin vs capsule hulls; multi-target cap per ability (default 5)              |
| Projectile   | bolts, knives, arrows    | swept-sphere advanced per tick (20 Hz) vs capsules + terrain/prop colliders; spawn offset from hand bone; max lifetime |
| Ground AoE   | meteors, sanctuaries     | circle on terrain; friendly/hostile filter; applies at telegraph end                                                   |
| Cone         | breath, waves            | as melee arc with bigger θ/r                                                                                           |
| Dash-through | charges, shadowstep      | capsule sweep along path, collects targets crossed                                                                     |
| Self/Aura    | buffs, novas             | radius around caster at resolve time                                                                                   |

Enemies use the same shapes (their telegraphs preview the exact server geometry — what you see is
what hits you; this is a hard fairness rule).

## 6. Combat Math

### 6.1 Stats feeding combat (full derivation in PROGRESSION.md)

`AP` (attack power: STR-classes Warrior; AGI-classes Rogue), `SP` (spell power: INT — Mage damage,
Cleric damage & healing), `MaxHP` (VIT), `Armor` (gear + STR minor), `Crit%` (base 5% + AGI),
`Stamina` (END). Weapons carry `weaponDmg` (min–max roll per hit).

### 6.2 Damage formula (single canonical path, unit-tested)

```
raw     = coef × (weaponDmg_roll + P)            P = AP or SP per ability school
crit    : roll < Crit% → raw ×= 1.5
variance: ±5% uniform (feel, anti-metronome)
mitig   = Armor / (Armor + 30×attackerLevel + 400)     (physical school)
        | Resist fixed per enemy type (magic school, 0–30%)
levelMod= clamp(1 + 0.02×(attackerLvl − targetLvl), 0.80, 1.20)
final   = round(raw × (1 − mitig) × levelMod)
```

Healing: `final = coef × SP × (1 ± 5%)`, crits ×1.5. Overheal is discarded (no tracking cost).

### 6.3 Damage schools

`physical` (mitigated by Armor) and `magic` (mitigated by flat resist%). Kept to two on purpose —
readable, balance-able; elements (fire/frost/holy/shadow) are **tags** for VFX/status flavor and
future gear affixes, not separate mitigation channels in 0.1.0.

### 6.4 Stagger & hit reactions (feel-critical)

- Light hits: additive flinch (UAL `Hit_Chest/Head/...` blended at 30% on upper body) — no control loss.
- **Stagger meter** per enemy (players immune; players get staggered only by explicit CC): basic
  step-3s and heavy abilities add stagger; at 100 → 1.2 s `HitReact` full-body stun, meter resets,
  brief +10% damage-taken window. Gives combo payoffs a tangible reward and a "poise" rhythm.
- Explicit CC on players: stun (loss of control, max 2 s in 0.1.0), root, slow, knockback
  (server-driven displacement, dodge-cancelable landing). CC diminishing returns: same-category CC
  within 10 s → 50% duration → immune (protects the solo experience vs. mob packs).

### 6.5 Threat (enables the Warrior tank fantasy solo→group later)

Per-enemy threat table: damage = 1 threat/point, healing = 0.5 to all enemies in the healer's combat,
`threatMult` on tank abilities (2.5×), Taunt = set to top+20% + 3 s forced target. Solo it's mostly
invisible; it ships in 0.1.0 because AI target selection already needs it (and post-0.1 groups get it
for free).

### 6.6 Regeneration & downtime

Out-of-combat (5 s no give/take damage): +8%/s HP, +10%/s resource (Rage instead _decays_ 2/s always
out of combat). In-combat: class-specific (see CLASSES.md). Campfire "Cozy": +4%/s bonus OOC regen.
Design goal: downtime between pulls ≈ 3–6 s, never a food-eating simulator.

## 7. Stamina (the universal action resource)

- Pool: `100 + 5×END + 2×(level−1)`. Displayed as a slim bar under HP globe.
- Costs: Sprint 8/s (+35% move speed), Dodge roll 25 flat, Swim-sprint 10/s. Jump is free.
- Regen: 15/s after 1 s without stamina use (8/s while blocking with RMB).
- At 0: sprint drops, dodge unavailable, "winded" vignette hint. Stamina is deliberately generous
  solo but a real budget inside boss telegraph sequences.
- Dodge roll: 0.55 s, ~4.2 m, **i-frames from 0.05–0.35 s**, cancels casts (§4.5), 0.5 s internal
  cooldown. The single most important button in the game — tuned first, tuned often.

## 8. Enemy Telegraphs

- Wind-up anims + **ground decals** (exact server shapes): red fill-up circle/cone/rect; fill = time
  to impact. Light attacks may telegraph via animation only (readable wind-ups ≥ 0.5 s).
- Grammar: _circle under you_ = move anywhere; _cone from boss_ = strafe behind; _expanding ring_ =
  gap-close or dodge-through; _full-arena + safe wedge_ = find the wedge (bosses only).
- All decals render colorblind-safe (pattern + color, see UI_UX.md accessibility).

## 9. Feel & Juice Contract (Definition of Done for "smooth")

Checklist every ability/enemy must pass before its phase closes:

- [ ] Anim has anticipation → contact → recovery; contact frame fires VFX+SFX+damage within 1 frame of each other (client-predicted).
- [ ] **Hit-stop** 40–70 ms on melee contact (attacker anim speed 0.1, victim flinch), scaled by hit weight.
- [ ] Camera: 2–4 px directional kick on dealing heavy hits; 6 px shake capped on receiving; never nauseating (global intensity slider).
- [ ] Floating combat text: outgoing (white, crit = bigger + tick), incoming (red), heal (green), XP (violet), resource (class color); pooled, batched, max 40 on screen.
- [ ] Impact VFX uses Kenney particle sheets + flat-color mesh flashes; enemy flash-tint on hit (0.08 s).
- [ ] Death: ragdoll-free stylized — enemy plays `Death` clip, desaturates, sinks after loot window (60 s or on loot).
- [ ] Kill confirm: subtle time-dilation 60 ms on killing blow of elites/bosses.
- [ ] Sound layers: whoosh (start), impact (contact), tail (rarity/size); 3 round-robin variants minimum (see AUDIO.md).

## 10. Death & Respawn

On death: control locked, camera orbits body 2 s, soul screen with respawn options (nearest attuned
shrine; GMs see extra options). Respawn: full HP, "Dawned" −15% damage 30 s (removed by campfire sit
— a tiny "go touch the world" loop). Enemies fully reset & heal on leash (see NPCS_ENEMIES.md).

## 11. PvE-only guardrails

No player-vs-player damage paths exist in 0.1.0 (duels are post-0.1): friendly AoEs skip players,
projectiles pass through allies (no body-block griefing), taunts/CC never target players. The effect
system still models "ally" targeting cleanly so Cleric heals and future duels don't need a rewrite.

## 12. Tuning Targets (initial, all admin-editable)

| Metric                                  | Target                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| TTK trash-at-level, solo                | 6–10 s                                                                        |
| TTK elite-at-level, solo                | 25–40 s                                                                       |
| Zone boss, solo, at level, competent    | 60–120 s with ≥3 telegraph mechanics                                          |
| Player deaths per hour, casual leveling | 0.5–1.5 (danger without punishment spiral)                                    |
| GCD                                     | 400 ms; ability rotation APM target ≈ 40–60 (fun for weeks, not a piano exam) |
| Basic:ability damage share at level     | ≈ 40:60 for DPS classes; movement uptime while fighting ≥ 85%                 |
