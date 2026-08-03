/**
 * The ability pipeline + damage application (docs/design/COMBAT.md §3–§6,
 * docs/tech/NETWORKING.md §4). World.step orchestrates; this module holds the
 * mechanics: player basic-combo execution with lag-rewound melee resolution,
 * server projectiles, and the single damage-application path for each side.
 *
 * Randomness is injected (World owns one rng) so combat is testable; only the
 * server ever rolls.
 */

import {
  ActionId,
  AbilityRejectReason,
  BASIC_COMBOS,
  COMBO_LINK_WINDOW_FRACTION,
  COMBO_RESET_MS,
  DAWNED_DAMAGE_PENALTY,
  EntityEventKind,
  GCD_MS,
  HitFlag,
  INTERP_DELAY_MS,
  MAX_REWIND_MS,
  MELEE_TARGET_CAP,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  STAGGER_STUN_MS,
  STAGGER_VULNERABILITY,
  STAGGER_VULNERABILITY_MS,
  TICK_MS,
  addStagger,
  arcHits,
  baseWeaponDamage,
  isDodgeInvulnerable,
  rollDamage,
  sweepFirstHit,
  type EnemyAbilityDef,
  type HitTarget,
  type ResolveHit,
  type Rng,
  type TerrainSampler,
} from '@dawned/shared';
import type { ServerPlayer } from './player.js';
import type { ServerEnemy } from './enemy.js';

/** Everything the gateway must broadcast (or World must react to) after a tick. */
export type CombatEvent =
  | {
      type: 'ability-start';
      entityId: number;
      action: number;
      step: number;
      durationMs: number;
      yaw: number;
    }
  | {
      type: 'ability-resolve';
      attackerId: number;
      action: number;
      step: number;
      hits: ResolveHit[];
    }
  | { type: 'ability-reject'; playerId: number; seq: number; action: number; reason: number }
  | { type: 'entity-event'; entityId: number; event: number; a: number; b: number; c: number }
  | {
      type: 'telegraph';
      casterId: number;
      shape: number;
      x: number;
      z: number;
      yaw: number;
      size: number;
      spread: number;
      impactInMs: number;
    }
  | {
      type: 'projectile-spawn';
      projectileId: number;
      ownerId: number;
      x: number;
      y: number;
      z: number;
      dirX: number;
      dirY: number;
      dirZ: number;
      speed: number;
      visual: number;
    }
  | { type: 'projectile-end'; projectileId: number; hit: boolean; x: number; y: number; z: number }
  | { type: 'player-died'; playerId: number; killerEnemyId: number | null }
  | { type: 'enemy-died'; enemy: ServerEnemy; killerPlayerId: number | null };

export interface ServerProjectile {
  id: number;
  ownerId: number;
  /** The owner's rewind offset in ticks, captured at fire time. */
  rewindTicks: number;
  x: number;
  y: number;
  z: number;
  dirX: number;
  dirY: number;
  dirZ: number;
  speed: number;
  radius: number;
  travelled: number;
  maxRange: number;
  /** Damage inputs captured at fire (the attacker may log out mid-flight). */
  coef: number;
  school: 'physical' | 'magic';
  power: number;
  weaponMin: number;
  weaponMax: number;
  critPct: number;
  attackerLevel: number;
  damageDealtMult: number;
  stagger: number;
}

/** Rewind offset for an attacker: their half-RTT + interp, in whole ticks. */
export const rewindTicksFor = (rttMs: number): number => {
  const ms = Math.min(rttMs / 2 + INTERP_DELAY_MS, MAX_REWIND_MS);
  return Math.max(0, Math.round(ms / TICK_MS));
};

const scratchPos = { x: 0, y: 0, z: 0 };
const enemyHitTarget = (enemy: ServerEnemy, rewindTicks: number): HitTarget => {
  scratchPos.x = enemy.x;
  scratchPos.y = enemy.y;
  scratchPos.z = enemy.z;
  enemy.history.at(rewindTicks, scratchPos);
  return {
    x: scratchPos.x,
    y: scratchPos.y,
    z: scratchPos.z,
    radius: enemy.def.hitRadius,
    height: enemy.def.hitHeight,
  };
};

/**
 * Player basic-attack execution. Validates the request against the server's
 * own chain state (the client predicted the same shared rules), commits the
 * step, and schedules the contact.
 */
export const handleAttackRequest = (
  player: ServerPlayer,
  seq: number,
  aimYaw: number,
  aimPitch: number,
  nowMs: number,
  events: CombatEvent[],
): void => {
  const reject = (reason: number): void => {
    events.push({
      type: 'ability-reject',
      playerId: player.id,
      seq,
      action: ActionId.BasicAttack,
      reason,
    });
  };
  if (player.dead) {
    reject(AbilityRejectReason.Dead);
    return;
  }
  if (player.movement.rollTimeLeft > 0 || player.movement.swimming) {
    reject(AbilityRejectReason.BadState);
    return;
  }

  const combo = BASIC_COMBOS[player.classId];
  // Chain state: which step fires, per the shared timing rules.
  let step = 0;
  if (player.comboStep >= 0 && player.comboStartedAtMs > 0) {
    const current = combo.steps[player.comboStep]!;
    const since = nowMs - player.comboStartedAtMs;
    const linkOpensAt = current.durationMs * (1 - COMBO_LINK_WINDOW_FRACTION);
    if (since < linkOpensAt) {
      // Inside the swing before the link window: the press is dropped, not an
      // error — client prediction drops it identically (shared comboWindow).
      return;
    }
    if (since <= current.durationMs + COMBO_RESET_MS) {
      step = (player.comboStep + 1) % combo.steps.length;
    }
  }
  if (nowMs < player.gcdUntilMs && step === 0) {
    // A fresh chain start respects the GCD; links inside a chain do not —
    // their cadence is the step timing itself.
    reject(AbilityRejectReason.OnCooldown);
    return;
  }

  const stepDef = combo.steps[step]!;
  player.comboStep = step;
  player.comboStartedAtMs = nowMs;
  player.gcdUntilMs = nowMs + GCD_MS;
  player.pendingContact = {
    step,
    atMs: nowMs + stepDef.durationMs * stepDef.contactFraction,
    aimYaw,
    aimPitch,
  };
  events.push({
    type: 'ability-start',
    entityId: player.id,
    action: ActionId.BasicAttack,
    step,
    durationMs: stepDef.durationMs,
    yaw: aimYaw,
  });
};

/** A dodge roll cancels the chain + pending contact (COMBAT.md §4/§7). */
export const cancelComboOnDodge = (player: ServerPlayer): void => {
  player.pendingContact = null;
  player.comboStep = -1;
  player.comboStartedAtMs = 0;
};

/**
 * Advance a player's pending contact; at contact time, resolve the step
 * against lag-rewound enemies (melee) or spawn the bolt (casters).
 */
export const advancePlayerContact = (
  player: ServerPlayer,
  enemies: ReadonlyMap<number, ServerEnemy>,
  nowMs: number,
  rng: Rng,
  nextProjectileId: () => number,
  projectiles: ServerProjectile[],
  events: CombatEvent[],
): void => {
  const contact = player.pendingContact;
  if (!contact || nowMs < contact.atMs) return;
  player.pendingContact = null;

  const combo = BASIC_COMBOS[player.classId];
  const stepDef = combo.steps[contact.step]!;
  const weapon = baseWeaponDamage(player.level);
  const dealtMult = nowMs < player.dawnedUntilMs ? 1 - DAWNED_DAMAGE_PENALTY : 1;
  const rewind = rewindTicksFor(player.rttMs);

  if (combo.delivery === 'projectile' && combo.projectile) {
    const cosPitch = Math.cos(contact.aimPitch);
    const projectile: ServerProjectile = {
      id: nextProjectileId(),
      ownerId: player.id,
      rewindTicks: rewind,
      x: player.movement.x,
      y: player.movement.y + 1.4, // hand height
      z: player.movement.z,
      dirX: Math.sin(contact.aimYaw) * cosPitch,
      dirY: Math.sin(contact.aimPitch),
      dirZ: Math.cos(contact.aimYaw) * cosPitch,
      speed: combo.projectile.speed,
      radius: combo.projectile.radius,
      travelled: 0,
      maxRange: combo.projectile.maxRange,
      coef: stepDef.coef,
      school: combo.school,
      power: combo.school === 'magic' ? player.stats.sp : player.stats.ap,
      weaponMin: weapon.min,
      weaponMax: weapon.max,
      critPct: player.stats.critPct,
      attackerLevel: player.level,
      damageDealtMult: dealtMult,
      stagger: stepDef.stagger,
    };
    projectiles.push(projectile);
    events.push({
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
    return;
  }

  // Melee arc against REWOUND enemy positions — the attacker hits what they saw.
  const candidates: ServerEnemy[] = [];
  const targets: HitTarget[] = [];
  for (const enemy of enemies.values()) {
    if (!enemy.alive || enemy.invulnerable) continue;
    const dx = enemy.x - player.movement.x;
    const dz = enemy.z - player.movement.z;
    if (dx * dx + dz * dz > (combo.reach + 4) ** 2) continue; // broad phase
    candidates.push(enemy);
    targets.push(enemyHitTarget(enemy, rewind));
  }
  const angleDeg =
    contact.step === combo.steps.length - 1 && combo.finisherAngleDeg !== null
      ? combo.finisherAngleDeg
      : combo.angleDeg;
  const hitIndices = arcHits(
    player.movement.x,
    player.movement.y,
    player.movement.z,
    contact.aimYaw,
    combo.reach,
    (angleDeg * Math.PI) / 180,
    targets,
    MELEE_TARGET_CAP,
  );

  const hits: ResolveHit[] = [];
  for (const index of hitIndices) {
    const enemy = candidates[index]!;
    const takenMult = nowMs < enemy.vulnerableUntilMs ? 1 + STAGGER_VULNERABILITY : 1;
    const { amount, crit } = rollDamage(
      {
        coef: stepDef.coef,
        weaponMin: weapon.min,
        weaponMax: weapon.max,
        power: combo.school === 'magic' ? player.stats.sp : player.stats.ap,
        school: combo.school,
        critPct: player.stats.critPct,
        attackerLevel: player.level,
        targetLevel: enemy.level,
        targetArmor: enemy.armor,
        targetMagicResistPct: enemy.magicResistPct,
        damageTakenMult: takenMult,
        damageDealtMult: dealtMult,
      },
      rng,
    );
    hits.push(
      applyDamageToEnemy(enemy, player.id, player, amount, crit, stepDef.stagger, nowMs, events),
    );
  }
  // Always resolve — an empty hit list tells the attacker's client to cancel
  // its optimistic hit-stop (a whiff must read as a whiff).
  events.push({
    type: 'ability-resolve',
    attackerId: player.id,
    action: ActionId.BasicAttack,
    step: contact.step,
    hits,
  });
};

/** The one path enemy HP loss goes through: damage, stagger, threat, death. */
export const applyDamageToEnemy = (
  enemy: ServerEnemy,
  attackerId: number,
  attacker: ServerPlayer | null,
  amount: number,
  crit: boolean,
  stagger: number,
  nowMs: number,
  events: CombatEvent[],
): ResolveHit => {
  enemy.hp = Math.max(0, enemy.hp - amount);
  enemy.lastDamagedAtMs = nowMs;
  enemy.addThreat(attackerId, amount);
  if (attacker) attacker.lastCombatAtMs = nowMs;

  let flags = 0;
  if (crit) flags |= HitFlag.Crit;

  if (enemy.hp <= 0) {
    flags |= HitFlag.Killed;
    events.push({ type: 'enemy-died', enemy, killerPlayerId: attacker ? attackerId : null });
    return { targetId: enemy.id, amount, flags };
  }

  if (addStagger(enemy.stagger, stagger, enemy.staggerGainFactor)) {
    flags |= HitFlag.Staggered;
    enemy.stunnedUntilMs = nowMs + STAGGER_STUN_MS;
    enemy.vulnerableUntilMs = nowMs + STAGGER_VULNERABILITY_MS;
    enemy.swing = null; // a filled meter interrupts the wind-up
    events.push({
      type: 'entity-event',
      entityId: enemy.id,
      event: EntityEventKind.Stagger,
      a: STAGGER_STUN_MS,
      b: 0,
      c: 0,
    });
  }
  return { targetId: enemy.id, amount, flags };
};

/**
 * Step every projectile one tick: advance, sweep the (rewound) enemies, then
 * test terrain. First hit wins; range exhaustion fades it out. Enemy damage
 * routes through applyDamageToEnemy with the owner resolved by the caller.
 */
export const stepProjectiles = (
  projectiles: ServerProjectile[],
  enemies: ReadonlyMap<number, ServerEnemy>,
  players: ReadonlyMap<number, ServerPlayer>,
  terrain: TerrainSampler,
  dt: number,
  nowMs: number,
  rng: Rng,
  events: CombatEvent[],
): void => {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i]!;
    const stepLen = p.speed * dt;
    const dx = p.dirX * stepLen;
    const dy = p.dirY * stepLen;
    const dz = p.dirZ * stepLen;

    const candidates: ServerEnemy[] = [];
    const targets: HitTarget[] = [];
    for (const enemy of enemies.values()) {
      if (!enemy.alive || enemy.invulnerable) continue;
      const ex = enemy.x - p.x;
      const ez = enemy.z - p.z;
      if (ex * ex + ez * ez > (stepLen + 6) ** 2) continue;
      candidates.push(enemy);
      targets.push(enemyHitTarget(enemy, p.rewindTicks));
    }
    const hit = sweepFirstHit(p.x, p.y, p.z, dx, dy, dz, p.radius, targets, -1);
    if (hit) {
      const enemy = candidates[hit.index]!;
      const takenMult = nowMs < enemy.vulnerableUntilMs ? 1 + STAGGER_VULNERABILITY : 1;
      const { amount, crit } = rollDamage(
        {
          coef: p.coef,
          weaponMin: p.weaponMin,
          weaponMax: p.weaponMax,
          power: p.power,
          school: p.school,
          critPct: p.critPct,
          attackerLevel: p.attackerLevel,
          targetLevel: enemy.level,
          targetArmor: enemy.armor,
          targetMagicResistPct: enemy.magicResistPct,
          damageTakenMult: takenMult,
          damageDealtMult: p.damageDealtMult,
        },
        rng,
      );
      const owner = players.get(p.ownerId) ?? null;
      const resolved = applyDamageToEnemy(
        enemy,
        p.ownerId,
        owner,
        amount,
        crit,
        p.stagger,
        nowMs,
        events,
      );
      events.push({
        type: 'ability-resolve',
        attackerId: p.ownerId,
        action: ActionId.BasicAttack,
        step: 0,
        hits: [resolved],
      });
      const hx = p.x + dx * hit.t;
      const hy = p.y + dy * hit.t;
      const hz = p.z + dz * hit.t;
      events.push({ type: 'projectile-end', projectileId: p.id, hit: true, x: hx, y: hy, z: hz });
      projectiles.splice(i, 1);
      continue;
    }

    p.x += dx;
    p.y += dy;
    p.z += dz;
    p.travelled += stepLen;

    if (p.y <= terrain.heightAt(p.x, p.z)) {
      events.push({
        type: 'projectile-end',
        projectileId: p.id,
        hit: true,
        x: p.x,
        y: p.y,
        z: p.z,
      });
      projectiles.splice(i, 1);
      continue;
    }
    if (p.travelled >= p.maxRange) {
      events.push({
        type: 'projectile-end',
        projectileId: p.id,
        hit: false,
        x: p.x,
        y: p.y,
        z: p.z,
      });
      projectiles.splice(i, 1);
    }
  }
};

/** Enemy melee swing resolution against players (server-true positions). */
export const resolveEnemySwing = (
  enemy: ServerEnemy,
  ability: EnemyAbilityDef,
  swingYaw: number,
  swingX: number,
  swingZ: number,
  players: readonly ServerPlayer[],
  nowMs: number,
  rng: Rng,
  events: CombatEvent[],
): void => {
  const targets: HitTarget[] = players.map((p) => ({
    x: p.movement.x,
    y: p.movement.y,
    z: p.movement.z,
    radius: PLAYER_RADIUS,
    height: PLAYER_HEIGHT,
  }));
  const hitIndices = arcHits(
    swingX,
    enemy.y,
    swingZ,
    swingYaw,
    ability.reach,
    (ability.angleDeg * Math.PI) / 180,
    targets,
    MELEE_TARGET_CAP,
  );

  const hits: ResolveHit[] = [];
  for (const index of hitIndices) {
    const player = players[index]!;
    if (player.dead) continue;
    // I-frames count live AND in the victim's rewound time — the roll they
    // saw on their own screen protects them (NETWORKING.md §4). The OR is
    // deliberately player-favorable; PvE softens the fairness stakes.
    const invulnerable =
      isDodgeInvulnerable(player.movement) ||
      player.history.wasInvulnerable(rewindTicksFor(player.rttMs));
    if (invulnerable) continue;

    const { amount } = rollDamage(
      {
        coef: ability.coef,
        weaponMin: enemy.swingDamage,
        weaponMax: enemy.swingDamage,
        power: 0,
        school: 'physical',
        critPct: 0, // enemies never crit — spikes read unfair, not dangerous
        attackerLevel: enemy.level,
        targetLevel: player.level,
        targetArmor: player.stats.armor,
        targetMagicResistPct: player.stats.magicResistPct,
      },
      rng,
    );
    player.hp = Math.max(0, player.hp - amount);
    player.lastCombatAtMs = nowMs;
    hits.push({ targetId: player.id, amount, flags: player.hp <= 0 ? HitFlag.Killed : 0 });
    if (player.hp <= 0) {
      events.push({ type: 'player-died', playerId: player.id, killerEnemyId: enemy.id });
    } else {
      events.push({
        type: 'entity-event',
        entityId: player.id,
        event: EntityEventKind.Flinch,
        a: 0,
        b: 0,
        c: 0,
      });
    }
  }
  events.push({ type: 'ability-resolve', attackerId: enemy.id, action: 0, step: 0, hits });
};
