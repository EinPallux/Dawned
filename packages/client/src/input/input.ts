/**
 * Input: pointer-lock mouselook plus keyboard, translated into world-space movement
 * intents (control scheme decided in USER_QUESTIONS Q1/Q3 — mouselook, `V`/Mouse4 dodge).
 *
 * Keys are read by physical `code`, so WASD works on QWERTZ/AZERTY layouts too.
 */

import { InputButton, type MovementIntent } from '@dawned/shared';

const PITCH_MIN = -0.35;
const PITCH_MAX = 1.15;

/**
 * Camera-relative movement: forward/strafe (WASD) → a world-space direction.
 *
 * Conventions (all derived from the camera rig in world/scene.ts): yaw 0 faces
 * +Z, so forward = (sin yaw, cos yaw). The camera sits BEHIND that facing and
 * three.js lookAt yields screen-right = up × (eye − target) = (−cos yaw, sin yaw)
 * — note the MINUS on cos. Getting this sign wrong swaps A and D (it shipped
 * that way once; input-math.test.ts now pins every direction).
 */
export const cameraRelativeMove = (
  forward: number,
  strafe: number,
  yaw: number,
): { moveX: number; moveZ: number } => {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  let moveX = sin * forward - cos * strafe;
  let moveZ = cos * forward + sin * strafe;
  const length = Math.hypot(moveX, moveZ);
  if (length > 1) {
    moveX /= length;
    moveZ /= length;
  }
  return { moveX, moveZ };
};

export class InputController {
  private readonly held = new Set<string>();
  /**
   * Keys pressed since the last intent sample. Intents sample at 20 Hz while
   * frames run at 60–240 Hz — a quick tap (jump!) can press AND release inside
   * one tick window and vanish. A tap latches here until the next sample.
   */
  private readonly tapped = new Set<string>();
  private pointerLocked = false;
  /** True while the cursor is freed by holding Alt — releasing Alt re-locks. */
  private altReleased = false;

  /** Camera yaw/pitch in radians; yaw 0 faces +Z. */
  yaw = 0;
  pitch = 0.35;

  sensitivity = 0.0022;
  /** Set while a text field (chat) owns the keyboard. */
  textEntryActive = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onChatKey: () => void,
  ) {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', () => {
      this.held.clear();
      this.tapped.clear();
      // An alt-tab while the cursor was Alt-freed must not re-lock on return.
      this.altReleased = false;
    });

    canvas.addEventListener('mousedown', (event) => {
      if (!this.pointerLocked) {
        if (!this.textEntryActive) void canvas.requestPointerLock();
        return;
      }
      // Locked = combat verbs (COMBAT.md §2): LMB basic attack; RMB held =
      // the class stance (Block / Evasive, P5); Mouse4 dodge.
      if (event.button === 0) this.attackPresses++;
      if (event.button === 2) {
        event.preventDefault();
        this.held.add('Mouse2');
      }
      if (event.button === 3) {
        event.preventDefault();
        this.held.add('Mouse4');
        this.tapped.add('Mouse4');
      }
    });
    canvas.addEventListener('mouseup', (event) => {
      if (event.button === 2) this.held.delete('Mouse2');
      if (event.button === 3) this.held.delete('Mouse4');
    });
    // The stance lives on RMB — the browser menu would eat the hold.
    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    });
    document.addEventListener('mousemove', this.handleMouseMove);
  }

  /** LMB presses since last drained — run-world turns them into attack requests. */
  private attackPresses = 0;
  /** Hotbar keys (1–8) pressed since last drained, in press order. */
  private slotPresses: number[] = [];

  /** Drain buffered attack presses (called once per frame). */
  takeAttackPresses(): number {
    const presses = this.attackPresses;
    this.attackPresses = 0;
    return presses;
  }

  /** Drain buffered hotbar presses (called once per frame). */
  takeSlotPresses(): number[] {
    if (this.slotPresses.length === 0) return this.slotPresses;
    const presses = this.slotPresses;
    this.slotPresses = [];
    return presses;
  }

  /** RMB (or the class-stance key) held right now — stance state for HUD/anim. */
  get secondaryHeld(): boolean {
    return !this.textEntryActive && this.held.has('Mouse2');
  }

  /**
   * Smoke-test hook: hold/release the stance button without pointer lock
   * (headless browsers can't). Exactly equivalent to a real RMB hold — the
   * bit rides the next intents and the server engages the stance for real.
   */
  debugSetSecondary(held: boolean): void {
    if (held) this.held.add('Mouse2');
    else this.held.delete('Mouse2');
  }

  get isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    // Hold Alt to use the cursor (inventory later, chat scroll now) without
    // losing WASD; releasing Alt re-locks. preventDefault stops the browser
    // from focusing its menu bar on the naked Alt press.
    if (event.code === 'AltLeft' || event.code === 'AltRight') {
      event.preventDefault();
      if (this.pointerLocked) {
        this.altReleased = true;
        document.exitPointerLock();
      }
      return;
    }
    if (this.textEntryActive) return;
    if (event.code === 'Enter') {
      this.onChatKey();
      return;
    }
    // Space would scroll the page; the game owns it.
    if (event.code === 'Space') event.preventDefault();
    // Hotbar 1–8 buffer like LMB: presses are edge events, not held state
    // (repeat guard — a held key must not machine-gun requests).
    const digit = /^Digit([1-8])$/.exec(event.code);
    if (digit && !event.repeat) this.slotPresses.push(Number(digit[1]));
    this.held.add(event.code);
    this.tapped.add(event.code);
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    if (event.code === 'AltLeft' || event.code === 'AltRight') {
      event.preventDefault();
      if (this.altReleased && !this.textEntryActive) {
        // Allowed without a fresh click: the preceding keydown grants transient
        // activation, and the lock was released by script (not Esc).
        void this.canvas.requestPointerLock();
      }
      this.altReleased = false;
      return;
    }
    this.held.delete(event.code);
  };

  private handleMouseMove = (event: MouseEvent): void => {
    if (!this.pointerLocked) return;
    this.yaw -= event.movementX * this.sensitivity;
    this.pitch = clamp(this.pitch + event.movementY * this.sensitivity, PITCH_MIN, PITCH_MAX);
  };

  /**
   * Live movement axes from HELD keys, for the per-frame animation layer
   * (forward = W−S, strafe = D−A, camera-relative). Deliberately ignores the
   * tap latch — taps are a tick concern (sampleIntent); a sub-frame tap must
   * not flash a strafe clip. Reads only, so it is safe at render rate.
   */
  moveAxes(): { forward: number; strafe: number } {
    if (this.textEntryActive) return { forward: 0, strafe: 0 };
    return {
      forward: (this.held.has('KeyW') ? 1 : 0) - (this.held.has('KeyS') ? 1 : 0),
      strafe: (this.held.has('KeyD') ? 1 : 0) - (this.held.has('KeyA') ? 1 : 0),
    };
  }

  /** Build this tick's intent in world space (the server never sees camera space). */
  sampleIntent(): MovementIntent {
    if (this.textEntryActive) {
      this.tapped.clear();
      return { moveX: 0, moveZ: 0, yaw: this.yaw, buttons: 0 };
    }

    // held ∪ tapped: a key that was pressed-and-released between two 20 Hz
    // samples still counts for this tick (jump taps must never whiff).
    const active = (code: string): boolean => this.held.has(code) || this.tapped.has(code);

    const forward = (active('KeyW') ? 1 : 0) - (active('KeyS') ? 1 : 0);
    const strafe = (active('KeyD') ? 1 : 0) - (active('KeyA') ? 1 : 0);
    const { moveX, moveZ } = cameraRelativeMove(forward, strafe, this.yaw);

    let buttons = 0;
    if (active('ShiftLeft') || active('ShiftRight')) buttons |= InputButton.Sprint;
    if (active('Space')) buttons |= InputButton.Jump;
    if (active('KeyV') || active('Mouse4')) buttons |= InputButton.Dodge;
    // Stance is HELD state (no tap latch): the server folds it per intent.
    if (this.held.has('Mouse2')) buttons |= InputButton.SecondaryAction;

    this.tapped.clear();
    return { moveX, moveZ, yaw: this.yaw, buttons };
  }
}

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;
