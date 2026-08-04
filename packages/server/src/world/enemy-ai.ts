/**
 * Enemy AI — the archetype FSM (docs/design/NPCS_ENEMIES.md §1–§2):
 * IDLE → ALERT (0.5 s beat) → COMBAT (threat target, steering, weighted
 * attacks) → RETURN (invulnerable leash sprint, full reset) → DEAD.
 *
 * Decisions run at 10 Hz staggered by entity id parity (half the enemies per
 * 20 Hz tick); motion integrates every tick. Dummies never leave IDLE and
 * reset their HP once out of combat.
 *
 * P9 completed the archetype language on top of P4's Grunt FSM:
 *   - Ranged/Caster hold the §1 stand-off band, kite at 60% and panic-melee
 *     when a player closes (the band comes from shared ARCHETYPE_MOTION).
 *   - Caster casts are interruptible on purpose — that window IS its
 *     counterplay, so a stun or an Interrupt drops the cast, not just the swing.
 *   - Charger lines up, telegraphs a rect, LUNGES along the locked lane
 *     hitting each victim once, and overshoots into a stagger — the punish.
 *   - Swarm members take evenly spaced slots on a ring around the target
 *     rather than all seeking the same point.
 *   - Bosses walk their phases (shared `bossPhaseAt`) and never leave the arena.
 * WHICH ability fires is not decided here: `selectableEnemyAbilities` and
 * `pickEnemyAbility` live in shared so the panel's TTK preview and the live
 * fight can never disagree about what an enemy would do.
 */

import {
  ARCHETYPE_MOTION,
  EntityEventKind,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  TelegraphShape,
  angleDelta,
  bossPhaseAt,
  dashSweepHits,
  pickEnemyAbility,
  selectableEnemyAbilities,
  surroundSlot,
  type BossPhaseState,
  type EnemyAbilityDef,
  type Rng,
  type TerrainSampler,
} from '@dawned/shared';
import type { ServerPlayer } from './player.js';
import type { ServerEnemy } from './enemy.js';
import { resolveEnemySwing, type CombatEvent, type ServerProjectile } from './combat.js';

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
/** A charge that hits nothing still ends: cap its flight so it cannot run on. */
const CHARGE_MAX_MS = 3000;

export interface AiContext {
  players: ReadonlyMap<number, ServerPlayer>;
  terrain: TerrainSampler;
  nowMs: number;
  dt: number;
  rng: Rng;
  events: CombatEvent[];
  /** Same-camp lookups for social aggro. */
  enemiesByCamp: (campTag: string) => readonly ServerEnemy[];
  /** Live projectile pool + id source — Ranged-archetype volleys (P5). */
  projectiles: ServerProjectile[];
  nextProjectileId: () => number;
  /** How many living pack-mates share this enemy's camp (swarm ring size). */
  packSize: (enemy: ServerEnemy) => number;
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

/**
 * Advance the boss phase if HP crossed a threshold this decision, announcing
 * the new phase once. Returns the folded modifiers for everything below.
 */
const updatePhase = (enemy: ServerEnemy, ctx: AiContext): BossPhaseState => {
  const phase = bossPhaseAt(enemy.def, enemy.hp / enemy.maxHp, enemy.phaseIndex);
  if (phase.index > enemy.phaseIndex) {
    enemy.phaseIndex = phase.index;
    // A phase change is a beat the player must SEE: the shout goes out as an
    // entity event so the client can flash the frame and play the line.
    ctx.events.push({
      type: 'entity-event',
      entityId: enemy.id,
      event: EntityEventKind.Phase,
      a: phase.index,
      b: 0,
      c: 0,
    });
    // The announce LINE is not on the wire: the client already holds this
    // enemy's published def (it loads them for nameplates and telegraphs), so
    // it reads the text for the phase index itself. One less message, and the
    // words stay content the panel can edit without a protocol change.
    //
    // A new phase clears the current wind-up: the transition is its own beat,
    // not something a half-finished swing rides through.
    enemy.swing = null;
    enemy.charge = null;
  }
  return phase;
};

const decideCombat = (enemy: ServerEnemy, ctx: AiContext): void => {
  if (ctx.nowMs < enemy.stunnedUntilMs) return;
  // A lunge owns the body until it lands (see `move`).
  if (enemy.charge) return;

  const phase = updatePhase(enemy, ctx);

  // Leash on range from HOME (camp radius) — exploit-proof reset (§2). A boss
  // with an arena uses that instead: it must never be pulled out of its fight
  // area, whatever the threat table says.
  const homeDx = enemy.x - enemy.homeX;
  const homeDz = enemy.z - enemy.homeZ;
  const leash = enemy.def.arenaRadius > 0 ? enemy.def.arenaRadius : enemy.def.leashRadius;
  if (homeDx * homeDx + homeDz * homeDz > leash * leash) {
    beginReturn(enemy, ctx);
    return;
  }

  // Validate the current top-threat target. An active Taunt (P5, COMBAT.md
  // §6.5) overrides threat entirely — forced target while it lasts.
  let target: ServerPlayer | null = null;
  if (enemy.tauntedById !== null && ctx.nowMs < enemy.tauntedUntilMs) {
    const taunter = ctx.players.get(enemy.tauntedById);
    if (taunter && !taunter.dead) target = taunter;
    else enemy.tauntedById = null;
  }
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

  // Attack selection runs through the SHARED gate (§2), so the panel's TTK
  // preview and this fight are answering the same question with one function.
  const dx = target.movement.x - enemy.x;
  const dz = target.movement.z - enemy.z;
  const dist = Math.hypot(dx, dz);
  const ready = selectableEnemyAbilities(enemy.def.abilities, {
    distance: dist,
    hpFraction: enemy.hp / enemy.maxHp,
    phase: enemy.phaseIndex,
    onCooldown: (id) => (enemy.cooldowns.get(id) ?? 0) > ctx.nowMs,
    spent: (id) => enemy.spentAbilities.has(id),
  });
  const ability = pickEnemyAbility(ready, ctx.rng());
  if (ability) startSwing(enemy, ability, target, ctx, phase);
};

const startSwing = (
  enemy: ServerEnemy,
  ability: EnemyAbilityDef,
  target: ServerPlayer,
  ctx: AiContext,
  phase: BossPhaseState,
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
  // Once-per-life is spent at COMMIT, not at contact: an interrupted opener
  // is still spent, which is what makes interrupting one worth doing.
  if (ability.oncePerLife) enemy.spentAbilities.add(ability.id);
  const abilityIndex = Math.max(0, enemy.def.abilities.indexOf(ability));
  ctx.events.push({
    type: 'ability-start',
    entityId: enemy.id,
    action: abilityIndex,
    step: 0,
    durationMs: ability.windupMs,
    yaw,
    // A cast shows a BAR over the nameplate instead of reading as a wind-up:
    // the player's cue that this one can be stopped (§1 Caster counterplay).
    cast: ability.cast,
  });
  if (ability.telegraph) {
    // The decal previews the EXACT server shape (COMBAT.md §5/§8 hard rule) —
    // so the shape follows the ability's kind, never a fixed cone.
    ctx.events.push({
      type: 'telegraph',
      casterId: enemy.id,
      shape: telegraphShapeOf(ability),
      x: enemy.x,
      z: enemy.z,
      yaw,
      size: telegraphSizeOf(ability),
      spread: telegraphSpreadOf(ability),
      impactInMs: ability.windupMs,
    });
  }
  void phase; // phase modifiers apply at resolve/recovery, not at commit
};

/** The decal a wound-up ability draws — the same shape the server will test. */
const telegraphShapeOf = (ability: EnemyAbilityDef): number => {
  switch (ability.kind) {
    case 'charge_rect':
      return TelegraphShape.Rect;
    case 'ground_circle':
      return TelegraphShape.Circle;
    default:
      return TelegraphShape.Cone;
  }
};

/** Decal length: how far the shape reaches from the caster. */
const telegraphSizeOf = (ability: EnemyAbilityDef): number => {
  switch (ability.kind) {
    case 'charge_rect':
      return ability.chargeDistance;
    case 'ground_circle':
      return ability.circleRadius;
    default:
      return ability.reach;
  }
};

/** Cone half-angle in radians, or a rect's half-width in metres. */
const telegraphSpreadOf = (ability: EnemyAbilityDef): number => {
  switch (ability.kind) {
    case 'charge_rect':
      return ability.chargeWidth;
    case 'ground_circle':
      return 0;
    default:
      return (ability.angleDeg * Math.PI) / 180;
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

  // A lunge in flight owns the body: travel the locked lane, hit each victim
  // once, and end in the overshoot stagger that pays for the archetype.
  if (enemy.charge) {
    advanceCharge(enemy, ctx);
    settleOnGround(enemy, ctx);
    return;
  }

  // Swing contact fires even while the FSM is between decisions.
  if (enemy.swing && ctx.nowMs >= enemy.swing.contactAtMs) {
    const swing = enemy.swing;
    enemy.swing = null;
    const phase = bossPhaseAt(enemy.def, enemy.hp / enemy.maxHp, enemy.phaseIndex);
    enemy.recoverUntilMs = ctx.nowMs + swing.ability.recoverMs * phase.recoverMult;
    // A charge does not RESOLVE at contact — contact is when it launches.
    if (swing.ability.kind === 'charge_rect') {
      beginCharge(enemy, swing.ability, swing.yaw, ctx);
      settleOnGround(enemy, ctx);
      return;
    }
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
      ctx.nextProjectileId,
      ctx.projectiles,
      enemy.targetId,
    );
  }

  if (ctx.nowMs < enemy.stunnedUntilMs || ctx.nowMs < enemy.rootedUntilMs || enemy.swing) {
    // Stun/root/wind-up all pin the feet; a root still lets the FSM above
    // pick attacks and turn — only the walk is denied (P6, Frost Nova).
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
      const motion = ARCHETYPE_MOTION[enemy.def.archetype];
      // The stand-off band comes from the archetype, narrowed to what this
      // enemy's kit can actually reach — a "ranged" row whose only projectile
      // flies 10 m must not hold at 15 and never fire.
      const band = standoffBand(enemy, motion.band);
      const phase = bossPhaseAt(enemy.def, enemy.hp / enemy.maxHp, enemy.phaseIndex);
      const moveSpeed = enemy.def.moveSpeed * phase.speedMult;

      if (band && dist < motion.panicMeleeRange) {
        // Cornered: stop kiting and fight. Backing away from someone already
        // in your face just feeds them free hits (§1 "panic-melee inside 3 m").
        desiredX = 0;
        desiredZ = 0;
      } else if (band && dist < band.min) {
        // Kite: reopen the band at the archetype's retreat speed.
        desiredX = -dx / dist;
        desiredZ = -dz / dist;
        speed = moveSpeed * motion.kiteSpeedMult;
      } else if (band) {
        // Hold mid-band; approach only when the target drifts out of range.
        const hold = (band.min + band.max) / 2;
        if (dist > hold) {
          desiredX = dx / dist;
          desiredZ = dz / dist;
          speed = moveSpeed;
        }
      } else if (motion.surroundRadius > 0) {
        // Swarm: head for YOUR slot on the ring, not the target's feet — six
        // Glubs form a circle instead of a queue behind one another.
        const slot = surroundSlot(
          target.movement.x,
          target.movement.z,
          enemy.surroundSlot,
          Math.max(1, ctx.packSize(enemy)),
          motion.surroundRadius,
        );
        const sx = slot.x - enemy.x;
        const sz = slot.z - enemy.z;
        const slotDist = Math.hypot(sx, sz);
        if (slotDist > 0.4) {
          desiredX = sx / slotDist;
          desiredZ = sz / slotDist;
          speed = moveSpeed;
        }
      } else {
        // Melee: stop just inside the shortest ready-ability reach.
        const desired = desiredRange(enemy);
        if (dist > desired) {
          desiredX = dx / dist;
          desiredZ = dz / dist;
          speed = moveSpeed;
        }
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

/**
 * Launch a Charger down the lane it just telegraphed. The direction is the
 * one the DECAL showed, not a fresh bearing: a charge that re-aims at release
 * would make the telegraph a lie and the sidestep pointless.
 */
const beginCharge = (
  enemy: ServerEnemy,
  ability: EnemyAbilityDef,
  yaw: number,
  ctx: AiContext,
): void => {
  const travelMs = Math.min(CHARGE_MAX_MS, (ability.chargeDistance / ability.chargeSpeed) * 1000);
  enemy.charge = {
    ability,
    dirX: Math.sin(yaw),
    dirZ: Math.cos(yaw),
    endsAtMs: ctx.nowMs + travelMs,
    lastX: enemy.x,
    lastZ: enemy.z,
    hitIds: new Set(),
  };
  enemy.yaw = yaw;
};

/**
 * One tick of a lunge: sweep the segment travelled since last tick so a fast
 * charge cannot tunnel THROUGH a player between ticks, damage each victim at
 * most once, and stop on a wall or at the end of the lane — either way into
 * the overshoot stagger, which is the whole counterplay to this archetype.
 */
const advanceCharge = (enemy: ServerEnemy, ctx: AiContext): void => {
  const charge = enemy.charge;
  if (!charge) return;
  const { ability } = charge;
  const stepX = charge.dirX * ability.chargeSpeed * ctx.dt;
  const stepZ = charge.dirZ * ability.chargeSpeed * ctx.dt;
  const nextX = enemy.x + stepX;
  const nextZ = enemy.z + stepZ;
  const walkable = ctx.terrain.walkableAt?.bind(ctx.terrain);
  const blocked = walkable !== undefined && walkable(enemy.x, enemy.z) && !walkable(nextX, nextZ);
  if (!blocked) {
    enemy.x = nextX;
    enemy.z = nextZ;
  }
  enemy.vx = blocked ? 0 : charge.dirX * ability.chargeSpeed;
  enemy.vz = blocked ? 0 : charge.dirZ * ability.chargeSpeed;

  // Sweep from where we were to where we are — the whole segment, so nobody
  // is skipped by a 14 m/s lunge crossing 0.7 m per tick.
  const victims = [...ctx.players.values()].filter(
    (player) => !player.dead && !charge.hitIds.has(player.id),
  );
  if (victims.length > 0) {
    const hit = chargeSweepHits(
      charge.lastX,
      charge.lastZ,
      enemy.x,
      enemy.z,
      ability,
      enemy,
      victims,
    );
    for (const player of hit) {
      charge.hitIds.add(player.id);
      resolveEnemySwing(
        enemy,
        // The lane already decided WHO is hit; resolve damage on each victim
        // with a point-blank arc so one code path applies mitigation/threat.
        { ...ability, kind: 'melee_arc', reach: 1.2, angleDeg: 360 },
        enemy.yaw,
        player.movement.x,
        player.movement.z,
        [player],
        ctx.nowMs,
        ctx.rng,
        ctx.events,
        undefined,
        undefined,
        player.id,
      );
    }
  }
  charge.lastX = enemy.x;
  charge.lastZ = enemy.z;

  if (blocked || ctx.nowMs >= charge.endsAtMs) {
    enemy.charge = null;
    enemy.vx = 0;
    enemy.vz = 0;
    // Overshoot: the punish window. It rides the stagger channel so the
    // client already plays the stumble and the Staggered flag already reads.
    enemy.stunnedUntilMs = Math.max(enemy.stunnedUntilMs, ctx.nowMs + ability.overshootMs);
    enemy.recoverUntilMs = Math.max(enemy.recoverUntilMs, ctx.nowMs + ability.overshootMs);
    ctx.events.push({
      type: 'entity-event',
      entityId: enemy.id,
      event: EntityEventKind.Stagger,
      a: ability.overshootMs,
      b: 0,
      c: 0,
    });
  }
};

/** Players inside the swept lane this tick (shared capsule sweep). */
const chargeSweepHits = (
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  ability: EnemyAbilityDef,
  enemy: ServerEnemy,
  players: readonly ServerPlayer[],
): ServerPlayer[] => {
  const targets = players.map((p) => ({
    x: p.movement.x,
    y: p.movement.y,
    z: p.movement.z,
    radius: PLAYER_RADIUS,
    height: PLAYER_HEIGHT,
  }));
  return dashSweepHits(fromX, enemy.y, fromZ, toX, toZ, ability.chargeWidth / 2, targets).map(
    (index) => players[index]!,
  );
};

/** Preferred combat range: just inside the shortest ready melee reach. */
const desiredRange = (enemy: ServerEnemy): number => {
  let best = 1.6;
  for (const ability of enemy.def.abilities) {
    if (ability.kind === 'melee_arc') best = Math.min(best, Math.max(ability.rangeMax - 0.4, 0.8));
  }
  return best;
};

/**
 * Where a stand-off archetype actually holds: its §1 band, clipped to the
 * reach of the kit it was given. A row tagged `ranged` whose only projectile
 * flies 10 m would otherwise hover at 15 m and never attack — the doc's band
 * is the intent, the content is the truth.
 */
const standoffBand = (
  enemy: ServerEnemy,
  band: { min: number; max: number } | null,
): { min: number; max: number } | null => {
  if (!band) return null;
  let reach = 0;
  for (const ability of enemy.def.abilities) {
    if (ability.kind === 'projectile' || ability.kind === 'ground_circle') {
      reach = Math.max(reach, ability.rangeMax);
    }
  }
  if (reach <= 0) return null; // tagged ranged but carries no ranged attack
  const max = Math.min(band.max, reach);
  return { min: Math.min(band.min, max - 1), max };
};
