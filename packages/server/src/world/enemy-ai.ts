/**
 * Enemy AI v1 — the Grunt archetype FSM (docs/design/NPCS_ENEMIES.md §2):
 * IDLE → ALERT (0.5 s beat) → COMBAT (threat target, steering, weighted
 * attacks) → RETURN (invulnerable leash sprint, full reset) → DEAD.
 *
 * Decisions run at 10 Hz staggered by entity id parity (half the enemies per
 * 20 Hz tick); motion integrates every tick. Swarm-typed enemies run this
 * same FSM in P4 — the surround/pack behaviors arrive with P9's archetypes.
 * Dummies never leave IDLE and reset their HP once out of combat.
 */

import {
  EntityEventKind,
  TelegraphShape,
  angleDelta,
  type EnemyAbilityDef,
  type Rng,
  type TerrainSampler,
} from '@dawned/shared';
import type { ServerPlayer } from './player.js';
import type { ServerEnemy } from './enemy.js';
import { resolveEnemySwing, type CombatEvent } from './combat.js';

/** Perception (NPCS_ENEMIES.md §2): 140° vision cone + 4 m all-round hearing. */
const VISION_CONE_RAD = (140 * Math.PI) / 180;
const HEARING_RADIUS = 4;
/** Social aggro: camp-mates within this range of an aggroed ally join. */
const SOCIAL_AGGRO_RADIUS = 12;
/** The "I've been seen" beat before commitment. */
const ALERT_MS = 500;
/** COMBAT with no valid target for this long forces the leash (§2). */
const NO_TARGET_LEASH_MS = 20_000;
/** RETURN sprints home at this multiple of walk speed. */
const RETURN_SPEED_MULT = 1.6;
/** Close enough to home to stand down. */
const HOME_EPSILON = 1;
/** A RETURN that makes no progress for this long teleports home (A* lands P9). */
const RETURN_STUCK_MS = 5000;
/** Separation push between enemies, metres. */
const SEPARATION_RADIUS = 1.1;
/** Dummy targets refill to full this long after the last hit (out of combat). */
const DUMMY_RESET_MS = 5000;
/** Dead enemies sink away this long after the death beat (loot arrives P8). */
export const CORPSE_LINGER_MS = 10_000;

export interface AiContext {
  players: ReadonlyMap<number, ServerPlayer>;
  terrain: TerrainSampler;
  nowMs: number;
  dt: number;
  rng: Rng;
  events: CombatEvent[];
  /** Same-camp lookups for social aggro. */
  enemiesByCamp: (campTag: string) => readonly ServerEnemy[];
}

/** One 10 Hz decision for one enemy. */
export const decide = (enemy: ServerEnemy, ctx: AiContext): void => {
  switch (enemy.state) {
    case 'idle':
      decideIdle(enemy, ctx);
      return;
    case 'alert':
      decideAlert(enemy, ctx);
      return;
    case 'combat':
      decideCombat(enemy, ctx);
      return;
    case 'return':
    case 'dead':
      return; // motion/timers handle these
  }
};

const decideIdle = (enemy: ServerEnemy, ctx: AiContext): void => {
  if (enemy.def.archetype === 'dummy') {
    // Dummies never aggro; they just refill once nobody has hit them lately.
    if (
      enemy.hp < enemy.maxHp &&
      enemy.lastDamagedAtMs > 0 &&
      ctx.nowMs - enemy.lastDamagedAtMs > DUMMY_RESET_MS
    ) {
      enemy.hp = enemy.maxHp;
      ctx.events.push({
        type: 'entity-event',
        entityId: enemy.id,
        event: EntityEventKind.Respawn,
        a: 0,
        b: 0,
        c: 0,
      });
    }
    return;
  }

  const seen = perceive(enemy, ctx);
  if (seen !== null) {
    enemy.alertTargetId = seen;
    enemy.enterState('alert', ctx.nowMs);
    // Face the intruder for the beat; the 'No' clip is the player's tell.
    const player = ctx.players.get(seen);
    if (player) {
      enemy.yaw = Math.atan2(player.movement.x - enemy.x, player.movement.z - enemy.z);
    }
    ctx.events.push({
      type: 'entity-event',
      entityId: enemy.id,
      event: EntityEventKind.Alert,
      a: ALERT_MS,
      b: 0,
      c: 0,
    });
  }
};

const perceive = (enemy: ServerEnemy, ctx: AiContext): number | null => {
  for (const player of ctx.players.values()) {
    if (player.dead) continue;
    const dx = player.movement.x - enemy.x;
    const dz = player.movement.z - enemy.z;
    const distSq = dx * dx + dz * dz;
    if (distSq <= HEARING_RADIUS * HEARING_RADIUS) return player.id;
    if (distSq > enemy.def.aggroRadius ** 2) continue;
    const bearing = Math.atan2(dx, dz);
    if (Math.abs(angleDelta(enemy.yaw, bearing)) <= VISION_CONE_RAD / 2) return player.id;
  }
  return null;
};

const decideAlert = (enemy: ServerEnemy, ctx: AiContext): void => {
  if (ctx.nowMs - enemy.stateSinceMs < ALERT_MS) return;
  const target = enemy.alertTargetId;
  enemy.alertTargetId = null;
  if (target === null || !ctx.players.get(target) || ctx.players.get(target)!.dead) {
    enemy.enterState('idle', ctx.nowMs);
    return;
  }
  enterCombat(enemy, target, ctx);
};

/** Enter COMBAT vs a target and pull camp-mates in (social aggro). */
export const enterCombat = (enemy: ServerEnemy, targetId: number, ctx: AiContext): void => {
  if (enemy.state === 'dead' || enemy.state === 'return') return;
  if (enemy.state !== 'combat') {
    enemy.enterState('combat', ctx.nowMs);
    enemy.lastValidTargetAtMs = ctx.nowMs;
  }
  if (!enemy.threat.has(targetId)) enemy.addThreat(targetId, 1);

  if (enemy.campTag) {
    for (const ally of ctx.enemiesByCamp(enemy.campTag)) {
      if (ally.id === enemy.id || ally.state !== 'idle') continue;
      const dx = ally.x - enemy.x;
      const dz = ally.z - enemy.z;
      if (dx * dx + dz * dz <= SOCIAL_AGGRO_RADIUS * SOCIAL_AGGRO_RADIUS) {
        // Joins directly (no alert beat — the camp is already fighting).
        ally.enterState('combat', ctx.nowMs);
        ally.lastValidTargetAtMs = ctx.nowMs;
        ally.addThreat(targetId, 1);
      }
    }
  }
};

const decideCombat = (enemy: ServerEnemy, ctx: AiContext): void => {
  if (ctx.nowMs < enemy.stunnedUntilMs) return;

  // Leash on range from HOME (camp radius) — exploit-proof reset (§2).
  const homeDx = enemy.x - enemy.homeX;
  const homeDz = enemy.z - enemy.homeZ;
  if (homeDx * homeDx + homeDz * homeDz > enemy.def.leashRadius ** 2) {
    beginReturn(enemy, ctx);
    return;
  }

  // Validate the current top-threat target.
  let target: ServerPlayer | null = null;
  while (target === null) {
    const topId = enemy.topThreat();
    if (topId === null) break;
    const candidate = ctx.players.get(topId);
    if (!candidate || candidate.dead) {
      enemy.threat.delete(topId);
      continue;
    }
    target = candidate;
  }
  enemy.targetId = target?.id ?? null;
  if (!target) {
    if (ctx.nowMs - enemy.lastValidTargetAtMs > NO_TARGET_LEASH_MS) beginReturn(enemy, ctx);
    return;
  }
  enemy.lastValidTargetAtMs = ctx.nowMs;

  if (enemy.swing || ctx.nowMs < enemy.recoverUntilMs) return;

  // Attack selection: weighted pick among ready abilities in range (§2).
  const dx = target.movement.x - enemy.x;
  const dz = target.movement.z - enemy.z;
  const dist = Math.hypot(dx, dz);
  const ready = enemy.def.abilities.filter(
    (ability) =>
      (enemy.cooldowns.get(ability.id) ?? 0) <= ctx.nowMs &&
      dist >= ability.rangeMin &&
      dist <= ability.rangeMax,
  );
  if (ready.length > 0) {
    const ability = weightedPick(ready, ctx.rng);
    startSwing(enemy, ability, target, ctx);
  }
};

const weightedPick = (abilities: readonly EnemyAbilityDef[], rng: Rng): EnemyAbilityDef => {
  let total = 0;
  for (const ability of abilities) total += ability.weight;
  let roll = rng() * total;
  for (const ability of abilities) {
    roll -= ability.weight;
    if (roll <= 0) return ability;
  }
  return abilities[abilities.length - 1]!;
};

const startSwing = (
  enemy: ServerEnemy,
  ability: EnemyAbilityDef,
  target: ServerPlayer,
  ctx: AiContext,
): void => {
  const yaw = Math.atan2(target.movement.x - enemy.x, target.movement.z - enemy.z);
  enemy.yaw = yaw;
  enemy.vx = 0;
  enemy.vz = 0;
  enemy.swing = {
    ability,
    contactAtMs: ctx.nowMs + ability.windupMs,
    yaw,
    x: enemy.x,
    z: enemy.z,
  };
  enemy.cooldowns.set(ability.id, ctx.nowMs + ability.windupMs + ability.cooldownMs);
  const abilityIndex = Math.max(0, enemy.def.abilities.indexOf(ability));
  ctx.events.push({
    type: 'ability-start',
    entityId: enemy.id,
    action: abilityIndex,
    step: 0,
    durationMs: ability.windupMs,
    yaw,
  });
  if (ability.telegraph) {
    // The decal previews the EXACT server shape (COMBAT.md §5/§8 hard rule).
    ctx.events.push({
      type: 'telegraph',
      casterId: enemy.id,
      shape: TelegraphShape.Cone,
      x: enemy.x,
      z: enemy.z,
      yaw,
      size: ability.reach,
      spread: (ability.angleDeg * Math.PI) / 180,
      impactInMs: ability.windupMs,
    });
  }
};

const beginReturn = (enemy: ServerEnemy, ctx: AiContext): void => {
  enemy.enterState('return', ctx.nowMs);
  enemy.swing = null;
  enemy.targetId = null;
  enemy.threat.clear();
  ctx.events.push({
    type: 'entity-event',
    entityId: enemy.id,
    event: EntityEventKind.Leash,
    a: 0,
    b: 0,
    c: 0,
  });
};

/**
 * 20 Hz motion + swing timers for one enemy. Steering: seek the target to
 * attack range, separate from packed allies, slide along the walkgrid.
 */
export const move = (
  enemy: ServerEnemy,
  neighbors: readonly ServerEnemy[],
  ctx: AiContext,
): void => {
  if (enemy.state === 'dead') return;

  // Swing contact fires even while the FSM is between decisions.
  if (enemy.swing && ctx.nowMs >= enemy.swing.contactAtMs) {
    const swing = enemy.swing;
    enemy.swing = null;
    enemy.recoverUntilMs = ctx.nowMs + swing.ability.recoverMs;
    resolveEnemySwing(
      enemy,
      swing.ability,
      swing.yaw,
      swing.x,
      swing.z,
      [...ctx.players.values()],
      ctx.nowMs,
      ctx.rng,
      ctx.events,
    );
  }

  if (ctx.nowMs < enemy.stunnedUntilMs || enemy.swing) {
    enemy.vx = 0;
    enemy.vz = 0;
    settleOnGround(enemy, ctx);
    return;
  }

  let desiredX = 0;
  let desiredZ = 0;
  let speed = 0;

  if (enemy.state === 'return') {
    const dx = enemy.homeX - enemy.x;
    const dz = enemy.homeZ - enemy.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= HOME_EPSILON || ctx.nowMs - enemy.stateSinceMs > RETURN_STUCK_MS) {
      if (dist > HOME_EPSILON) {
        // Stuck against geometry: teleport the last stretch (A* arrives P9).
        enemy.x = enemy.homeX;
        enemy.z = enemy.homeZ;
      }
      enemy.resetToHome(ctx.nowMs);
      ctx.events.push({
        type: 'entity-event',
        entityId: enemy.id,
        event: EntityEventKind.Respawn,
        a: 0,
        b: 0,
        c: 0,
      });
      settleOnGround(enemy, ctx);
      return;
    }
    desiredX = dx / dist;
    desiredZ = dz / dist;
    speed = enemy.def.moveSpeed * RETURN_SPEED_MULT;
  } else if (enemy.state === 'combat' && enemy.targetId !== null) {
    const target = ctx.players.get(enemy.targetId);
    if (target && ctx.nowMs >= enemy.recoverUntilMs) {
      const dx = target.movement.x - enemy.x;
      const dz = target.movement.z - enemy.z;
      const dist = Math.hypot(dx, dz);
      // Stop just inside the shortest ready-ability reach; hover there.
      const desired = desiredRange(enemy);
      if (dist > desired) {
        desiredX = dx / dist;
        desiredZ = dz / dist;
        speed = enemy.def.moveSpeed;
      }
      enemy.yaw = Math.atan2(dx, dz);
    }
  }

  // Separation: don't stack into one blob (steering §2).
  for (const other of neighbors) {
    if (other.id === enemy.id || !other.alive) continue;
    const sx = enemy.x - other.x;
    const sz = enemy.z - other.z;
    const d = Math.hypot(sx, sz);
    if (d > 1e-6 && d < SEPARATION_RADIUS) {
      const push = (SEPARATION_RADIUS - d) / SEPARATION_RADIUS;
      desiredX += (sx / d) * push;
      desiredZ += (sz / d) * push;
      if (speed === 0) speed = enemy.def.moveSpeed * 0.5;
    }
  }

  const desiredLen = Math.hypot(desiredX, desiredZ);
  if (desiredLen > 1e-6 && speed > 0) {
    enemy.vx = (desiredX / desiredLen) * speed;
    enemy.vz = (desiredZ / desiredLen) * speed;
  } else {
    enemy.vx = 0;
    enemy.vz = 0;
  }

  // Integrate with the same axis-separated walkability slide players use.
  // RETURN ignores walkability the same way it ignores damage — the reset
  // must always get home (water/cliffs cannot strand an invulnerable enemy).
  const nextX = enemy.x + enemy.vx * ctx.dt;
  const nextZ = enemy.z + enemy.vz * ctx.dt;
  const walkable = ctx.terrain.walkableAt?.bind(ctx.terrain);
  if (enemy.state === 'return' || !walkable || !walkable(enemy.x, enemy.z)) {
    enemy.x = nextX;
    enemy.z = nextZ;
  } else if (walkable(nextX, nextZ)) {
    enemy.x = nextX;
    enemy.z = nextZ;
  } else if (walkable(nextX, enemy.z)) {
    enemy.x = nextX;
  } else if (walkable(enemy.x, nextZ)) {
    enemy.z = nextZ;
  }
  settleOnGround(enemy, ctx);
};

const settleOnGround = (enemy: ServerEnemy, ctx: AiContext): void => {
  enemy.y = ctx.terrain.heightAt(enemy.x, enemy.z);
};

/** Preferred combat range: just inside the shortest ready melee reach. */
const desiredRange = (enemy: ServerEnemy): number => {
  let best = 1.6;
  for (const ability of enemy.def.abilities) {
    if (ability.kind === 'melee_arc') best = Math.min(best, Math.max(ability.rangeMax - 0.4, 0.8));
  }
  return best;
};
