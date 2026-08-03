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
  BLOCK_ARC_DEG,
  BLOCK_MITIGATION_PCT,
  BLOCK_STAMINA_PER_HIT,
  PERFECT_BLOCK_RAGE,
  PERFECT_BLOCK_WINDOW_MS,
  RAGE_ON_DAMAGED,
  addStagger,
  gainComboPoints,
  gainResource,
  arcHits,
  baseWeaponDamage,
  isDodgeInvulnerable,
  rollDamage,
  sweepFirstHit,
  type ClassId,
  type ComboChain,
  type EnemyAbilityDef,
  type HitTarget,
  type ResolveHit,
  type Rng,
  type TerrainSampler,
} from '@dawned/shared';
import { damageDealtMultOf, damageTakenMultOf } from './effects.js';
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
  /** Whose bolt: player bolts sweep enemies, enemy bolts sweep players (P5). */
  ownerKind: 'player' | 'enemy';
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
  chains: Record<ClassId, ComboChain>,
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

  const combo = chains[player.classId];
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
  chains: Record<ClassId, ComboChain>,
  nowMs: number,
  rng: Rng,
  nextProjectileId: () => number,
  projectiles: ServerProjectile[],
  events: CombatEvent[],
): void => {
  const contact = player.pendingContact;
  if (!contact || nowMs < contact.atMs) return;
  player.pendingContact = null;

  const combo = chains[player.classId];
  const stepDef = combo.steps[contact.step]!;
  const weapon = baseWeaponDamage(player.level);
  const dealtMult = nowMs < player.dawnedUntilMs ? 1 - DAWNED_DAMAGE_PENALTY : 1;
  const rewind = rewindTicksFor(player.rttMs);

  if (combo.delivery === 'projectile' && combo.projectile) {
    const cosPitch = Math.cos(contact.aimPitch);
    const projectile: ServerProjectile = {
      id: nextProjectileId(),
      ownerId: player.id,
      ownerKind: 'player',
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
  // Resource riders per landed step (CLASSES.md §0/§3): Rage per basic hit,
  // the Rogue combo point on step 3 — content-declared, applied on contact.
  if (hits.length > 0) {
    if (stepDef.rageGain > 0) gainResource(player.resource, stepDef.rageGain, true);
    if (stepDef.comboPointGain > 0 && player.classId === 'rogue') {
      gainComboPoints(player.resource, stepDef.comboPointGain);
    }
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

    // Enemy bolts sweep PLAYERS (Ranged archetype, P5) — dodge i-frames and
    // the RMB block both count exactly like a melee swing would.
    if (p.ownerKind === 'enemy') {
      const candidates: ServerPlayer[] = [];
      const targets: HitTarget[] = [];
      for (const player of players.values()) {
        if (player.dead) continue;
        const px = player.movement.x - p.x;
        const pz = player.movement.z - p.z;
        if (px * px + pz * pz > (stepLen + 6) ** 2) continue;
        candidates.push(player);
        targets.push({
          x: player.movement.x,
          y: player.movement.y,
          z: player.movement.z,
          radius: PLAYER_RADIUS,
          height: PLAYER_HEIGHT,
        });
      }
      const hitPlayer = sweepFirstHit(p.x, p.y, p.z, dx, dy, dz, p.radius, targets, -1);
      if (hitPlayer) {
        const victim = candidates[hitPlayer.index]!;
        const owner = enemies.get(p.ownerId);
        const hits: ResolveHit[] = [];
        if (owner) {
          const resolved = applyEnemyHitToPlayer(
            owner,
            victim,
            p.coef,
            p.x,
            p.z,
            nowMs,
            rng,
            events,
          );
          if (resolved) hits.push(resolved);
        }
        // A dodged bolt (no resolved hit) still pops at the body it grazed.
        events.push({ type: 'ability-resolve', attackerId: p.ownerId, action: 0, step: 0, hits });
        const ex = p.x + dx * hitPlayer.t;
        const ey = p.y + dy * hitPlayer.t;
        const ez = p.z + dz * hitPlayer.t;
        events.push({
          type: 'projectile-end',
          projectileId: p.id,
          hit: true,
          x: ex,
          y: ey,
          z: ez,
        });
        projectiles.splice(i, 1);
        continue;
      }
      p.x += dx;
      p.y += dy;
      p.z += dz;
      p.travelled += stepLen;
      if (p.y <= terrain.heightAt(p.x, p.z) || p.travelled >= p.maxRange) {
        events.push({
          type: 'projectile-end',
          projectileId: p.id,
          hit: p.y <= terrain.heightAt(p.x, p.z),
          x: p.x,
          y: p.y,
          z: p.z,
        });
        projectiles.splice(i, 1);
      }
      continue;
    }

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

/**
 * One enemy-sourced hit landing on one player: dodge i-frames, RMB block
 * (frontal mitigation + perfect-block riposte), damage roll, Rage-on-damaged,
 * flinch/death events. Shared by melee swings and enemy projectiles — the
 * attack SOURCE position drives the block-facing test (the swing origin for
 * melee, the bolt's impact origin for ranged). Returns null when i-frames ate
 * the hit.
 */
const applyEnemyHitToPlayer = (
  enemy: ServerEnemy,
  player: ServerPlayer,
  coef: number,
  sourceX: number,
  sourceZ: number,
  nowMs: number,
  rng: Rng,
  events: CombatEvent[],
): ResolveHit | null => {
  if (player.dead) return null;
  // I-frames count live AND in the victim's rewound time — the roll they
  // saw on their own screen protects them (NETWORKING.md §4). The OR is
  // deliberately player-favorable; PvE softens the fairness stakes.
  const invulnerable =
    isDodgeInvulnerable(player.movement) ||
    player.history.wasInvulnerable(rewindTicksFor(player.rttMs));
  if (invulnerable) return null;

  // RMB block (CLASSES.md): frontal hits are mitigated while the shield is
  // up and stamina can pay for the absorb; a hit inside the raise window is
  // a PERFECT block — the attacker staggers open, the Warrior gains Rage.
  let blockMult = 1;
  const mitigationPct =
    player.classId === 'warrior' || player.classId === 'cleric'
      ? BLOCK_MITIGATION_PCT[player.classId]
      : undefined;
  if (player.blocking && mitigationPct !== undefined) {
    const toSource = Math.atan2(sourceX - player.movement.x, sourceZ - player.movement.z);
    let facingDelta = toSource - player.movement.yaw;
    while (facingDelta > Math.PI) facingDelta -= 2 * Math.PI;
    while (facingDelta < -Math.PI) facingDelta += 2 * Math.PI;
    const frontal = Math.abs(facingDelta) <= ((BLOCK_ARC_DEG / 2) * Math.PI) / 180;
    if (frontal && player.movement.stamina >= BLOCK_STAMINA_PER_HIT) {
      blockMult = 1 - mitigationPct / 100;
      player.movement.stamina -= BLOCK_STAMINA_PER_HIT;
      player.movement.staminaIdleMs = 0;
      if (nowMs - player.blockRaisedAtMs <= PERFECT_BLOCK_WINDOW_MS) {
        enemy.stunFor(1200, nowMs);
        enemy.vulnerableUntilMs = nowMs + STAGGER_VULNERABILITY_MS;
        events.push({
          type: 'entity-event',
          entityId: enemy.id,
          event: EntityEventKind.Stagger,
          a: 1200,
          b: 0,
          c: 0,
        });
        if (player.classId === 'warrior') {
          gainResource(player.resource, PERFECT_BLOCK_RAGE, true);
        }
      }
    }
  }

  const { amount } = rollDamage(
    {
      coef,
      weaponMin: enemy.swingDamage,
      weaponMax: enemy.swingDamage,
      power: 0,
      school: 'physical',
      critPct: 0, // enemies never crit — spikes read unfair, not dangerous
      attackerLevel: enemy.level,
      targetLevel: player.level,
      targetArmor: player.stats.armor,
      targetMagicResistPct: player.stats.magicResistPct,
      damageTakenMult: damageTakenMultOf(player, enemy.id) * blockMult,
      damageDealtMult: damageDealtMultOf(enemy),
    },
    rng,
  );
  player.hp = Math.max(0, player.hp - amount);
  player.lastCombatAtMs = nowMs;
  if (player.classId === 'warrior' && player.hp > 0) {
    gainResource(player.resource, RAGE_ON_DAMAGED, true);
  }
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
  return { targetId: player.id, amount, flags: player.hp <= 0 ? HitFlag.Killed : 0 };
};

/**
 * Enemy swing resolution against players (server-true positions). Melee kinds
 * arc-test at contact; projectile kinds loose a bolt at the current target
 * instead (Ranged archetype, NPCS_ENEMIES.md §1: "dodgeable projectile" — the
 * flight time IS the counterplay window, so no decal).
 */
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
  nextProjectileId?: () => number,
  projectiles?: ServerProjectile[],
  targetId?: number | null,
): void => {
  if (ability.kind === 'projectile') {
    if (!nextProjectileId || !projectiles) return;
    // Aim at the target's position at RELEASE (not wind-up start): strafing
    // during the draw changes the shot, and level flight keeps it dodgeable.
    const target = players.find((p) => p.id === targetId && !p.dead);
    let dirX = Math.sin(swingYaw);
    let dirY = 0;
    let dirZ = Math.cos(swingYaw);
    const muzzleY = enemy.y + enemy.def.hitHeight * 0.75;
    if (target) {
      const tx = target.movement.x - enemy.x;
      const ty = target.movement.y + PLAYER_HEIGHT * 0.55 - muzzleY;
      const tz = target.movement.z - enemy.z;
      const len = Math.hypot(tx, ty, tz);
      if (len > 1e-3) {
        dirX = tx / len;
        dirY = ty / len;
        dirZ = tz / len;
      }
    }
    const projectile: ServerProjectile = {
      id: nextProjectileId(),
      ownerId: enemy.id,
      ownerKind: 'enemy',
      rewindTicks: 0, // victims are tested at server-true time (their i-frames still rewind)
      x: enemy.x,
      y: muzzleY,
      z: enemy.z,
      dirX,
      dirY,
      dirZ,
      speed: ability.projectileSpeed,
      radius: ability.projectileRadius,
      travelled: 0,
      maxRange: ability.rangeMax + 6,
      coef: ability.coef,
      school: 'physical',
      power: 0,
      weaponMin: enemy.swingDamage,
      weaponMax: enemy.swingDamage,
      critPct: 0,
      attackerLevel: enemy.level,
      damageDealtMult: damageDealtMultOf(enemy),
      stagger: 0,
    };
    projectiles.push(projectile);
    events.push({
      type: 'projectile-spawn',
      projectileId: projectile.id,
      ownerId: enemy.id,
      x: projectile.x,
      y: projectile.y,
      z: projectile.z,
      dirX,
      dirY,
      dirZ,
      speed: projectile.speed,
      visual: 2, // enemy palette (client VISUALS[2])
    });
    return;
  }

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
    const hit = applyEnemyHitToPlayer(
      enemy,
      players[index]!,
      ability.coef,
      swingX,
      swingZ,
      nowMs,
      rng,
      events,
    );
    if (hit) hits.push(hit);
  }
  events.push({ type: 'ability-resolve', attackerId: enemy.id, action: 0, step: 0, hits });
};
