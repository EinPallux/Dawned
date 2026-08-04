/**
 * Canonical constants shared by client and server.
 *
 * Anything both sides must agree on numerically lives here — never duplicated in
 * either package. Design sources: docs/design/COMBAT.md, docs/tech/NETWORKING.md.
 */

/** Server simulation rate (docs/tech/NETWORKING.md §1). */
export const TICK_RATE = 20;
/** Fixed simulation step in milliseconds. */
export const TICK_MS = 1000 / TICK_RATE;
/** Fixed simulation step in seconds. */
export const TICK_DT = TICK_MS / 1000;

// Note: there is no separate input-send-rate constant — the client sends exactly
// one InputIntent per predicted simulation tick (TICK_RATE), which is what makes
// reconciliation replay exact (docs/tech/NETWORKING.md §1/§3).

/** Remote-entity interpolation delay in ms (2 snapshots buffered). */
export const INTERP_DELAY_MS = 100;

/** How many ticks of position history the server keeps for lag compensation. */
export const REWIND_HISTORY_TICKS = 32;
/** Maximum rewind the server will honour (docs/tech/NETWORKING.md §1). */
export const MAX_REWIND_MS = 250;

/** Seconds a disconnected character lingers in the world before despawn. */
export const DISCONNECT_GRACE_MS = 15_000;

// ---------------------------------------------------------------------------
// Movement (docs/design/COMBAT.md §2, §7)
// ---------------------------------------------------------------------------

/** Base jog speed in m/s. */
export const MOVE_SPEED = 5.5;
/** Sprint multiplier applied to MOVE_SPEED. */
export const SPRINT_MULTIPLIER = 1.35;
/** Ground acceleration in m/s². */
export const MOVE_ACCEL = 40;
/** Ground deceleration in m/s² when no input is held. */
export const MOVE_DECEL = 50;
/** Air control factor (fraction of ground acceleration while airborne). */
export const AIR_CONTROL = 0.35;
/** Gravity in m/s². */
export const GRAVITY = 24;
/**
 * Max height a grounded character steps DOWN in one tick while staying glued
 * to the ground. Covers the steepest walkable slope at sprint speed
 * (tan 50° × 7.4 m/s × 0.05 s ≈ 0.44 m); a bigger drop is a real fall.
 * Without this, every downhill tick goes "airborne" for one step and the
 * grounded state (and its animations) flicker at walking pace.
 */
export const GROUND_SNAP_M = 0.5;
/** Vertical impulse on jump in m/s (≈1.1 m apex). */
export const JUMP_VELOCITY = 7.27;
/** Terminal downward speed in m/s. */
export const TERMINAL_VELOCITY = 55;

/** Base stamina pool at level 1 with 0 allocated END. */
export const BASE_STAMINA = 100;
/** Stamina drained per second while sprinting. */
export const SPRINT_STAMINA_PER_SEC = 8;
/** Swim-sprint drains faster than land sprint (docs/design/COMBAT.md §7). */
export const SWIM_SPRINT_STAMINA_PER_SEC = 10;
/** Stamina regenerated per second once the regen delay has elapsed. */
export const STAMINA_REGEN_PER_SEC = 15;
/** Delay in ms after spending stamina before regeneration resumes. */
export const STAMINA_REGEN_DELAY_MS = 1000;
/** Minimum stamina required to begin sprinting (prevents stutter-sprint). */
export const SPRINT_MIN_STAMINA = 5;

/** Fall damage begins beyond this drop height in metres (docs/design/COMBAT.md §2). */
export const FALL_DAMAGE_MIN_HEIGHT = 12;
/** Fraction of max HP lost per metre beyond FALL_DAMAGE_MIN_HEIGHT. */
export const FALL_DAMAGE_PER_METRE = 0.06;
/** Hard cap on fall damage as a fraction of max HP — a full-HP fall is survivable. */
export const FALL_DAMAGE_MAX_FRACTION = 0.95;

// ---------------------------------------------------------------------------
// Dodge roll (docs/design/COMBAT.md §7 — "the single most important button")
// ---------------------------------------------------------------------------

/** Roll duration in seconds. */
export const DODGE_DURATION_S = 0.55;
/** Ground covered by a full roll in metres (speed = distance / duration). */
export const DODGE_DISTANCE_M = 4.2;
/** Invulnerability window inside the roll, seconds from roll start. */
export const DODGE_IFRAME_START_S = 0.05;
export const DODGE_IFRAME_END_S = 0.35;
/** Flat stamina cost per roll. */
export const DODGE_STAMINA_COST = 25;
/** Internal cooldown between rolls, from roll START, in ms. */
export const DODGE_COOLDOWN_MS = 500;

// ---------------------------------------------------------------------------
// Combat (docs/design/COMBAT.md §3–§7; numbers admin-editable from P5/A1)
// ---------------------------------------------------------------------------

/** Global cooldown between ability activations in ms (COMBAT.md §12). */
export const GCD_MS = 400;
/** A broken combo chain resets this long after the last step ended, in ms. */
export const COMBO_RESET_MS = 600;
/** Link window: pressing LMB inside the last fraction of a step chains the next. */
export const COMBO_LINK_WINDOW_FRACTION = 0.4;
/** Melee-arc hits affect at most this many targets (COMBAT.md §5 default cap). */
export const MELEE_TARGET_CAP = 5;
/** Vertical tolerance for hit shapes — capsule overlap beyond this is a miss. */
export const HIT_VERTICAL_TOLERANCE_M = 2.5;
/** Soft-target projectile magnetism cap in degrees (COMBAT.md §1). */
export const PROJECTILE_MAGNETISM_DEG = 4;

/** Enemy stagger meter threshold (COMBAT.md §6.4). */
export const STAGGER_THRESHOLD = 100;
/** Full-body HitReact stun when the meter fills, in ms. */
export const STAGGER_STUN_MS = 1200;
/** Extra damage taken while recently staggered (the payoff window). */
export const STAGGER_VULNERABILITY = 0.1;
/** Vulnerability window length from stagger trigger, in ms (covers the stun + a beat). */
export const STAGGER_VULNERABILITY_MS = 2500;
/** Meter decay per second once gains have paused (see stagger.ts note). */
export const STAGGER_DECAY_PER_S = 15;
/** Gap without stagger gain before decay starts, in ms. */
export const STAGGER_DECAY_DELAY_MS = 2500;

/** Out-of-combat threshold: no damage given or taken for this long (COMBAT.md §6.6). */
export const OOC_AFTER_MS = 5000;
/** Out-of-combat HP regeneration, fraction of max per second. */
export const OOC_HP_REGEN_PER_S = 0.08;

/** Death penalty: the "Dawned" debuff (COMBAT.md §10). */
export const DAWNED_DAMAGE_PENALTY = 0.15;
export const DAWNED_DURATION_MS = 30_000;

/** Crit multiplier (PROGRESSION.md §2 CritDmg 150%). */
export const CRIT_MULTIPLIER = 1.5;
/** Damage/heal variance, ± fraction, uniform (COMBAT.md §6.2 anti-metronome). */
export const DAMAGE_VARIANCE = 0.05;

/**
 * Tolerance multiplier applied to the server's per-tick displacement cap before a
 * movement request is treated as anomalous (docs/tech/SECURITY.md §2).
 */
export const MOVE_VALIDATION_TOLERANCE = 1.15;

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/** Terrain/AOI cell size in metres. */
export const CHUNK_SIZE = 64;
/** Half-extent of the playable world in metres (world spans -BOUNDS..+BOUNDS). */
export const WORLD_BOUNDS = 1024;
/** Sea level height in metres. */
export const SEA_LEVEL = 0;
/** Water deeper than this over the ground is swum, not waded (docs/design/WORLD.md). */
export const SWIM_DEPTH = 1.2;
/** Horizontal speed multiplier while swimming (surface swim, GAME_DESIGN §"Movement"). */
export const SWIM_SPEED_FACTOR = 0.55;
/** How far the body sits below the water surface while swimming. */
export const SWIM_SURFACE_OFFSET = 0.55;
/**
 * The active map artifact version under assets_baked/map/ (client fetches it
 * from /assets/map/<version>/). Becomes dynamic when the admin publish
 * pipeline lands (A2) — until then both sides agree through this constant.
 */
export const MAP_VERSION = 'dev-2';

/** Player capsule radius in metres. */
export const PLAYER_RADIUS = 0.35;
/** Player capsule height in metres. */
export const PLAYER_HEIGHT = 1.8;

// ---------------------------------------------------------------------------
// Class resources (P5 — CLASSES.md §0; all admin-tunable at heart, constants
// until the balance sliders land in world settings)
// ---------------------------------------------------------------------------

/** Rage caps at 100; builds only IN combat, decays out of it. */
export const RAGE_MAX = 100;
/** Rage gained when the Warrior takes a hit (in combat). */
export const RAGE_ON_DAMAGED = 5;
/** Rage decay per second while OUT of combat. */
export const RAGE_DECAY_PER_S = 2;

/** Energy pool (Rogue). Regens always, combat or not. */
export const ENERGY_MAX = 100;
export const ENERGY_REGEN_PER_S = 12;

/** Combo points (Rogue): 0..5, spent whole by finishers. */
export const COMBO_POINTS_MAX = 5;

/** Mana pool = MANA_BASE + MANA_PER_INT × INT (Mage/Cleric, kits at P6). */
export const MANA_BASE = 100;
export const MANA_PER_INT = 10;
/** Mana regen as % of pool per second. */
export const MANA_REGEN_PCT_OOC = 4;
export const MANA_REGEN_PCT_COMBAT = 1.5;

// ---------------------------------------------------------------------------
// RMB class actions (held stances — CLASSES.md per-class RMB)
// ---------------------------------------------------------------------------

/** Frontal arc that counts as "blocked" while holding RMB block (degrees). */
export const BLOCK_ARC_DEG = 120;
/** Damage reduction while blocking: Warrior / Cleric (percent). */
export const BLOCK_MITIGATION_PCT = { warrior: 60, cleric: 40 } as const;
/** Stamina drained per absorbed (blocked) hit. */
export const BLOCK_STAMINA_PER_HIT = 12;
/** Perfect block: absorbing inside this window after raising the shield. */
export const PERFECT_BLOCK_WINDOW_MS = 200;
/** Perfect block rewards: attacker staggered, defender gains Rage (Warrior). */
export const PERFECT_BLOCK_RAGE = 15;
export const PERFECT_BLOCK_STAGGER = 35;

/** Rogue Evasive Stance (RMB hold). */
export const EVASIVE_MOVE_SPEED_PCT = 10;
export const EVASIVE_DODGE_DISCOUNT = 10;
export const EVASIVE_ENERGY_PER_S = 3;

/** Cleric Grace passive (CLASSES.md §4): self-healing bonus percent. */
export const GRACE_SELF_HEAL_PCT = 15;
/** Grace: each Holy Smite hit shaves this off the next Mend cast (stacks 3). */
export const GRACE_CAST_REDUCTION_MS = 100;
export const GRACE_MAX_STACKS = 3;
/** The Smite that feeds Grace / the Mend it accelerates (content ids — a
 * panel rename of either row must update these, CLASSES.md §4). */
export const GRACE_TRIGGER_ABILITY = 'ability_cleric_holy_smite';
export const GRACE_CONSUMER_ABILITY = 'ability_cleric_mend';
export const GRACE_EFFECT_ID = 'grace';
/** Grace stacks idle out after this long without a Smite hit. */
export const GRACE_STACK_DURATION_MS = 10000;

/** Mage Attunement passive (CLASSES.md §2): every Nth landed basic bolt. */
export const ATTUNEMENT_EVERY = 3;
export const ATTUNEMENT_MANA_REFUND = 5;
export const ATTUNEMENT_CDR_MS = 500;

/** Mage Focus stance (RMB hold): slow-strafe + faster bolts. */
export const FOCUS_MOVE_SPEED_MULT = 0.6;
export const FOCUS_PROJECTILE_SPEED_PCT = 10;

/** Homing bolts (Arcane Barrage) steer at most this fast, rad/s. */
export const HOMING_TURN_RATE_RAD_S = 4;

/** Rogue Ambusher passive: rear arc and crit bonus (CLASSES.md §3). */
export const AMBUSHER_REAR_ARC_DEG = 120;
export const AMBUSHER_REAR_CRIT_PCT = 15;
/** Basic-crit grants +1 CP, at most once per this window. */
export const AMBUSHER_CP_ICD_MS = 1000;

/** Hotbar slot unlock levels (index 0 = slot 1; CLASSES.md header). */
export const SLOT_UNLOCK_LEVELS = [1, 3, 6, 10, 14, 18, 22, 25] as const;
