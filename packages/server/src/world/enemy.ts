/**
 * An enemy entity in the authoritative world (NPCS_ENEMIES.md §1–§2).
 *
 * Enemies are entirely server-owned: clients receive their positions in
 * snapshots, their identity once via EnemyMeta, and their actions as events.
 * The AI lives in enemy-ai.ts; this is the state it drives.
 */

import {
  createStaggerState,
  enemyStats,
  RANK_STAGGER_GAIN,
  type EnemyAbilityDef,
  type EnemyDef,
  type StaggerState,
} from '@dawned/shared';
import { PositionHistory } from './history.js';
import type { ActiveEffect } from './effects.js';

export type EnemyFsmState = 'idle' | 'alert' | 'combat' | 'return' | 'dead';

/** A wound-up attack that resolves at `contactAtMs` unless interrupted. */
export interface PendingSwing {
  ability: EnemyAbilityDef;
  contactAtMs: number;
  /** Aim captured at wind-up start (heavies telegraph THIS, not tracking). */
  yaw: number;
  x: number;
  z: number;
}

export class ServerEnemy {
  // Live transform (server truth; enemies never predict).
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx = 0;
  vz = 0;

  hp: number;
  readonly maxHp: number;
  readonly swingDamage: number;
  readonly armor: number;
  readonly magicResistPct: number;

  state: EnemyFsmState = 'idle';
  /** Wall-clock ms when the current state was entered. */
  stateSinceMs = Date.now();
  /** Threat table: entity id → accumulated threat (COMBAT.md §6.5). */
  readonly threat = new Map<number, number>();
  targetId: number | null = null;
  /** Alert beat target (the player who tripped perception). */
  alertTargetId: number | null = null;

  readonly stagger: StaggerState = createStaggerState();
  readonly staggerGainFactor: number;
  /** Staggered (HitReact stun) until this wall-clock ms. */
  stunnedUntilMs = 0;
  /** +10% damage taken until this wall-clock ms (the stagger payoff window). */
  vulnerableUntilMs = 0;

  /** Per-ability cooldown expiry, keyed by ability id. */
  readonly cooldowns = new Map<string, number>();
  swing: PendingSwing | null = null;
  /** No decisions until this ms (post-swing recovery, alert beat…). */
  recoverUntilMs = 0;

  /** 20 s without a valid target in COMBAT forces a leash (NPCS_ENEMIES §2). */
  lastValidTargetAtMs = 0;
  /** Last time this enemy took damage (dummy reset + damage-aggro timing). */
  lastDamagedAtMs = 0;
  /** Corpse timer: despawn + respawn ticket at this ms (dead state). */
  despawnAtMs = 0;

  // --- P5 ability interactions --------------------------------------------
  /** Live debuffs (EffectHost contract — world/effects.ts). */
  effects: ActiveEffect[] = [];
  effectsDirty = false;
  /** Forced target from a Taunt (COMBAT.md §6.5) until this ms. */
  tauntedById: number | null = null;
  tauntedUntilMs = 0;

  readonly history = new PositionHistory();

  constructor(
    readonly id: number,
    readonly def: EnemyDef,
    readonly level: number,
    /** The spawner that owns the respawn ticket for this entity. */
    readonly spawnerId: string,
    /** Camp tag for social aggro (spawner's, falling back to the def's). */
    readonly campTag: string | null,
    /** Home = where it stands guard and leashes back to. */
    readonly homeX: number,
    readonly homeY: number,
    readonly homeZ: number,
  ) {
    this.x = homeX;
    this.y = homeY;
    this.z = homeZ;
    this.yaw = 0;
    const stats = enemyStats(level, def.archetype, def.rank);
    this.maxHp = def.statOverrides.maxHp ?? stats.maxHp;
    this.swingDamage = def.statOverrides.swingDamage ?? stats.swingDamage;
    this.armor = def.statOverrides.armor ?? stats.armor;
    this.magicResistPct = def.statOverrides.magicResistPct ?? stats.magicResistPct;
    this.hp = this.maxHp;
    this.staggerGainFactor = RANK_STAGGER_GAIN[def.rank];
  }

  get alive(): boolean {
    return this.state !== 'dead';
  }

  /** Invulnerable during the leash RETURN sprint (NPCS_ENEMIES §2). */
  get invulnerable(): boolean {
    return this.state === 'return';
  }

  addThreat(entityId: number, amount: number): void {
    this.threat.set(entityId, (this.threat.get(entityId) ?? 0) + amount);
  }

  topThreat(): number | null {
    let best: number | null = null;
    let bestValue = -Infinity;
    for (const [id, value] of this.threat) {
      if (value > bestValue) {
        best = id;
        bestValue = value;
      }
    }
    return best;
  }

  enterState(state: EnemyFsmState, nowMs: number): void {
    this.state = state;
    this.stateSinceMs = nowMs;
  }

  /**
   * Player-inflicted control (Shield Bash stun, Earthshatter knockdown):
   * rides the stagger-stun channel — the FSM already freezes and the client
   * already plays the full-body react on the Staggered flag.
   */
  stunFor(durationMs: number, nowMs: number): void {
    if (this.state === 'dead' || this.invulnerable) return;
    this.stunnedUntilMs = Math.max(this.stunnedUntilMs, nowMs + durationMs);
    this.swing = null; // a stun always interrupts the wind-up
  }

  /** Interrupt effect: cancel the current wind-up, brief recover. */
  interruptSwing(nowMs: number): void {
    if (this.swing) {
      this.swing = null;
      this.recoverUntilMs = Math.max(this.recoverUntilMs, nowMs + 600);
    }
  }

  /** Taunt: forced target + top-threat override (COMBAT.md §6.5). */
  tauntBy(playerId: number, durationMs: number, nowMs: number): void {
    if (this.state === 'dead' || this.invulnerable) return;
    this.tauntedById = playerId;
    this.tauntedUntilMs = nowMs + durationMs;
    const top = Math.max(0, ...this.threat.values());
    this.threat.set(playerId, top * 1.2 + 10);
    this.targetId = playerId;
  }

  /** Full reset on leash-home or respawn: heal, wipe, stand down. */
  resetToHome(nowMs: number): void {
    this.hp = this.maxHp;
    this.threat.clear();
    this.targetId = null;
    this.alertTargetId = null;
    this.swing = null;
    this.cooldowns.clear();
    this.stagger.meter = 0;
    this.stunnedUntilMs = 0;
    this.vulnerableUntilMs = 0;
    this.recoverUntilMs = 0;
    this.effects = [];
    this.effectsDirty = true;
    this.tauntedById = null;
    this.tauntedUntilMs = 0;
    this.vx = 0;
    this.vz = 0;
    this.enterState('idle', nowMs);
  }
}
