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
  ATTUNEMENT_CDR_MS,
  ATTUNEMENT_EVERY,
  ATTUNEMENT_MANA_REFUND,
  GRACE_EFFECT_ID,
  GRACE_MAX_STACKS,
  GRACE_STACK_DURATION_MS,
  GRACE_TRIGGER_ABILITY,
  FOCUS_PROJECTILE_SPEED_PCT,
  HOMING_TURN_RATE_RAD_S,
  addStagger,
  applyCcDr,
  gainComboPoints,
  gainResource,
  payResource,
  arcHits,
  circleHits,
  interruptCast,
  isDodgeInvulnerable,
  rollDamage,
  sweepFirstHit,
  type AbilityDef,
  type ClassId,
  type ComboChain,
  type EnemyAbilityDef,
  type HitTarget,
  type ResolveHit,
  type Rng,
  type TerrainSampler,
} from '@dawned/shared';
import {
  FLURRY_EFFECT,
  absorbFromShields,
  applyBoltRiders,
  applyEffect,
  armorMultOf,
  attackSpeedMultOf,
  damageDealtMultOf,
  damageTakenMultOf,
  dropManaShield,
  hasCategory,
  manaShieldRateOf,
  removeEffect,
} from './effects.js';
import { playerWeaponDamage } from './items.js';
import type { ServerPlayer } from './player.js';
import type { ServerEnemy } from './enemy.js';

/**
 * Node damage multipliers vs one enemy (P7): school percent + conditional
 * bonuses (Executioner vs low HP, Frostbite vs chilled, Judgement vs
 * stunned/staggered…). Read at every player→enemy damage roll.
 */
export const nodeDamageMultVs = (
  player: ServerPlayer,
  school: 'physical' | 'magic',
  enemy: ServerEnemy,
  nowMs: number,
): number => {
  const agg = player.progress.aggregates;
  let mult =
    1 + (school === 'magic' ? agg.stats.magicDamagePct : agg.stats.physicalDamagePct) / 100;
  for (const conditional of agg.conditionals) {
    const matches =
      (conditional.vsCategories !== undefined &&
        (hasCategory(enemy, conditional.vsCategories) ||
          (conditional.vsCategories.includes('root') && nowMs < enemy.rootedUntilMs) ||
          (conditional.vsCategories.includes('stun') && nowMs < enemy.stunnedUntilMs))) ||
      (conditional.vsHpBelowPct !== undefined &&
        enemy.maxHp > 0 &&
        (enemy.hp / enemy.maxHp) * 100 < conditional.vsHpBelowPct) ||
      (conditional.vsStaggered === true && nowMs < enemy.vulnerableUntilMs) ||
      (conditional.vsStunned === true && nowMs < enemy.stunnedUntilMs);
    if (matches) mult *= 1 + conditional.pct / 100;
  }
  return mult;
};

/** Node crit additions vs one enemy: spell crit + critVs riders (Shatter). */
export const nodeCritBonusVs = (
  player: ServerPlayer,
  school: 'physical' | 'magic',
  abilityId: string | null,
  enemy: ServerEnemy,
  nowMs: number,
): number => {
  const agg = player.progress.aggregates;
  let bonus = school === 'magic' ? agg.stats.spellCritPct : 0;
  if (abilityId) {
    const modsList = agg.abilityMods.get(abilityId);
    if (modsList) {
      for (const mods of modsList) {
        const critVs = mods.critVs;
        if (!critVs) continue;
        if (
          hasCategory(enemy, critVs.categories) ||
          (critVs.categories.includes('root') && nowMs < enemy.rootedUntilMs) ||
          (critVs.categories.includes('stun') && nowMs < enemy.stunnedUntilMs)
        ) {
          bonus += critVs.pct;
        }
      }
    }
  }
  return bonus;
};

/** Everything the gateway must broadcast (or World must react to) after a tick. */
export type CombatEvent =
  | {
      type: 'ability-start';
      entityId: number;
      action: number;
      step: number;
      durationMs: number;
      yaw: number;
      /** The wind-up is an interruptible cast, not a swing (v12 Casters). */
      cast?: boolean;
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
  | { type: 'enemy-died'; enemy: ServerEnemy; killerPlayerId: number | null }
  // --- progression (P7) ----------------------------------------------------
  | {
      type: 'xp-gained';
      playerId: number;
      amount: number;
      source: number;
      xp: number;
      level: number;
    }
  | { type: 'level-up'; playerId: number; level: number }
  /** Progression state changed: gateway sends ProgressSync + persists. */
  | { type: 'progress-dirty'; playerId: number }
  /** First-time discovery: gateway persists the row + toasts the finder. */
  | {
      type: 'discovery';
      playerId: number;
      kind: 'zone' | 'codex' | 'poi' | 'shrine';
      refId: string;
      label: string;
      /** POI kind, for the banner's glyph and flourish (P11). */
      poiKind?: string;
    }
  // --- quests (P11) --------------------------------------------------------
  /** Counters moved on these quests — resend the log, bump the tracker. */
  | { type: 'quest-progress'; playerId: number; questIds: string[] }
  /** A step finished: toast its tracker line. */
  | { type: 'quest-step'; playerId: number; questId: string; text: string }
  /** Every step is behind you — "Return to Marla". */
  | { type: 'quest-complete'; playerId: number; questId: string }
  /** A quest hook asked for a line of text. */
  | { type: 'quest-toast'; playerId: number; text: string }
  /** A quest hook asked an NPC to emote. */
  | { type: 'npc-emote'; playerId: number; npcId: string; clip: string }
  /** A quest hook granted a buff; the gateway resolves the effect id. */
  | { type: 'quest-buff'; playerId: number; effectId: string; durationMs: number }
  /** Quest state changed enough to need a full QuestSync + a save. */
  | { type: 'quest-dirty'; playerId: number }
  /** Per-character interactable state changed (chest opened, shrine attuned). */
  | { type: 'interact-dirty'; playerId: number; objectId: string }
  /** A HUD line for the last interaction: a refusal, a signpost, an attune. */
  | {
      type: 'interact-notice';
      playerId: number;
      objectId: string;
      text: string;
      kind: string;
    }
  /** A quest beat worth a toast, resolved by the gateway into a QuestNotice. */
  | { type: 'quest-notice'; playerId: number; kind: string; questId: string; text: string }
  /** A quest paid out — the toast shows what landed. */
  | {
      type: 'quest-rewarded';
      playerId: number;
      questId: string;
      xp: number;
      gold: number;
      items: { itemId: string; qty: number }[];
      title: string;
    }
  /** The dialogue panel changed — resend DialogueState. */
  | { type: 'dialogue-dirty'; playerId: number }
  // --- items (P8) ----------------------------------------------------------
  /** Bag/paper-doll/purse changed — resend the authoritative sheet + persist. */
  | { type: 'inventory-dirty'; playerId: number }
  /** The set of bags this player can see changed (spawn, loot, despawn). */
  | { type: 'loot-dirty'; playerId: number }
  /** Toast-worthy bag traffic (pickup, sale, refusal) — ITEMS_LOOT.md §3. */
  | {
      type: 'item-notice';
      playerId: number;
      kind: 'picked' | 'gold' | 'sold' | 'bought' | 'full' | 'refused' | 'used' | 'equipped';
      itemId?: string;
      qty?: number;
      gold?: number;
      reason?: string;
    }
  /** A vendor panel should open/refresh (or close, when the lease broke). */
  | { type: 'vendor-panel'; playerId: number; vendorId: string; open: boolean }
  /** The paper-doll changed: re-derive stats and re-broadcast the loadout. */
  | { type: 'equipment-changed'; playerId: number }
  // --- gathering (P10) -----------------------------------------------------
  /** A gather channel opened, ended or was refused — gateway sends GatherState. */
  | {
      type: 'gather-state';
      playerId: number;
      phase: 'start' | 'done' | 'cancelled' | 'refused';
      placementId?: string;
      nodeId?: string;
      profession?: string;
      tier?: number;
      startedAtMs?: number;
      endsAtMs?: number;
      reason?: string;
      gained?: { itemId: string; qty: number }[];
      proc?: { itemId: string; qty: number } | null;
      profXp?: number;
    }
  /** Nodes changed state (taken or regrown) — whoever is near them re-syncs. */
  | { type: 'nodes-dirty'; placementIds: string[] }
  /** A profession's level/xp moved: gateway sends ProfessionSync + persists. */
  | { type: 'professions-dirty'; playerId: number }
  /** A profession leveled — worth its own toast and sound. */
  | { type: 'profession-level'; playerId: number; profession: string; level: number }
  /** SELF's fishing attempt moved — gateway sends FishingState (P10-C §5). */
  | {
      type: 'fishing-state';
      playerId: number;
      phase: 'waiting' | 'bite' | 'reeling' | 'caught' | 'escaped';
      placementId?: string;
      seed?: number;
      startedAtMs?: number;
      hookUntilMs?: number;
      driftSpeed?: number;
      markerHalf?: number;
      progress?: number;
      fish?: { itemId: string; qty: number };
      profXp?: number;
    };

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
  /** Homing bolts (P6 Barrage) steer toward this entity; 0 = straight. */
  homingTargetId: number;
  /** Slot-ability bolts carry their def id — impact applies on-hit riders. */
  abilityId: string | null;
  /** Basic-combo bolt (Mage Attunement counts these on land). */
  fromBasic: boolean;
  /** A free every-Nth follow-up (Righteous Echo) — never re-triggers itself. */
  echoBolt?: boolean;
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
  if (player.isStunned(nowMs)) {
    reject(AbilityRejectReason.BadState); // stunned: no swings (P6, §6.4)
    return;
  }

  const combo = chains[player.classId];
  // Attack-speed buffs (P7: Killer's Rhythm, Flurry) shrink every basic-step
  // duration — link windows, contact points and the broadcast all agree.
  const speedMult = attackSpeedMultOf(player);
  // Chain state: which step fires, per the shared timing rules.
  let step = 0;
  if (player.comboStep >= 0 && player.comboStartedAtMs > 0) {
    const current = combo.steps[player.comboStep]!;
    const stepMs = current.durationMs / speedMult;
    const since = nowMs - player.comboStartedAtMs;
    const linkOpensAt = stepMs * (1 - COMBO_LINK_WINDOW_FRACTION);
    if (since < linkOpensAt) {
      // Inside the swing before the link window: the press is dropped, not an
      // error — client prediction drops it identically (shared comboWindow).
      return;
    }
    if (since <= stepMs + COMBO_RESET_MS) {
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
  const stepDurationMs = Math.round(stepDef.durationMs / speedMult);
  player.comboStep = step;
  player.comboStartedAtMs = nowMs;
  player.gcdUntilMs = nowMs + GCD_MS;
  player.pendingContact = {
    step,
    atMs: nowMs + stepDurationMs * stepDef.contactFraction,
    aimYaw,
    aimPitch,
  };
  events.push({
    type: 'ability-start',
    entityId: player.id,
    action: ActionId.BasicAttack,
    step,
    durationMs: stepDurationMs,
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
 * Land hard CC on a player (P6, COMBAT.md §6.4) — THE entry point for enemy
 * stuns/roots when they arrive (P9 casters/chargers; unit-tested now). Runs
 * the diminishing-returns lanes (full → half → immune), sets the movement
 * locks the shared step enforces, and a stun breaks any cast or channel with
 * FULL cost loss + the Interrupted event so the bar shatters on screen.
 * Returns the DR verdict (tier 2 = immune, nothing landed).
 */
export const applyCcToPlayer = (
  player: ServerPlayer,
  category: 'stun' | 'root',
  durationMs: number,
  nowMs: number,
  events: CombatEvent[],
): { durationMs: number; tier: 0 | 1 | 2 } => {
  // Thick Skull / Unshakeable (P7): −X% CC duration on you, before DR.
  const ccPct = player.progress.aggregates.stats.ccOnYouDurationPct;
  const scaled = Math.max(100, Math.round(durationMs * (1 + ccPct / 100)));
  const verdict = applyCcDr(player.ccDr, category, nowMs, scaled);
  if (verdict.durationMs <= 0) return verdict;
  if (category === 'stun') {
    player.stunnedUntilMs = Math.max(player.stunnedUntilMs, nowMs + verdict.durationMs);
    const interrupted = interruptCast(player.abilityMachine, 'stun', 0);
    if (interrupted.hadCast) {
      events.push({
        type: 'entity-event',
        entityId: player.id,
        event: EntityEventKind.Interrupted,
        a: 0,
        b: 0,
        c: 0,
      });
    }
    cancelComboOnDodge(player); // a stun also wipes the basic chain
  } else {
    player.rootedUntilMs = Math.max(player.rootedUntilMs, nowMs + verdict.durationMs);
  }
  return verdict;
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
  const weapon = playerWeaponDamage(player);
  // Node folds (P7): school % rides the fire-time multiplier for bolts;
  // melee rolls use nodeDamageMultVs (school + per-target conditionals).
  const nodeAgg = player.progress.aggregates;
  const schoolPct =
    combo.school === 'magic' ? nodeAgg.stats.magicDamagePct : nodeAgg.stats.physicalDamagePct;
  const dealtMult =
    (nowMs < player.dawnedUntilMs ? 1 - DAWNED_DAMAGE_PENALTY : 1) * damageDealtMultOf(player);
  const rewind = rewindTicksFor(player.rttMs);
  // Flurry (P7 capstone): empowered basics grant a CP each and count down;
  // the visible speed buff drops with the last empowered swing.
  if (player.empoweredBasicsLeft > 0) {
    player.empoweredBasicsLeft -= 1;
    if (player.classId === 'rogue' && player.empoweredBasicsCp > 0) {
      gainComboPoints(player.resource, player.empoweredBasicsCp);
    }
    if (player.empoweredBasicsLeft === 0) removeEffect(player, FLURRY_EFFECT);
  }

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
      // Mage Focus (P6): held RMB tightens the spell — bolts fly faster.
      speed: combo.projectile.speed * (player.focusing ? 1 + FOCUS_PROJECTILE_SPEED_PCT / 100 : 1),
      radius: combo.projectile.radius,
      travelled: 0,
      maxRange: combo.projectile.maxRange,
      coef: stepDef.coef,
      school: combo.school,
      power: combo.school === 'magic' ? player.stats.sp : player.stats.ap,
      weaponMin: weapon.min,
      weaponMax: weapon.max,
      // Spell crit folds at IMPACT via nodeCritBonusVs (never both places).
      critPct: player.stats.critPct,
      attackerLevel: player.level,
      damageDealtMult: dealtMult * (1 + schoolPct / 100),
      stagger: stepDef.stagger,
      homingTargetId: 0,
      abilityId: null,
      fromBasic: true,
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
        critPct: player.stats.critPct + (combo.school === 'magic' ? nodeAgg.stats.spellCritPct : 0),
        attackerLevel: player.level,
        targetLevel: enemy.level,
        targetArmor: enemy.armor,
        targetMagicResistPct: enemy.magicResistPct,
        damageTakenMult: takenMult * damageTakenMultOf(enemy, player.id),
        // School % + per-target conditionals (Executioner, Flensing…) — P7.
        damageDealtMult: dealtMult * nodeDamageMultVs(player, combo.school, enemy, nowMs),
      },
      rng,
    );
    hits.push(
      applyDamageToEnemy(enemy, player.id, player, amount, crit, stepDef.stagger, nowMs, events),
    );
  }
  // Resource riders per landed step (CLASSES.md §0/§3): Rage per basic hit
  // (+ Boiling Blood's node delta), the Rogue combo point on step 3 —
  // content-declared, applied on contact.
  if (hits.length > 0) {
    const rageGain =
      stepDef.rageGain + (player.classId === 'warrior' ? nodeAgg.stats.rageOnBasicHitDelta : 0);
    if (rageGain > 0 && player.resource.type === 'rage') {
      gainResource(player.resource, rageGain, true);
    }
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
  // Absorbs intercept before HP, exactly as they do for players (P6) — an
  // enemy self-shield (P9) is the same pool drained by the same function, so
  // "burst it down or wait it out" behaves identically on both sides of a
  // fight. Threat and the kill-credit ledger still count the FULL swing: you
  // are not punished on aggro or tag for hitting a shield.
  const absorbed = absorbFromShields(enemy, amount);
  enemy.hp = Math.max(0, enemy.hp - (amount - absorbed));
  enemy.lastDamagedAtMs = nowMs;
  enemy.addThreat(attackerId, amount);
  if (attacker) {
    attacker.lastCombatAtMs = nowMs;
    // Kill-credit ledger (P7 tag rule): raw damage per player this fight.
    enemy.damageBy.set(attackerId, (enemy.damageBy.get(attackerId) ?? 0) + amount);
  }

  let flags = 0;
  if (crit) flags |= HitFlag.Crit;
  // Fully eaten by the shield: the FCT says "absorbed" instead of a number
  // that never left the bar (v8's flag, now on the enemy side too).
  if (absorbed >= amount) flags |= HitFlag.Absorbed;

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
  abilityDefs: ReadonlyMap<string, AbilityDef> | null = null,
  /** Id allocator for bolts spawned DURING the step (P7 echo bolts). */
  nextProjectileId: (() => number) | null = null,
): void => {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i]!;

    // Homing bolts (P6 Barrage) bend toward their target's chest with a
    // capped turn rate — dodgeable by breaking the line late, never a
    // guaranteed hit. A dead/despawned target lets the bolt fly straight.
    if (p.homingTargetId > 0 && p.ownerKind === 'player') {
      const target = enemies.get(p.homingTargetId);
      if (target && target.alive && !target.invulnerable) {
        const tx = target.x - p.x;
        const ty = target.y + target.def.hitHeight * 0.6 - p.y;
        const tz = target.z - p.z;
        const len = Math.hypot(tx, ty, tz);
        if (len > 0.01) {
          const maxTurn = HOMING_TURN_RATE_RAD_S * dt;
          const dot = Math.max(-1, Math.min(1, (p.dirX * tx + p.dirY * ty + p.dirZ * tz) / len));
          const angle = Math.acos(dot);
          const t = angle > 1e-4 ? Math.min(1, maxTurn / angle) : 1;
          const nx = p.dirX + (tx / len - p.dirX) * t;
          const ny = p.dirY + (ty / len - p.dirY) * t;
          const nz = p.dirZ + (tz / len - p.dirZ) * t;
          const nlen = Math.hypot(nx, ny, nz) || 1;
          p.dirX = nx / nlen;
          p.dirY = ny / nlen;
          p.dirZ = nz / nlen;
        }
      }
    }

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
            false, // ranged: melee-only retaliation procs stay quiet
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
      const owner = players.get(p.ownerId) ?? null;
      // The OWNER'S node-rewritten def governs impact riders (P7) — the
      // authored def only if they are gone or unmodified.
      const boltDef =
        p.abilityId && abilityDefs
          ? (owner?.progress.effectiveDefs.get(p.abilityId) ?? abilityDefs.get(p.abilityId))
          : undefined;
      // Conditional bonus at IMPACT state (Ice Lance vs chilled/rooted): the
      // status check happens when the bolt lands, not when it left the hand.
      const boltDamage = boltDef?.effects.find(
        (effect): effect is Extract<AbilityDef['effects'][number], { kind: 'damage' }> =>
          effect.kind === 'damage',
      );
      const bonusMult =
        boltDamage?.bonusVs &&
        (hasCategory(enemy, boltDamage.bonusVs.categories) ||
          (boltDamage.bonusVs.categories.includes('root') && nowMs < enemy.rootedUntilMs) ||
          (boltDamage.bonusVs.categories.includes('stun') && nowMs < enemy.stunnedUntilMs))
          ? 1 + boltDamage.bonusVs.pct / 100
          : 1;
      // Node conditionals + crit-vs riders read the impact state too (P7:
      // Frostbite, Shatter). School % was folded at fire time.
      const conditionalMult = owner
        ? nodeDamageMultVs(owner, p.school, enemy, nowMs) /
          (1 +
            (p.school === 'magic'
              ? owner.progress.aggregates.stats.magicDamagePct
              : owner.progress.aggregates.stats.physicalDamagePct) /
              100)
        : 1;
      const critVsBonus = owner ? nodeCritBonusVs(owner, p.school, p.abilityId, enemy, nowMs) : 0;
      const { amount, crit } = rollDamage(
        {
          coef: p.coef,
          weaponMin: p.weaponMin,
          weaponMax: p.weaponMax,
          power: p.power,
          school: p.school,
          critPct: p.critPct + critVsBonus,
          attackerLevel: p.attackerLevel,
          targetLevel: enemy.level,
          targetArmor: enemy.armor,
          targetMagicResistPct: enemy.magicResistPct,
          damageTakenMult: takenMult * damageTakenMultOf(enemy, p.ownerId),
          damageDealtMult: p.damageDealtMult * bonusMult * conditionalMult,
        },
        rng,
      );
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
      // On-hit riders ride the bolt (P6): Fireball's burn, Ice Lance's chill.
      if (boltDef && enemy.hp > 0) {
        applyBoltRiders(
          boltDef,
          enemy,
          {
            casterId: p.ownerId,
            casterLevel: p.attackerLevel,
            power: p.power,
            weaponMin: p.weaponMin,
            weaponMax: p.weaponMax,
            damageDealtMult: p.damageDealtMult,
          },
          nowMs,
        );
        // Category-gated node appends (P7, Winter's Grasp): the extra
        // apply_effect lands only when the target bears the gate category
        // AT IMPACT — checked against the pre-impact state is fine because
        // the gate category (chill) comes from earlier hits.
        if (owner && p.abilityId) {
          const modsList = owner.progress.aggregates.abilityMods.get(p.abilityId);
          for (const mods of modsList ?? []) {
            const gate = mods.addEffectsRequireCategories;
            if (!mods.addEffects || !gate) continue;
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
                  casterId: p.ownerId,
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
      }
      // Class passives keyed to landed bolts (P6; P7 node tweaks fold in):
      if (owner && !owner.dead) {
        if (p.fromBasic && owner.classId === 'mage') {
          // Attunement: every 3rd landed basic bolt refunds Mana and shaves
          // active cooldowns. Swift Recovery (P7) raises the refund. The
          // client mirrors the count from its own resolve events for display;
          // the server number is authoritative.
          owner.attunementCount += 1;
          if (owner.attunementCount >= ATTUNEMENT_EVERY) {
            owner.attunementCount = 0;
            gainResource(
              owner.resource,
              ATTUNEMENT_MANA_REFUND + owner.progress.aggregates.passives.attunementManaDelta,
              true,
            );
            for (const [, slot] of owner.abilityMachine.slots) {
              if (slot.rechargeAtMs > 0) {
                slot.rechargeAtMs = Math.max(nowMs, slot.rechargeAtMs - ATTUNEMENT_CDR_MS);
              }
            }
          }
        }
        if (owner.classId === 'cleric' && p.abilityId === GRACE_TRIGGER_ABILITY) {
          // Grace: Smite hits bank cast-time off the next Mend (stacks 3).
          applyEffect(
            owner,
            {
              effectId: GRACE_EFFECT_ID,
              casterId: owner.id,
              durationMs: GRACE_STACK_DURATION_MS,
              stacksMax: GRACE_MAX_STACKS,
              mods: {},
              harmful: false,
            },
            nowMs,
          );
        }
        // Righteous Echo-style riders (P7): every Nth landed bolt of the
        // ability fires a FREE follow-up from the caster's hand at the
        // struck target, reduced coef, no riders of its own.
        if (p.abilityId && !p.echoBolt && nextProjectileId && enemy.hp > 0) {
          const modsList = owner.progress.aggregates.abilityMods.get(p.abilityId);
          for (const mods of modsList ?? []) {
            const echo = mods.everyNBonusBolt;
            if (!echo) continue;
            const count = (owner.progress.boltCounters.get(p.abilityId) ?? 0) + 1;
            if (count < echo.n) {
              owner.progress.boltCounters.set(p.abilityId, count);
              continue;
            }
            owner.progress.boltCounters.set(p.abilityId, 0);
            const ox = owner.movement.x;
            const oy = owner.movement.y + 1.4;
            const oz = owner.movement.z;
            const tx = enemy.x - ox;
            const ty = enemy.y + enemy.def.hitHeight * 0.6 - oy;
            const tz = enemy.z - oz;
            const len = Math.hypot(tx, ty, tz) || 1;
            const bonus: ServerProjectile = {
              ...p,
              id: nextProjectileId(),
              x: ox,
              y: oy,
              z: oz,
              dirX: tx / len,
              dirY: ty / len,
              dirZ: tz / len,
              coef: echo.coef,
              travelled: 0,
              maxRange: Math.max(10, len + 6),
              abilityId: null, // no on-hit riders, no re-echo
              echoBolt: true,
            };
            projectiles.push(bonus);
            events.push({
              type: 'projectile-spawn',
              projectileId: bonus.id,
              ownerId: bonus.ownerId,
              x: bonus.x,
              y: bonus.y,
              z: bonus.z,
              dirX: bonus.dirX,
              dirY: bonus.dirY,
              dirZ: bonus.dirZ,
              speed: bonus.speed,
              visual: owner.classId === 'cleric' ? 1 : 0,
            });
          }
        }
      }
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
  /** Melee contact (false = projectile) — thorns/Glacial procs are melee-only. */
  melee = true,
): ResolveHit | null => {
  if (player.dead) return null;
  // I-frames count live AND in the victim's rewound time — the roll they
  // saw on their own screen protects them (NETWORKING.md §4). The OR is
  // deliberately player-favorable; PvE softens the fairness stakes.
  const invulnerable =
    isDodgeInvulnerable(player.movement) ||
    player.history.wasInvulnerable(rewindTicksFor(player.rttMs));
  if (invulnerable) return null;

  const nodeAgg = player.progress.aggregates;
  // RMB block (CLASSES.md): frontal hits are mitigated while the shield is
  // up and stamina can pay for the absorb; a hit inside the raise window is
  // a PERFECT block — the attacker staggers open, the Warrior gains Rage.
  // P7 stance nodes fold here: Stalwart Block's cheaper absorbs, Shield
  // Training's extra mitigation, Immovable's perfect-block refund.
  let blockMult = 1;
  let blocked = false;
  const mitigationPct =
    player.classId === 'warrior' || player.classId === 'cleric'
      ? Math.min(90, BLOCK_MITIGATION_PCT[player.classId] + nodeAgg.stance.blockMitigationDelta)
      : undefined;
  if (player.blocking && mitigationPct !== undefined) {
    const toSource = Math.atan2(sourceX - player.movement.x, sourceZ - player.movement.z);
    let facingDelta = toSource - player.movement.yaw;
    while (facingDelta > Math.PI) facingDelta -= 2 * Math.PI;
    while (facingDelta < -Math.PI) facingDelta += 2 * Math.PI;
    const frontal = Math.abs(facingDelta) <= ((BLOCK_ARC_DEG / 2) * Math.PI) / 180;
    const blockStamina = Math.max(
      1,
      Math.round(BLOCK_STAMINA_PER_HIT * (1 + nodeAgg.stance.blockStaminaCostPct / 100)),
    );
    if (frontal && player.movement.stamina >= blockStamina) {
      blockMult = 1 - mitigationPct / 100;
      blocked = true;
      player.movement.stamina -= blockStamina;
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
        if (nodeAgg.stance.perfectBlockStaminaRefund > 0) {
          player.movement.stamina = Math.min(
            player.movement.maxStamina,
            player.movement.stamina + nodeAgg.stance.perfectBlockStaminaRefund,
          );
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
      // Effect armor buffs ×stacks (Colossus, Beacon) on the sheet armor.
      targetArmor: player.stats.armor * armorMultOf(player),
      targetMagicResistPct: player.stats.magicResistPct,
      damageTakenMult:
        damageTakenMultOf(player, enemy.id) * blockMult * (1 + nodeAgg.stats.damageTakenPct / 100),
      damageDealtMult: damageDealtMultOf(enemy),
    },
    rng,
  );
  // Absorbs intercept before HP (P6): pooled shields (Aegis) drain first,
  // then Mana Shield converts what's left at its mana-per-point rate. A
  // shield hit still counts as combat (regen gating) but never flinches.
  let remaining = amount;
  const shielded = absorbFromShields(player, remaining);
  remaining -= shielded;
  if (remaining > 0) {
    const manaRate = manaShieldRateOf(player);
    if (manaRate !== null && player.resource.type === 'mana') {
      const absorbable = Math.floor(player.resource.value / manaRate);
      const manaAbsorb = Math.min(remaining, absorbable);
      if (manaAbsorb > 0) {
        payResource(player.resource, manaAbsorb * manaRate);
        remaining -= manaAbsorb;
      }
      if (player.resource.value < manaRate) dropManaShield(player); // ran dry
    }
  }
  const absorbed = amount - remaining;

  player.hp = Math.max(0, player.hp - remaining);
  player.lastCombatAtMs = nowMs;
  if (player.classId === 'warrior' && player.hp > 0) {
    gainResource(
      player.resource,
      RAGE_ON_DAMAGED + nodeAgg.stats.rageWhenHitDelta, // Enraging Defense (P7)
      true,
    );
  }
  // Retaliation procs (P7): thorns for melee attackers and blocked hits,
  // Glacial Armor's chill on whoever swings into you. Deterministic damage
  // through the real enemy pipeline (threat + kill credit included).
  if (player.hp > 0 && enemy.alive && !enemy.invulnerable) {
    const avgWeapon = (player.stats.ap + player.stats.sp) / 2;
    for (const entry of player.progress.aggregates.procs) {
      const proc = entry.proc;
      if (proc.proc === 'melee_thorns' && melee) {
        const thorns = Math.max(1, Math.round(proc.coef * (avgWeapon + player.stats.sp)));
        const hit = applyDamageToEnemy(enemy, player.id, player, thorns, false, 0, nowMs, events);
        events.push({
          type: 'ability-resolve',
          attackerId: player.id,
          action: 0,
          step: 0,
          hits: [hit],
        });
      } else if (proc.proc === 'block_thorns' && blocked) {
        const thorns = Math.max(1, Math.round(proc.coef * (avgWeapon + player.stats.ap)));
        const hit = applyDamageToEnemy(enemy, player.id, player, thorns, false, 0, nowMs, events);
        events.push({
          type: 'ability-resolve',
          attackerId: player.id,
          action: 0,
          step: 0,
          hits: [hit],
        });
      } else if (proc.proc === 'melee_attacker_apply' && melee) {
        applyEffect(
          enemy,
          {
            effectId: proc.effectId,
            casterId: player.id,
            durationMs: proc.durationMs,
            stacksMax: 1,
            mods: proc.mods,
            harmful: true,
            category: proc.category,
          },
          nowMs,
        );
      }
    }
  }
  if (player.hp <= 0) {
    events.push({ type: 'player-died', playerId: player.id, killerEnemyId: enemy.id });
  } else if (remaining > 0) {
    events.push({
      type: 'entity-event',
      entityId: player.id,
      event: EntityEventKind.Flinch,
      a: 0,
      b: 0,
      c: 0,
    });
  }
  let flags = 0;
  if (player.hp <= 0) flags |= HitFlag.Killed;
  if (absorbed > 0) flags |= HitFlag.Absorbed;
  return { targetId: player.id, amount: remaining, flags };
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
  /** Origin height for the vertical hit tolerance (a placed pool sits at the
   * target's ground, not the caster's). */
  swingY: number,
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
      homingTargetId: 0,
      abilityId: null,
      fromBasic: false,
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

  // The self-shield spends its wind-up buying an absorb pool, not a hit. It
  // rides the SAME effect list players' shields do, so it drains through
  // `absorbFromShields`, syncs to viewers as a shield chip, and can be waited
  // out — a boss that hardens forever is an HP bar, not a beat.
  if (ability.kind === 'self_shield') {
    applyEffect(
      enemy,
      {
        effectId: `enemy_shield_${ability.id}`,
        casterId: enemy.id,
        durationMs: ability.shieldDurationMs,
        stacksMax: 1,
        mods: {},
        harmful: false,
        category: 'buff',
        shieldPool: Math.round((enemy.maxHp * ability.shieldPct) / 100),
      },
      nowMs,
    );
    events.push({ type: 'ability-resolve', attackerId: enemy.id, action: 0, step: 0, hits: [] });
    return;
  }

  const targets: HitTarget[] = players.map((p) => ({
    x: p.movement.x,
    y: p.movement.y,
    z: p.movement.z,
    radius: PLAYER_RADIUS,
    height: PLAYER_HEIGHT,
  }));
  // A ground circle tests the DECAL the player was shown: same centre (where
  // the pool was placed at wind-up start), same radius. Testing an arc here
  // instead would make the decal a lie, which COMBAT.md §5 forbids. No target
  // cap either — a telegraphed pool is supposed to catch everyone who stayed
  // in it; that IS the mechanic, and the cap exists for untelegraphed swings.
  const hitIndices =
    ability.kind === 'ground_circle'
      ? circleHits(swingX, swingY, swingZ, ability.circleRadius, targets)
      : arcHits(
          swingX,
          swingY,
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
