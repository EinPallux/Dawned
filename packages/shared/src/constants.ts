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
