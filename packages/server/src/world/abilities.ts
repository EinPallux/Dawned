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
  baseWeaponDamage,
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
  armorMitigation,
  levelModifier,
} from '@dawned/shared';
import type { GameContent } from '../content/loader.js';
import {
  applyEffect,
  collectOnKillRiders,
  consumeNextAttackBonus,
  critBonusOf,
  damageDealtMultOf,
  damageTakenMultOf,
} from './effects.js';
import { applyDamageToEnemy, rewindTicksFor, type CombatEvent } from './combat.js';
import { slotKey } from '../content/loader.js';
import type { ServerEnemy } from './enemy.js';
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
  const def = content.abilityBySlot.get(slotKey(player.classId, slot));
  if (!def) {
    reject(AbilityRejectReason.Locked);
    return;
  }
  if (player.movement.rollTimeLeft > 0 || player.movement.swimming) {
    reject(AbilityRejectReason.BadState);
    return;
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
  const commit = commitUse(player.abilityMachine, def, player.resource, {
    yaw: aimYaw,
    pitch: aimPitch,
    targetId,
  });

  if (commit.phase === 'cast') {
    events.push({
      type: 'ability-start',
      entityId: player.id,
      action,
      step: 0,
      durationMs: def.castMs,
      yaw: aimYaw,
    });
    // The machine releases the cast; comboPointsSpent can only be non-zero on
    // instants in P5 (no casting finishers in the kits) — asserted by schema use.
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

export interface AbilityTickDeps {
  enemies: ReadonlyMap<number, ServerEnemy>;
  players: ReadonlyMap<number, ServerPlayer>;
  content: GameContent;
  rng: Rng;
  nowMs: number;
  events: CombatEvent[];
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
    const def = deps.content.abilities.get(ticked.released.abilityId);
    if (def) {
      resolveAbility(
        player,
        def,
        actionOfDef(def),
        ticked.released.aimYaw,
        ticked.released.aimPitch,
        ticked.released.targetId,
        0,
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
  deps: AbilityTickDeps,
): void => {
  const { enemies, rng, nowMs, events } = deps;
  const rewind = rewindTicksFor(player.rttMs);
  const candidates = targetableEnemies(enemies);
  const targets = candidates.map((enemy) => rewoundTarget(enemy, rewind));
  const m = player.movement;

  let hitEnemies: ServerEnemy[] = [];
  const targeting = def.targeting;
  switch (targeting.kind) {
    case 'self':
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
    case 'projectile':
    case 'ally_soft':
      // P6 targeting kinds — schema-expressible, not in the P5 kits.
      break;
  }

  applyAbilityEffects(player, def, action, hitEnemies, comboPointsSpent, deps);

  void aimPitch;
  void rng;
  void nowMs;
  void events;
};

/** Run the ordered effect list on self/targets through the real pipelines. */
const applyAbilityEffects = (
  player: ServerPlayer,
  def: AbilityDef,
  action: number,
  hitEnemies: ServerEnemy[],
  comboPointsSpent: number,
  deps: AbilityTickDeps,
): void => {
  const { rng, nowMs, events } = deps;
  const weapon = baseWeaponDamage(player.level);
  const dawnedMult = nowMs < player.dawnedUntilMs ? 1 - DAWNED_DAMAGE_PENALTY : 1;
  const buffMult = damageDealtMultOf(player);
  const nextAttackMult = hitEnemies.length > 0 ? consumeNextAttackBonus(player) : 1;
  const dealtMult = dawnedMult * buffMult * nextAttackMult;

  const hits: ResolveHit[] = [];
  let anyKill = false;

  for (const effect of def.effects) {
    switch (effect.kind) {
      case 'damage': {
        const coef = effect.coef + effect.coefPerComboPoint * comboPointsSpent;
        for (const enemy of hitEnemies) {
          for (let h = 0; h < effect.hits; h++) {
            const staggerMult = nowMs < enemy.vulnerableUntilMs ? 1 + STAGGER_VULNERABILITY : 1;
            const rearCrit =
              player.classId === 'rogue' && isRearAttack(player, enemy)
                ? AMBUSHER_REAR_CRIT_PCT
                : 0;
            const { amount, crit } = rollDamage(
              {
                coef,
                weaponMin: weapon.min,
                weaponMax: weapon.max,
                power: effect.school === 'magic' ? player.stats.sp : player.stats.ap,
                school: effect.school,
                critPct: player.stats.critPct + rearCrit + critBonusOf(player),
                attackerLevel: player.level,
                targetLevel: enemy.level,
                targetArmor: enemy.armor,
                targetMagicResistPct: enemy.magicResistPct,
                damageTakenMult: staggerMult * damageTakenMultOf(enemy, player.id),
                damageDealtMult: dealtMult,
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
        for (const enemy of hitEnemies) enemy.stunFor(effect.durationMs, nowMs);
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
        const input = {
          effectId: effect.effectId,
          casterId: player.id,
          durationMs: effect.durationMs,
          stacksMax: effect.stacksMax,
          mods: effect.mods,
          harmful: effect.target === 'hit',
          tickSchool: periodic?.school ?? ('physical' as const),
          tickEveryMs: periodic?.tickEveryMs,
        };
        if (effect.target === 'self') {
          applyEffect(player, { ...input, tickDamage: 0 }, nowMs);
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
            applyEffect(enemy, { ...input, tickDamage: mitigated }, nowMs);
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
        const healed = Math.round(effect.coef * player.stats.sp);
        player.hp = Math.min(player.maxHp, player.hp + healed);
        break;
      }
      case 'shield':
        // P6 (Cleric/Mage kits) — expressible, unused by P5 content.
        break;
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
