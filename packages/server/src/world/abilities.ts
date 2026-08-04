/**
 * Slot-ability executor (P5, COMBAT.md §4): validates hotbar requests through
 * the SAME shared machine the client predicts with, schedules contacts on the
 * anim timeline, resolves targeting against lag-rewound enemies, and applies
 * the content-declared effect list through the real damage/effect pipelines.
 *
 * Movement abilities (dash/blink) route through the shared movement state so
 * prediction holds — beginDash/blink helpers live in the shared step's world.
 */

import {
  AMBUSHER_REAR_ARC_DEG,
  AMBUSHER_REAR_CRIT_PCT,
  AbilityRejectReason,
  STAGGER_VULNERABILITY,
  arcHits,
  circleHits,
  commitUse,
  beginDash,
  dashSweepHits,
  evaluateUse,
  gainComboPoints,
  gainResource,
  rollDamage,
  slotForAction,
  spendComboPoints,
  tickAbilityMachine,
  type AbilityDef,
  type HitTarget,
  type ResolveHit,
  type Rng,
  type TerrainSampler,
  DAWNED_DAMAGE_PENALTY,
  FOCUS_PROJECTILE_SPEED_PCT,
  GRACE_CAST_REDUCTION_MS,
  GRACE_CONSUMER_ABILITY,
  GRACE_EFFECT_ID,
  GRACE_SELF_HEAL_PCT,
  HitFlag,
  armorMitigation,
  levelModifier,
} from '@dawned/shared';
import type { GameContent } from '../content/loader.js';
import {
  ARCANE_SURGE_EFFECT,
  FLURRY_EFFECT,
  applyEffect,
  cleanseEffects,
  removeEffect,
  collectOnKillRiders,
  consumeNextAttackBonus,
  critBonusOf,
  damageDealtMultOf,
  damageTakenMultOf,
  hasCategory,
} from './effects.js';
import {
  applyDamageToEnemy,
  nodeCritBonusVs,
  nodeDamageMultVs,
  rewindTicksFor,
  type CombatEvent,
  type ServerProjectile,
} from './combat.js';
import { effectiveDefOf } from './progression.js';
import { slotKey } from '../content/loader.js';
import type { ServerEnemy } from './enemy.js';
import { playerWeaponDamage } from './items.js';
import type { ServerPlayer } from './player.js';

const scratch = { x: 0, y: 0, z: 0 };
const rewoundTarget = (enemy: ServerEnemy, rewindTicks: number): HitTarget => {
  scratch.x = enemy.x;
  scratch.y = enemy.y;
  scratch.z = enemy.z;
  enemy.history.at(rewindTicks, scratch);
  return {
    x: scratch.x,
    y: scratch.y,
    z: scratch.z,
    radius: enemy.def.hitRadius,
    height: enemy.def.hitHeight,
  };
};

/** Living, targetable enemies (leash-returning enemies are invulnerable). */
const targetableEnemies = (enemies: ReadonlyMap<number, ServerEnemy>): ServerEnemy[] => {
  const out: ServerEnemy[] = [];
  for (const enemy of enemies.values()) {
    if (enemy.hp > 0 && !enemy.invulnerable) out.push(enemy);
  }
  return out;
};

/**
 * Route a hotbar AbilityRequest. Mirrors the client's predicted evaluate —
 * agreement is the point; a reject means real state divergence and the client
 * rolls back + adopts the AbilityState correction the gateway sends after.
 */
export const handleSlotRequest = (
  player: ServerPlayer,
  seq: number,
  action: number,
  aimYaw: number,
  aimPitch: number,
  targetId: number,
  groundAim: { x: number; z: number } | null,
  content: GameContent,
  enemies: ReadonlyMap<number, ServerEnemy>,
  terrain: TerrainSampler,
  nowMs: number,
  events: CombatEvent[],
): void => {
  const reject = (reason: number): void => {
    events.push({ type: 'ability-reject', playerId: player.id, seq, action, reason });
  };
  const slot = slotForAction(action);
  if (slot === null) {
    reject(AbilityRejectReason.BadState);
    return;
  }
  const authored = content.abilityBySlot.get(slotKey(player.classId, slot));
  if (!authored) {
    reject(AbilityRejectReason.Locked);
    return;
  }
  // Node-rewritten def (P7): cost/cooldown/cast/effects as THIS character
  // plays them — the client folds the same transform from its synced ranks.
  const def = effectiveDefOf(player, authored.id, content.abilities) ?? authored;
  if (player.movement.rollTimeLeft > 0 || player.movement.swimming) {
    reject(AbilityRejectReason.BadState);
    return;
  }
  if (player.isStunned(nowMs)) {
    reject(AbilityRejectReason.BadState); // stunned: no presses (P6, §6.4)
    return;
  }

  // Ground-target sanity (v8): the point is client-clamped to maxRange; a
  // request outside range + slack is a desynced or dishonest client.
  let ground: { x: number; z: number } | null = null;
  if (def.targeting.kind === 'ground_aoe') {
    if (!groundAim) {
      reject(AbilityRejectReason.NoTarget);
      return;
    }
    const dist = Math.hypot(groundAim.x - player.movement.x, groundAim.z - player.movement.z);
    if (dist > def.targeting.maxRange + 2) {
      player.violations++;
      reject(AbilityRejectReason.BadState);
      return;
    }
    ground = groundAim;
  }

  const verdict = evaluateUse(player.abilityMachine, def, {
    level: player.level,
    alive: !player.dead,
    resource: player.resource,
    hasTarget: targetId > 0,
  });
  if (!verdict.ok) {
    reject(verdict.reason);
    return;
  }

  // Finisher CP are measured BEFORE commit (commit pays the energy).
  const comboPointsSpent = def.comboFinisher ? spendComboPoints(player.resource) : 0;
  // Cleric Grace: banked Smite hits shave the next Mend cast. Stacks are a
  // synced self-effect, so the client computes the same delta (bar parity).
  let castMsDelta = 0;
  if (player.classId === 'cleric' && def.id === GRACE_CONSUMER_ABILITY) {
    const grace = player.effects.find((effect) => effect.effectId === GRACE_EFFECT_ID);
    if (grace) {
      castMsDelta = -GRACE_CAST_REDUCTION_MS * grace.stacks;
      removeEffect(player, GRACE_EFFECT_ID);
    }
  }
  // Archmage surge (P7): a banked Blink makes the next real cast instant.
  // The effect is synced, so the client's bar computes the same collapse.
  if (def.castMs > 0 && player.effects.some((e) => e.effectId === ARCANE_SURGE_EFFECT)) {
    castMsDelta = -def.castMs;
    removeEffect(player, ARCANE_SURGE_EFFECT);
  }
  const commit = commitUse(
    player.abilityMachine,
    def,
    player.resource,
    { yaw: aimYaw, pitch: aimPitch, targetId },
    { castMsDelta },
  );
  applyOnUseRiders(player, def, comboPointsSpent, nowMs);

  if (commit.phase === 'cast' || commit.phase === 'channel') {
    events.push({
      type: 'ability-start',
      entityId: player.id,
      action,
      step: 0,
      // Casts show the bar for the (Grace-adjusted) cast; channels for their
      // full duration.
      durationMs: commit.phase === 'cast' ? commit.contactDelayMs : (def.channel?.durationMs ?? 0),
      yaw: aimYaw,
    });
    // Cast releases and channel ticks resolve in tickPlayerAbilities; ground
    // casts are schema-rejected in 0.1.0 (the press point would go stale).
    return;
  }

  let contactAtMs = nowMs + commit.contactDelayMs;
  const m = player.movement;
  if (def.targeting.kind === 'dash') {
    // Charge: the shared dash carries the body; the sweep resolves at dash end.
    player.dashStartX = m.x;
    player.dashStartZ = m.z;
    beginDash(m, Math.sin(aimYaw), Math.cos(aimYaw), def.targeting.distance, def.targeting.speed);
    contactAtMs = nowMs + m.dashTimeLeft * 1000;
  } else if (def.targeting.kind === 'blink_behind') {
    // Shadowstep: teleport behind the soft-target (fallback: short hop along
    // aim). Walkability decides; a blocked destination leaves position as-is.
    const enemy = enemies.get(targetId);
    let destX = m.x + Math.sin(aimYaw) * Math.min(4, def.targeting.maxRange);
    let destZ = m.z + Math.cos(aimYaw) * Math.min(4, def.targeting.maxRange);
    if (enemy && enemy.hp > 0 && !enemy.invulnerable) {
      const dist = Math.hypot(enemy.x - m.x, enemy.z - m.z);
      if (dist <= def.targeting.maxRange) {
        const back = enemy.def.hitRadius + 0.7;
        destX = enemy.x - Math.sin(enemy.yaw) * back;
        destZ = enemy.z - Math.cos(enemy.yaw) * back;
      }
    }
    if (!terrain.walkableAt || terrain.walkableAt(destX, destZ)) {
      m.x = destX;
      m.z = destZ;
      m.y = terrain.heightAt(destX, destZ);
      m.vx = 0;
      m.vz = 0;
    }
  } else if (def.targeting.kind === 'teleport') {
    // Mage Blink: forward hop along aim; the effect list handles the root
    // break + untargetable ghost. Walkability decides the landing.
    const destX = m.x + Math.sin(aimYaw) * def.targeting.distance;
    const destZ = m.z + Math.cos(aimYaw) * def.targeting.distance;
    if (!terrain.walkableAt || terrain.walkableAt(destX, destZ)) {
      m.x = destX;
      m.z = destZ;
      m.y = terrain.heightAt(destX, destZ);
      m.vx = 0;
      m.vz = 0;
    }
  } else if (def.targeting.kind === 'ground_aoe' && ground && def.targeting.telegraphMs > 0) {
    // Meteor: the decal shows for telegraphMs, THEN the sky falls — the
    // telegraph delay stacks on the anim contact like enemy heavies do.
    contactAtMs += def.targeting.telegraphMs;
    events.push({
      type: 'telegraph',
      casterId: player.id,
      shape: 0, // TelegraphShape.Circle
      x: ground.x,
      z: ground.z,
      yaw: 0,
      size: def.targeting.radius,
      spread: 0,
      impactInMs: contactAtMs - nowMs,
    });
  }

  player.pendingAbility = {
    def,
    action,
    atMs: contactAtMs,
    aimYaw,
    aimPitch,
    targetId,
    comboPointsSpent,
    pulsesLeft: def.targeting.kind === 'pbaoe' ? def.targeting.ticks.count : 1,
    groundX: ground?.x ?? null,
    groundZ: ground?.z ?? null,
  };
  events.push({
    type: 'ability-start',
    entityId: player.id,
    action,
    step: 0,
    durationMs: def.anim.durationMs,
    yaw: aimYaw,
  });
};

/**
 * On-use riders from allocated nodes (P7): root breaks, cooldown resets,
 * grants, basic-empowers — plus the class-wide spend/finisher passives.
 * Runs right after a successful commit, before any resolve.
 */
const applyOnUseRiders = (
  player: ServerPlayer,
  def: AbilityDef,
  comboPointsSpent: number,
  nowMs: number,
): void => {
  const agg = player.progress.aggregates;
  // Combo Flow: finishers refund energy per CP when spending enough.
  const refund = agg.passives.finisherRefund;
  if (refund && comboPointsSpent >= refund.minCp) {
    gainResource(player.resource, Math.round(refund.energyPerCp * comboPointsSpent), true);
  }
  // Colossus-style stacks: accumulate the class resource spent, bank a stack
  // per threshold crossed.
  if (def.cost.amount > 0) {
    for (const entry of agg.procs) {
      const proc = entry.proc;
      if (proc.proc !== 'resource_spent_stacks' || proc.resource !== def.cost.type) continue;
      player.progress.resourceSpentAccum += def.cost.amount;
      while (player.progress.resourceSpentAccum >= proc.perSpent) {
        player.progress.resourceSpentAccum -= proc.perSpent;
        applyEffect(
          player,
          {
            effectId: proc.effectId,
            casterId: player.id,
            durationMs: proc.durationMs,
            stacksMax: proc.stacksMax,
            mods: proc.mods,
            harmful: false,
          },
          nowMs,
        );
      }
    }
  }
  const modsList = agg.abilityMods.get(def.id);
  if (!modsList) return;
  for (const mods of modsList) {
    if (mods.breakMovementOnUse) {
      // Steadfast Charge: shed roots/slows/chills on use.
      cleanseEffects(player, 'movement', 10, true);
      player.rootedUntilMs = 0;
    }
    if (mods.resetCooldownOf) {
      // Backdraft: using this ability resets another's cooldown.
      player.abilityMachine.slots.delete(mods.resetCooldownOf);
    }
    if (mods.onUseGrant) {
      if (mods.onUseGrant.mana && player.resource.type === 'mana') {
        gainResource(player.resource, mods.onUseGrant.mana, true);
      }
      const instant = mods.onUseGrant.nextCastInstant;
      if (instant) {
        const key = `surge_${def.id}`;
        const readyAt = player.progress.procReadyAtMs.get(key) ?? 0;
        if (nowMs >= readyAt) {
          player.progress.procReadyAtMs.set(key, nowMs + instant.icdMs);
          applyEffect(
            player,
            {
              effectId: ARCANE_SURGE_EFFECT,
              casterId: player.id,
              durationMs: 10000,
              stacksMax: 1,
              mods: {},
              harmful: false,
            },
            nowMs,
          );
        }
      }
    }
    if (mods.empowerBasics) {
      // Flurry: the next N basics swing faster and feed CP each.
      player.empoweredBasicsLeft = mods.empowerBasics.count;
      player.empoweredBasicsCp = mods.empowerBasics.comboPointsPer;
      applyEffect(
        player,
        {
          effectId: FLURRY_EFFECT,
          casterId: player.id,
          durationMs: 8000,
          stacksMax: 1,
          mods: { attackSpeedPct: mods.empowerBasics.attackSpeedPct },
          harmful: false,
        },
        nowMs,
      );
    }
  }
};

/** A live ground zone (P6 Sanctuary): ticks its effect on its team inside. */
export interface GroundZone {
  casterId: number;
  x: number;
  z: number;
  radius: number;
  untilMs: number;
  nextTickAtMs: number;
  tickEveryMs: number;
  team: 'allies' | 'enemies';
  tickKind: 'heal' | 'damage';
  /** Per-tick amount, precomputed at spawn (heals raw; damage mitigated per target). */
  tickCoef: number;
  casterSp: number;
  casterLevel: number;
  /** Healing-done multiplier captured at spawn (Devotion, P7). */
  healMult: number;
  /** Extra mods granted to allies while inside (Beacon's armor, P7). */
  allyMods: import('@dawned/shared').AbilityEffectMods | null;
}

export interface AbilityTickDeps {
  enemies: ReadonlyMap<number, ServerEnemy>;
  players: ReadonlyMap<number, ServerPlayer>;
  content: GameContent;
  rng: Rng;
  nowMs: number;
  events: CombatEvent[];
  terrain: TerrainSampler;
  projectiles: ServerProjectile[];
  nextProjectileId: () => number;
  zones: GroundZone[];
}

/**
 * Per-tick ability bookkeeping for one player: machine time (cast release),
 * pending contact resolution, PBAoE pulse trains.
 */
export const tickPlayerAbilities = (
  player: ServerPlayer,
  dtMs: number,
  deps: AbilityTickDeps,
): void => {
  const moving = Math.abs(player.movement.vx) > 0.05 || Math.abs(player.movement.vz) > 0.05;
  const ticked = tickAbilityMachine(player.abilityMachine, dtMs, moving);
  // moveCanceled: cast lost to movement, full cost loss (§4.5). No event
  // needed — the client runs the same shared machine and cancels identically;
  // P5 kits are all instants anyway (casts arrive with the P6 casters).
  if (ticked.released) {
    const def = effectiveDefOf(player, ticked.released.abilityId, deps.content.abilities);
    if (def) {
      resolveAbility(
        player,
        def,
        actionOfDef(def),
        ticked.released.aimYaw,
        ticked.released.aimPitch,
        ticked.released.targetId,
        0,
        null,
        null,
        deps,
      );
    }
  }

  // Channel ticks (P6, Arcane Barrage): each tick releases one resolve —
  // for projectile channels that is one homing bolt at the press target.
  for (const tick of ticked.channelTicks) {
    const def = effectiveDefOf(player, tick.abilityId, deps.content.abilities);
    if (def) {
      resolveAbility(
        player,
        def,
        actionOfDef(def),
        tick.aimYaw,
        tick.aimPitch,
        tick.targetId,
        0,
        null,
        null,
        deps,
      );
    }
  }

  const pending = player.pendingAbility;
  if (pending && deps.nowMs >= pending.atMs) {
    if (pending.pulsesLeft > 1 && pending.def.targeting.kind === 'pbaoe') {
      pending.pulsesLeft -= 1;
      pending.atMs = deps.nowMs + pending.def.targeting.ticks.everyMs;
      resolveAbility(
        player,
        pending.def,
        pending.action,
        pending.aimYaw,
        pending.aimPitch,
        pending.targetId,
        pending.comboPointsSpent,
        pending.groundX,
        pending.groundZ,
        deps,
      );
    } else {
      player.pendingAbility = null;
      resolveAbility(
        player,
        pending.def,
        pending.action,
        pending.aimYaw,
        pending.aimPitch,
        pending.targetId,
        pending.comboPointsSpent,
        pending.groundX,
        pending.groundZ,
        deps,
      );
    }
  }
};

const actionOfDef = (def: AbilityDef): number =>
  def.binding.kind === 'slot' ? 2 + def.binding.slot - 1 : 0;

/** Rogue Ambusher: attacking from >120° behind the target's facing. */
const isRearAttack = (player: ServerPlayer, enemy: ServerEnemy): boolean => {
  const toAttacker = Math.atan2(player.movement.x - enemy.x, player.movement.z - enemy.z);
  let delta = toAttacker - enemy.yaw;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return Math.abs(delta) > ((360 - AMBUSHER_REAR_ARC_DEG) / 2) * (Math.PI / 180);
};

/**
 * Resolve one ability activation: acquire targets per the def's geometry
 * (lag-rewound), then run the ordered effect list.
 */
const resolveAbility = (
  player: ServerPlayer,
  def: AbilityDef,
  action: number,
  aimYaw: number,
  aimPitch: number,
  targetId: number,
  comboPointsSpent: number,
  groundX: number | null,
  groundZ: number | null,
  deps: AbilityTickDeps,
): void => {
  const { enemies, players, nowMs, events } = deps;
  const rewind = rewindTicksFor(player.rttMs);
  const candidates = targetableEnemies(enemies);
  const targets = candidates.map((enemy) => rewoundTarget(enemy, rewind));
  const m = player.movement;

  let hitEnemies: ServerEnemy[] = [];
  /** Friendly targets (self included) — heals/shields/cleanses land here. */
  let hitPlayers: ServerPlayer[] = [];
  const targeting = def.targeting;
  switch (targeting.kind) {
    case 'self':
    case 'teleport': // movement happened at commit; effects self-apply
      break;
    case 'melee_arc':
    case 'cone': {
      const indices = arcHits(
        m.x,
        m.y,
        m.z,
        aimYaw,
        targeting.reach,
        (targeting.angleDeg * Math.PI) / 180,
        targets,
        targeting.maxTargets,
      );
      hitEnemies = indices.map((i) => candidates[i]!);
      break;
    }
    case 'pbaoe': {
      const indices = circleHits(m.x, m.y, m.z, targeting.radius, targets);
      hitEnemies = indices.slice(0, targeting.maxTargets).map((i) => candidates[i]!);
      // Friendly halves of PBAoEs (Radiant Burst, Dawnlight): every living
      // player inside the ring, self included.
      hitPlayers = playersInCircle(players, m.x, m.z, targeting.radius);
      break;
    }
    case 'single': {
      const enemy = enemies.get(targetId);
      if (enemy && enemy.hp > 0 && !enemy.invulnerable) {
        const t = rewoundTarget(enemy, rewind);
        const dist = Math.hypot(t.x - m.x, t.z - m.z);
        if (dist <= targeting.maxRange + t.radius) hitEnemies = [enemy];
      }
      break;
    }
    case 'dash': {
      // Contact along the dash path just travelled (movement applied the
      // displacement; the sweep covers start → current).
      const startX = player.dashStartX;
      const startZ = player.dashStartZ;
      const indices = dashSweepHits(startX, m.y, startZ, m.x, m.z, 0.8, targets);
      hitEnemies = indices.map((i) => candidates[i]!);
      break;
    }
    case 'blink_behind': {
      const enemy = enemies.get(targetId);
      if (enemy) hitEnemies = []; // blink itself damages nothing (riders may)
      break;
    }
    case 'projectile': {
      // Slot/channel bolts (Fireball, Smite, Barrage ticks): loose a player
      // projectile carrying the damage payload; impact applies on-hit riders
      // via the projectile pipeline. Homing bolts remember the press target.
      spawnAbilityProjectile(player, def, targeting, aimYaw, aimPitch, targetId, deps);
      // Non-damage effects (self buffs riding a bolt press) still apply now.
      break;
    }
    case 'ally_soft': {
      // Q20 rule: the targeted ally if valid, else the most injured player in
      // range, else self (fallbackSelf). "Injured" compares hp fractions.
      const picked = pickAllyTarget(player, players, targetId, targeting.range);
      hitPlayers = picked ? [picked] : targeting.fallbackSelf ? [player] : [];
      break;
    }
    case 'ground_aoe': {
      const gx = groundX ?? m.x;
      const gz = groundZ ?? m.z;
      const indices = circleHits(gx, m.y, gz, targeting.radius, targets);
      hitEnemies = indices.slice(0, targeting.maxTargets).map((i) => candidates[i]!);
      hitPlayers = playersInCircle(players, gx, gz, targeting.radius);
      break;
    }
  }

  applyAbilityEffects(
    player,
    def,
    action,
    hitEnemies,
    hitPlayers,
    comboPointsSpent,
    groundX,
    groundZ,
    deps,
  );

  void nowMs;
  void events;
};

/** Living players inside a ground circle (self included). */
const playersInCircle = (
  players: ReadonlyMap<number, ServerPlayer>,
  x: number,
  z: number,
  radius: number,
): ServerPlayer[] => {
  const out: ServerPlayer[] = [];
  for (const p of players.values()) {
    if (p.dead) continue;
    if (Math.hypot(p.movement.x - x, p.movement.z - z) <= radius) out.push(p);
  }
  return out;
};

/** Ally-soft resolution (Q20): reticle pick → most injured in range → null. */
const pickAllyTarget = (
  caster: ServerPlayer,
  players: ReadonlyMap<number, ServerPlayer>,
  targetId: number,
  range: number,
): ServerPlayer | null => {
  const inRange = (p: ServerPlayer): boolean =>
    Math.hypot(p.movement.x - caster.movement.x, p.movement.z - caster.movement.z) <= range;
  const picked = players.get(targetId);
  if (picked && !picked.dead && inRange(picked)) return picked;
  let best: ServerPlayer | null = null;
  let bestFraction = 1;
  for (const p of players.values()) {
    if (p.dead || p.id === caster.id || !inRange(p)) continue;
    const fraction = p.maxHp > 0 ? p.hp / p.maxHp : 1;
    if (fraction < bestFraction && fraction < 0.999) {
      bestFraction = fraction;
      best = p;
    }
  }
  return best;
};

/** Loose one slot-ability bolt (P6 casters) through the projectile pipeline. */
const spawnAbilityProjectile = (
  player: ServerPlayer,
  def: AbilityDef,
  targeting: Extract<AbilityDef['targeting'], { kind: 'projectile' }>,
  aimYaw: number,
  aimPitch: number,
  targetId: number,
  deps: AbilityTickDeps,
): void => {
  const damage = def.effects.find(
    (effect): effect is Extract<AbilityDef['effects'][number], { kind: 'damage' }> =>
      effect.kind === 'damage',
  );
  const weapon = playerWeaponDamage(player);
  const dawnedMult = deps.nowMs < player.dawnedUntilMs ? 1 - DAWNED_DAMAGE_PENALTY : 1;
  const cosPitch = Math.cos(aimPitch);
  const projectile: ServerProjectile = {
    id: deps.nextProjectileId(),
    ownerId: player.id,
    ownerKind: 'player',
    rewindTicks: rewindTicksFor(player.rttMs),
    x: player.movement.x,
    y: player.movement.y + 1.4, // hand height (matches the basic-bolt muzzle)
    z: player.movement.z,
    dirX: Math.sin(aimYaw) * cosPitch,
    dirY: Math.sin(aimPitch),
    dirZ: Math.cos(aimYaw) * cosPitch,
    speed: targeting.speed * (player.focusing ? 1 + FOCUS_PROJECTILE_SPEED_PCT / 100 : 1),
    radius: targeting.radius,
    travelled: 0,
    maxRange: targeting.maxRange,
    coef: damage?.coef ?? 0,
    school: damage?.school ?? 'magic',
    power: (damage?.school ?? 'magic') === 'magic' ? player.stats.sp : player.stats.ap,
    weaponMin: weapon.min,
    weaponMax: weapon.max,
    critPct: player.stats.critPct + critBonusOf(player),
    attackerLevel: player.level,
    damageDealtMult: dawnedMult * damageDealtMultOf(player) * consumeNextAttackBonus(player),
    stagger: damage?.staggerBonus ?? 0,
    homingTargetId: targeting.homing ? targetId : 0,
    abilityId: def.id,
    fromBasic: false,
  };
  deps.projectiles.push(projectile);
  deps.events.push({
    type: 'projectile-spawn',
    projectileId: projectile.id,
    ownerId: player.id,
    x: projectile.x,
    y: projectile.y,
    z: projectile.z,
    dirX: projectile.dirX,
    dirY: projectile.dirY,
    dirZ: projectile.dirZ,
    speed: projectile.speed,
    visual: player.classId === 'cleric' ? 1 : 0,
  });
};

/** Run the ordered effect list on self/targets through the real pipelines. */
const applyAbilityEffects = (
  player: ServerPlayer,
  def: AbilityDef,
  action: number,
  hitEnemies: ServerEnemy[],
  hitPlayers: ServerPlayer[],
  comboPointsSpent: number,
  groundX: number | null,
  groundZ: number | null,
  deps: AbilityTickDeps,
): void => {
  const { rng, nowMs, events } = deps;
  const weapon = playerWeaponDamage(player);
  const dawnedMult = nowMs < player.dawnedUntilMs ? 1 - DAWNED_DAMAGE_PENALTY : 1;
  const buffMult = damageDealtMultOf(player);
  const nextAttackMult = hitEnemies.length > 0 ? consumeNextAttackBonus(player) : 1;
  const dealtMult = dawnedMult * buffMult * nextAttackMult;
  /** Friendly recipients: the resolved allies, or the caster for self kinds. */
  const friendlies = hitPlayers.length > 0 ? hitPlayers : [player];
  const nodeAgg = player.progress.aggregates;
  const abilityNodeMods = nodeAgg.abilityMods.get(def.id) ?? [];
  // Perfect Kill (P7): a max-CP finisher guarantees the crit, on an ICD.
  let forceCrit = false;
  for (const mods of abilityNodeMods) {
    const guaranteed = mods.guaranteedCritAtCp;
    if (!guaranteed || comboPointsSpent < guaranteed.cp) continue;
    const key = `gcrit_${def.id}`;
    const readyAt = player.progress.procReadyAtMs.get(key) ?? 0;
    if (nowMs >= readyAt) {
      player.progress.procReadyAtMs.set(key, nowMs + guaranteed.icdMs);
      forceCrit = true;
    }
  }
  // Combustion/Caustic Burst (P7): consume matching effects for bonus coef.
  // 'target' counts afflicted enemies once for the whole cast; 'stack'
  // counts per-enemy stacks at their own roll. Both CONSUME what they read.
  let consumedTargetsCoef = 0;
  const perStackConsume: { category: string; coefPer: number; max: number }[] = [];
  for (const mods of abilityNodeMods) {
    const consume = mods.consumeBonus;
    if (!consume) continue;
    if (consume.per === 'target') {
      let counted = 0;
      for (const enemy of hitEnemies) {
        if (counted >= consume.max) break;
        const before = enemy.effects.length;
        enemy.effects = enemy.effects.filter(
          (active) => !(active.category === consume.category && active.casterId === player.id),
        );
        if (enemy.effects.length !== before) {
          enemy.effectsDirty = true;
          counted += 1;
        }
      }
      consumedTargetsCoef += consume.coef * counted;
    } else {
      perStackConsume.push({ category: consume.category, coefPer: consume.coef, max: consume.max });
    }
  }

  const hits: ResolveHit[] = [];
  let anyKill = false;

  for (const effect of def.effects) {
    switch (effect.kind) {
      case 'damage': {
        const coef =
          effect.coef + effect.coefPerComboPoint * comboPointsSpent + consumedTargetsCoef;
        for (const enemy of hitEnemies) {
          // Per-stack consumption (Caustic Burst) reads + strips THIS enemy.
          let stackCoef = 0;
          for (const consume of perStackConsume) {
            let stacks = 0;
            const before = enemy.effects.length;
            for (const active of enemy.effects) {
              if (active.category === consume.category && active.casterId === player.id) {
                stacks += active.stacks;
              }
            }
            stacks = Math.min(stacks, consume.max);
            if (stacks > 0) {
              enemy.effects = enemy.effects.filter(
                (active) =>
                  !(active.category === consume.category && active.casterId === player.id),
              );
              if (enemy.effects.length !== before) enemy.effectsDirty = true;
              stackCoef += consume.coefPer * stacks;
            }
          }
          for (let h = 0; h < effect.hits; h++) {
            const staggerMult = nowMs < enemy.vulnerableUntilMs ? 1 + STAGGER_VULNERABILITY : 1;
            const rearCrit =
              player.classId === 'rogue' && isRearAttack(player, enemy)
                ? AMBUSHER_REAR_CRIT_PCT + nodeAgg.passives.ambusherRearCritDelta
                : 0;
            // Conditional bonus vs status categories (Ice Lance +50% vs
            // chilled/rooted) — runtime CC states count alongside effect tags.
            const bonusMult =
              effect.bonusVs &&
              (hasCategory(enemy, effect.bonusVs.categories) ||
                (effect.bonusVs.categories.includes('root') && nowMs < enemy.rootedUntilMs) ||
                (effect.bonusVs.categories.includes('stun') && nowMs < enemy.stunnedUntilMs))
                ? 1 + effect.bonusVs.pct / 100
                : 1;
            const { amount, crit } = rollDamage(
              {
                coef: coef + stackCoef,
                weaponMin: weapon.min,
                weaponMax: weapon.max,
                power: effect.school === 'magic' ? player.stats.sp : player.stats.ap,
                school: effect.school,
                critPct: forceCrit
                  ? 1000
                  : player.stats.critPct +
                    rearCrit +
                    critBonusOf(player) +
                    nodeCritBonusVs(player, effect.school, def.id, enemy, nowMs),
                attackerLevel: player.level,
                targetLevel: enemy.level,
                targetArmor: enemy.armor,
                targetMagicResistPct: enemy.magicResistPct,
                damageTakenMult: staggerMult * damageTakenMultOf(enemy, player.id),
                // School % + node conditionals (Executioner, Judgement…) — P7.
                damageDealtMult:
                  dealtMult * bonusMult * nodeDamageMultVs(player, effect.school, enemy, nowMs),
              },
              rng,
            );
            const hit = applyDamageToEnemy(
              enemy,
              player.id,
              player,
              amount,
              crit,
              effect.staggerBonus,
              nowMs,
              events,
            );
            hits.push(hit);
            if (enemy.hp <= 0) {
              anyKill = true;
              const riders = collectOnKillRiders(enemy, player.id);
              if (riders.energy > 0) gainResource(player.resource, riders.energy, true);
              for (const abilityId of riders.resetAbilities) {
                player.abilityMachine.slots.delete(abilityId);
              }
            }
          }
        }
        break;
      }
      case 'stun':
      case 'knockdown': {
        // Relentless (P7): stuns/knockdowns you cause last longer.
        const duration = effect.durationMs + nodeAgg.stats.ccDealtDurationDeltaMs;
        for (const enemy of hitEnemies) enemy.stunFor(duration, nowMs);
        break;
      }
      case 'root': {
        // Frost Nova: pin + a visible chip so the strip reads the root.
        for (const enemy of hitEnemies) {
          enemy.rootFor(effect.durationMs, nowMs);
          applyEffect(
            enemy,
            {
              effectId: `root_${def.id}`,
              casterId: player.id,
              durationMs: effect.durationMs,
              stacksMax: 1,
              mods: {},
              harmful: true,
              category: 'root',
            },
            nowMs,
          );
        }
        break;
      }
      case 'cleanse': {
        for (const target of friendlies) {
          cleanseEffects(target, effect.category, effect.count, effect.all);
          // Player roots live on a hard timer (applyCcToPlayer), not in the
          // effect list — every cleanse category ('movement' and 'any' alike)
          // breaks them too, or Blink would stop breaking roots the day P9
          // enemies start casting them. Stuns stay uncleansable (DR is their
          // only counterplay).
          target.rootedUntilMs = 0;
        }
        break;
      }
      case 'refresh': {
        // Ember Wave: reset matching DoT clocks on everyone just hit.
        for (const enemy of hitEnemies) {
          let refreshed = false;
          for (const active of enemy.effects) {
            if (active.category === effect.category && active.casterId === player.id) {
              active.expiresAtMs = nowMs + active.durationMs;
              refreshed = true;
            }
          }
          if (refreshed) enemy.effectsDirty = true;
        }
        break;
      }
      case 'zone': {
        // Sanctuary: a ground zone at the resolve point; a long friendly
        // telegraph decal is its world-space visual. Beacon's ally mods and
        // the healer's +healing% ride along, captured at spawn (P7).
        const zx = groundX ?? player.movement.x;
        const zz = groundZ ?? player.movement.z;
        let zoneAllyMods: GroundZone['allyMods'] = null;
        for (const mods of abilityNodeMods) {
          if (mods.zoneAllyMods) zoneAllyMods = mods.zoneAllyMods;
        }
        deps.zones.push({
          casterId: player.id,
          x: zx,
          z: zz,
          radius: effect.radius,
          untilMs: nowMs + effect.durationMs,
          nextTickAtMs: nowMs + effect.tickEveryMs,
          tickEveryMs: effect.tickEveryMs,
          team: effect.team,
          tickKind: effect.tick.kind,
          tickCoef: effect.tick.coef,
          casterSp: player.stats.sp,
          casterLevel: player.level,
          healMult: 1 + nodeAgg.stats.healingDonePct / 100,
          allyMods: zoneAllyMods,
        });
        events.push({
          type: 'telegraph',
          casterId: player.id,
          shape: 0,
          x: zx,
          z: zz,
          yaw: 0,
          size: effect.radius,
          spread: 0,
          impactInMs: effect.durationMs,
        });
        break;
      }
      case 'interrupt': {
        for (const enemy of hitEnemies) enemy.interruptSwing(nowMs);
        break;
      }
      case 'taunt': {
        for (const enemy of hitEnemies) enemy.tauntBy(player.id, effect.durationMs, nowMs);
        break;
      }
      case 'resource': {
        gainResource(player.resource, effect.amount, true);
        if (effect.comboPoints > 0 && player.classId === 'rogue') {
          gainComboPoints(player.resource, effect.comboPoints);
        }
        break;
      }
      case 'apply_effect': {
        // Periodic (bleed/poison) tick damage is fixed at APPLY time: the
        // whole DoT budget coefTotal×(avgWeapon+power), level-modified and
        // mitigated once, split across its ticks. Deterministic ticks — no
        // per-tick crit/variance (COMBAT.md §6.2 applies to hits, not DoTs).
        const periodic = effect.mods.periodic;
        const tickCount = periodic
          ? Math.max(1, Math.floor(effect.durationMs / periodic.tickEveryMs))
          : 0;
        const power = periodic?.school === 'magic' ? player.stats.sp : player.stats.ap;
        const dotBudget = periodic
          ? periodic.coefTotal * ((weapon.min + weapon.max) / 2 + power) * dealtMult
          : 0;
        const tickCountHeal = periodic
          ? Math.max(1, Math.floor(effect.durationMs / periodic.tickEveryMs))
          : 0;
        // Heal ticks: SP-scaled coefTotal, plus the P7 pct-of-max-HP term
        // (Immovable) computed against each TARGET's own pool at apply.
        const healPerTickFor = (target: ServerPlayer): number =>
          periodic?.kind === 'heal'
            ? Math.max(
                1,
                Math.round(
                  (periodic.coefTotal * player.stats.sp +
                    (periodic.pctMaxHpTotal / 100) * target.maxHp) /
                    tickCountHeal,
                ),
              )
            : 0;
        const input = {
          effectId: effect.effectId,
          casterId: player.id,
          durationMs: effect.durationMs,
          stacksMax: effect.stacksMax,
          mods: effect.mods,
          harmful: effect.target === 'hit' && hitEnemies.length > 0,
          category: effect.category,
          tickSchool: periodic?.school ?? ('physical' as const),
          tickEveryMs: periodic?.tickEveryMs,
        };
        if (effect.target === 'hit' && hitEnemies.length === 0 && hitPlayers.length > 0) {
          // Ally-targeted buff/HoT (P6): 'hit' on a friendly resolution.
          for (const target of hitPlayers) {
            applyEffect(
              target,
              { ...input, harmful: false, tickDamage: 0, tickHeal: healPerTickFor(target) },
              nowMs,
            );
          }
          break;
        }
        if (effect.target === 'self') {
          applyEffect(player, { ...input, tickDamage: 0, tickHeal: healPerTickFor(player) }, nowMs);
          if (effect.mods.threatDrop) {
            // Smoke Veil: AI sheds this player NOW (threat wipe-lite) — the
            // lingering effect keeps re-acquisition suppressed via targeting.
            for (const enemy of deps.enemies.values()) {
              if (enemy.threat.has(player.id)) enemy.threat.set(player.id, 0);
              if (enemy.targetId === player.id) enemy.targetId = enemy.topThreat();
            }
          }
        } else {
          for (const enemy of hitEnemies) {
            const mitigated =
              periodic?.kind === 'damage'
                ? Math.max(
                    1,
                    Math.round(
                      (dotBudget *
                        (1 -
                          (periodic.school === 'physical'
                            ? armorMitigation(enemy.armor, player.level)
                            : enemy.magicResistPct / 100)) *
                        levelModifier(player.level, enemy.level)) /
                        tickCount,
                    ),
                  )
                : 0;
            applyEffect(enemy, { ...input, tickDamage: mitigated, tickHeal: 0 }, nowMs);
          }
        }
        break;
      }
      case 'mark': {
        for (const enemy of hitEnemies) {
          applyEffect(
            enemy,
            {
              effectId: `mark_${def.id}`,
              casterId: player.id,
              durationMs: effect.durationMs,
              stacksMax: 1,
              mods: {},
              harmful: true,
              markPct: effect.damageFromCasterPct,
              onKillEnergy: effect.onKill?.energy ?? 0,
              onKillResetAbility: effect.onKill?.resetCooldownOf ?? null,
            },
            nowMs,
          );
        }
        break;
      }
      case 'heal': {
        for (const target of friendlies) {
          if (target.dead) continue;
          const healed = healPlayer(player, target, effect.coef, deps, def.id);
          hits.push({
            targetId: target.id,
            amount: healed,
            flags: HitFlag.Healed,
          });
        }
        break;
      }
      case 'shield': {
        // Absorb shield (Aegis): pool = coef × SP, replaced on recast.
        const pool = Math.max(1, Math.round(effect.coef * player.stats.sp));
        for (const target of friendlies) {
          if (target.dead) continue;
          applyEffect(
            target,
            {
              effectId: `shield_${def.id}`,
              casterId: player.id,
              durationMs: effect.durationMs,
              stacksMax: 1,
              mods: {},
              harmful: false,
              shieldPool: pool,
            },
            nowMs,
          );
        }
        break;
      }
    }
  }

  // Post-loop node riders (P7):
  for (const mods of abilityNodeMods) {
    // Supernova: extra stun inside the epicenter of the ground circle.
    if (mods.epicenterStun && def.targeting.kind === 'ground_aoe') {
      const gx = groundX ?? player.movement.x;
      const gz = groundZ ?? player.movement.z;
      for (const enemy of hitEnemies) {
        if (Math.hypot(enemy.x - gx, enemy.z - gz) <= mods.epicenterStun.radius) {
          enemy.stunFor(mods.epicenterStun.durationMs, nowMs);
        }
      }
    }
    // Winter's Grasp on non-projectile paths: category-gated appends.
    if (mods.addEffects && mods.addEffectsRequireCategories) {
      for (const enemy of hitEnemies) {
        const gate = mods.addEffectsRequireCategories;
        if (
          !hasCategory(enemy, gate) &&
          !(gate.includes('root') && nowMs < enemy.rootedUntilMs) &&
          !(gate.includes('stun') && nowMs < enemy.stunnedUntilMs)
        ) {
          continue;
        }
        for (const added of mods.addEffects) {
          if (added.kind !== 'apply_effect' || added.target !== 'hit') continue;
          applyEffect(
            enemy,
            {
              effectId: added.effectId,
              casterId: player.id,
              durationMs: added.durationMs,
              stacksMax: added.stacksMax,
              mods: added.mods,
              harmful: true,
              category: added.category,
            },
            nowMs,
          );
        }
      }
    }
    // Dawn's Embrace: a free follow-up cast lands at the caster's feet —
    // the referenced ability's zone/heal effects resolve as if quick-cast.
    if (mods.alsoCastFree) {
      const freeDef = effectiveDefOf(player, mods.alsoCastFree, deps.content.abilities);
      if (freeDef && freeDef.id !== def.id) {
        applyAbilityEffects(
          player,
          freeDef,
          actionOfDef(freeDef),
          [],
          [],
          0,
          player.movement.x,
          player.movement.z,
          deps,
        );
      }
    }
  }

  events.push({
    type: 'ability-resolve',
    attackerId: player.id,
    action,
    step: 0,
    hits,
  });
  void anyKill;
};

/**
 * Heal one player through the real pipeline (P6): SP scaling, crit roll
 * (1.5×), Cleric Grace (+15% self-heals), Devotion's +healing% (P7), hp cap
 * — and healing threat (COMBAT.md §6.5: 0.5 per point to every enemy
 * fighting the healer or the healed, which also records the P7 kill-tag
 * assist). Overflow (P7) turns Mend overheal into a HoT. Returns the
 * EFFECTIVE amount (overheal clipped).
 */
export const healPlayer = (
  healer: ServerPlayer,
  target: ServerPlayer,
  coef: number,
  deps: AbilityTickDeps,
  /** Source ability id — node riders like Overflow are ability-scoped. */
  abilityId: string | null = null,
): number => {
  const agg = healer.progress.aggregates;
  let amount = coef * healer.stats.sp * (1 + agg.stats.healingDonePct / 100);
  if (healer.classId === 'cleric' && target.id === healer.id) {
    amount *= 1 + GRACE_SELF_HEAL_PCT / 100;
  }
  if (deps.rng() * 100 < healer.stats.critPct + critBonusOf(healer)) {
    amount *= 1.5;
  }
  const rolled = Math.round(amount);
  const healed = Math.min(rolled, Math.round(target.maxHp - target.hp));
  // Overflow (P7): a slice of the overheal keeps healing over a few seconds.
  if (abilityId && rolled > Math.max(0, healed)) {
    for (const mods of agg.abilityMods.get(abilityId) ?? []) {
      const overflow = mods.overhealToHot;
      if (!overflow) continue;
      const pool = Math.round(((rolled - Math.max(0, healed)) * overflow.pct) / 100);
      if (pool < 1) continue;
      const ticks = Math.max(1, Math.floor(overflow.durationMs / 1000));
      applyEffect(
        target,
        {
          effectId: `overflow_${abilityId}`,
          casterId: healer.id,
          durationMs: overflow.durationMs,
          stacksMax: 1,
          mods: {},
          harmful: false,
          tickHeal: Math.max(1, Math.round(pool / ticks)),
          tickEveryMs: 1000,
        },
        deps.nowMs,
      );
    }
  }
  if (healed <= 0) return 0;
  // Captured BEFORE the heal marks combat (the heal itself must not count).
  const inCombat = deps.nowMs - target.lastCombatAtMs <= 5000;
  target.hp = Math.min(target.maxHp, target.hp + healed);
  target.lastCombatAtMs = deps.nowMs;
  // Martyr's Pace (P7): healing yourself in combat buys a burst of speed.
  if (target.id === healer.id) {
    for (const entry of agg.procs) {
      const proc = entry.proc;
      if (proc.proc !== 'on_self_heal_buff') continue;
      if (proc.inCombatOnly && !inCombat) continue;
      applyEffect(
        healer,
        {
          effectId: proc.effectId,
          casterId: healer.id,
          durationMs: proc.durationMs,
          stacksMax: 1,
          mods: proc.mods,
          harmful: false,
        },
        deps.nowMs,
      );
    }
  }
  // Healing threat: enemies already fighting either party notice the healer —
  // and the P7 kill-tag ledger remembers who kept the tagger standing.
  const threat = healed * 0.5;
  for (const enemy of deps.enemies.values()) {
    if (enemy.hp <= 0) continue;
    if (enemy.threat.has(healer.id) || enemy.threat.has(target.id)) {
      enemy.threat.set(healer.id, (enemy.threat.get(healer.id) ?? 0) + threat);
      let healedWho = enemy.healAssists.get(healer.id);
      if (!healedWho) {
        healedWho = new Set();
        enemy.healAssists.set(healer.id, healedWho);
      }
      healedWho.add(target.id);
    }
  }
  return healed;
};

/**
 * Advance ground zones (P6 Sanctuary): tick heals/damage to the team inside,
 * cull expired zones. Runs once per world tick.
 */
export const tickZones = (zones: GroundZone[], deps: AbilityTickDeps): void => {
  const { nowMs, players, events } = deps;
  for (let i = zones.length - 1; i >= 0; i--) {
    const zone = zones[i]!;
    if (nowMs >= zone.untilMs) {
      zones.splice(i, 1);
      continue;
    }
    if (nowMs < zone.nextTickAtMs) continue;
    zone.nextTickAtMs += zone.tickEveryMs;

    if (zone.team === 'allies' && zone.tickKind === 'heal') {
      const caster = players.get(zone.casterId);
      const hits: ResolveHit[] = [];
      for (const p of players.values()) {
        if (p.dead) continue;
        if (Math.hypot(p.movement.x - zone.x, p.movement.z - zone.z) > zone.radius) continue;
        // Beacon (P7): allies inside carry the zone's extra mods — a short
        // effect refreshed every tick, so leaving the circle sheds it fast.
        if (zone.allyMods) {
          applyEffect(
            p,
            {
              effectId: `zoneaura_${zone.casterId}`,
              casterId: zone.casterId,
              durationMs: zone.tickEveryMs + 600,
              stacksMax: 1,
              mods: zone.allyMods,
              harmful: false,
            },
            nowMs,
          );
        }
        // Zone ticks are deterministic (no crit — DoT/HoT rule, §6.2): SP and
        // the healer's +healing% were captured at spawn so the zone outlives
        // its caster cleanly.
        const amount = Math.min(
          Math.max(1, Math.round(zone.tickCoef * zone.casterSp * zone.healMult)),
          Math.round(p.maxHp - p.hp),
        );
        if (amount <= 0) continue;
        p.hp = Math.min(p.maxHp, p.hp + amount);
        hits.push({ targetId: p.id, amount, flags: HitFlag.Healed });
        if (caster) {
          const threat = amount * 0.5;
          for (const enemy of deps.enemies.values()) {
            if (enemy.hp <= 0) continue;
            if (enemy.threat.has(caster.id) || enemy.threat.has(p.id)) {
              enemy.threat.set(caster.id, (enemy.threat.get(caster.id) ?? 0) + threat);
              let healedWho = enemy.healAssists.get(caster.id);
              if (!healedWho) {
                healedWho = new Set();
                enemy.healAssists.set(caster.id, healedWho);
              }
              healedWho.add(p.id);
            }
          }
        }
      }
      if (hits.length > 0) {
        events.push({
          type: 'ability-resolve',
          attackerId: zone.casterId,
          action: 0,
          step: 0,
          hits,
        });
      }
    } else if (zone.team === 'enemies' && zone.tickKind === 'damage') {
      // Scorched Ground (P7 node): deterministic burning field. Mitigated by
      // magic resist + level mod once per tick, through the real damage path
      // (threat + kill credit included).
      const caster = players.get(zone.casterId) ?? null;
      const hits: ResolveHit[] = [];
      for (const enemy of deps.enemies.values()) {
        if (!enemy.alive || enemy.invulnerable) continue;
        if (Math.hypot(enemy.x - zone.x, enemy.z - zone.z) > zone.radius) continue;
        const raw = zone.tickCoef * zone.casterSp;
        const amount = Math.max(
          1,
          Math.round(
            raw * (1 - enemy.magicResistPct / 100) * levelModifier(zone.casterLevel, enemy.level),
          ),
        );
        hits.push(
          applyDamageToEnemy(enemy, zone.casterId, caster, amount, false, 0, nowMs, events),
        );
      }
      if (hits.length > 0) {
        events.push({
          type: 'ability-resolve',
          attackerId: zone.casterId,
          action: 0,
          step: 0,
          hits,
        });
      }
    }
  }
};
