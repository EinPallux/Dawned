/**
 * Input: pointer-lock mouselook plus keyboard, translated into world-space movement
 * intents (control scheme decided in USER_QUESTIONS Q1/Q3 — mouselook, `V`/Mouse4 dodge).
 *
 * Keys are read by physical `code`, so WASD works on QWERTZ/AZERTY layouts too.
 */

import { InputButton, type MovementIntent } from '@dawned/shared';

const PITCH_MIN = -0.35;
const PITCH_MAX = 1.15;

export class InputController {
  private readonly held = new Set<string>();
  private pointerLocked = false;

  /** Camera yaw/pitch in radians; yaw 0 faces +Z. */
  yaw = 0;
  pitch = 0.35;

  sensitivity = 0.0022;
  /** Set while a text field (chat) owns the keyboard. */
  textEntryActive = false;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly onChatKey: () => void,
  ) {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', () => {
      this.held.clear();
    });

    canvas.addEventListener('mousedown', () => {
      if (!this.pointerLocked && !this.textEntryActive) void canvas.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    });
    document.addEventListener('mousemove', this.handleMouseMove);
  }

  get isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (this.textEntryActive) return;
    if (event.code === 'Enter') {
      this.onChatKey();
      return;
    }
    // Space would scroll the page; the game owns it.
    if (event.code === 'Space') event.preventDefault();
    this.held.add(event.code);
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.code);
  };

  private handleMouseMove = (event: MouseEvent): void => {
    if (!this.pointerLocked) return;
    this.yaw -= event.movementX * this.sensitivity;
    this.pitch = clamp(this.pitch + event.movementY * this.sensitivity, PITCH_MIN, PITCH_MAX);
  };

  /** Build this tick's intent in world space (the server never sees camera space). */
  sampleIntent(): MovementIntent {
    if (this.textEntryActive) {
      return { moveX: 0, moveZ: 0, yaw: this.yaw, buttons: 0 };
    }

    const forward = (this.held.has('KeyW') ? 1 : 0) - (this.held.has('KeyS') ? 1 : 0);
    const strafe = (this.held.has('KeyD') ? 1 : 0) - (this.held.has('KeyA') ? 1 : 0);

    // yaw 0 → facing +Z; right-hand vector is (cos, −sin) in the XZ plane.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let moveX = sin * forward + cos * strafe;
    let moveZ = cos * forward - sin * strafe;

    const length = Math.hypot(moveX, moveZ);
    if (length > 1) {
      moveX /= length;
      moveZ /= length;
    }

    let buttons = 0;
    if (this.held.has('ShiftLeft') || this.held.has('ShiftRight')) buttons |= InputButton.Sprint;
    if (this.held.has('Space')) buttons |= InputButton.Jump;
    if (this.held.has('KeyV')) buttons |= InputButton.Dodge;

    return { moveX, moveZ, yaw: this.yaw, buttons };
  }
}

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;
