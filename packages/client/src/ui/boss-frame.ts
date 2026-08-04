/**
 * Boss frame (P9, NPCS_ENEMIES.md §1 / COMBAT.md §8): a boss fight has to read
 * as a boss fight, not as a big enemy with a small nameplate.
 *
 * The frame appears when a zone/world boss aggros, follows its HP, marks every
 * phase threshold it will cross, and flashes with the announce line when one
 * is crossed. It hides when the boss dies, leashes home, or drops out of view.
 *
 * The announce TEXT is not on the wire: the client already holds the published
 * enemy def, so it reads the line for the phase index itself and the panel can
 * rewrite a boss's shout without a protocol change.
 */

import type { EnemyDef } from '@dawned/shared';

/** How long the phase banner sits before fading out. */
const ANNOUNCE_MS = 3200;

export class BossFrame {
  private readonly root: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly fillEl: HTMLElement;
  private readonly pipsEl: HTMLElement;
  private readonly announceEl: HTMLElement;

  private bossId: number | null = null;
  private def: EnemyDef | null = null;
  private announceUntil = 0;
  private shownFraction = -1;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'boss-frame';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="boss-frame-name" data-name></div>
      <div class="boss-frame-track">
        <div class="boss-frame-fill" data-fill></div>
        <div class="boss-frame-pips" data-pips></div>
      </div>
      <div class="boss-frame-announce" data-announce></div>`;
    parent.appendChild(this.root);
    this.nameEl = this.root.querySelector('[data-name]') as HTMLElement;
    this.fillEl = this.root.querySelector('[data-fill]') as HTMLElement;
    this.pipsEl = this.root.querySelector('[data-pips]') as HTMLElement;
    this.announceEl = this.root.querySelector('[data-announce]') as HTMLElement;
  }

  /** True while this frame is showing the given entity. */
  isShowing(entityId: number): boolean {
    return this.bossId === entityId;
  }

  /**
   * Adopt a boss. Idempotent for the same entity, so the per-frame update can
   * call it every tick the boss is visible without rebuilding anything.
   */
  show(entityId: number, name: string, level: number, def: EnemyDef | undefined): void {
    if (this.bossId === entityId) return;
    this.bossId = entityId;
    this.def = def ?? null;
    this.shownFraction = -1;
    this.nameEl.textContent = `${name}  ·  ${level}`;
    // Phase thresholds get a tick on the bar: a player can SEE the next
    // transition coming, which is what makes a phase a beat rather than a
    // surprise. Sorted descending — the order the fight walks them.
    const phases = [...(def?.phases ?? [])].sort((a, b) => b.atHpPct - a.atHpPct);
    this.pipsEl.innerHTML = '';
    for (const phase of phases) {
      const pip = document.createElement('div');
      pip.className = 'boss-frame-pip';
      pip.style.left = `${phase.atHpPct}%`;
      this.pipsEl.appendChild(pip);
    }
    this.root.hidden = false;
  }

  /** HP fraction 0..1. Cheap to call every frame; only redraws on change. */
  setHp(fraction: number): void {
    const clamped = Math.max(0, Math.min(1, fraction));
    if (Math.abs(clamped - this.shownFraction) < 0.002) return;
    this.shownFraction = clamped;
    this.fillEl.style.width = `${clamped * 100}%`;
  }

  /** A phase threshold was crossed: flash the frame and say the line. */
  onPhase(entityId: number, phaseIndex: number): void {
    if (this.bossId !== entityId) return;
    const phases = [...(this.def?.phases ?? [])].sort((a, b) => b.atHpPct - a.atHpPct);
    const announce = phases[phaseIndex - 1]?.announce ?? '';
    this.root.classList.remove('is-phase');
    void this.root.offsetWidth; // restart the flash animation
    this.root.classList.add('is-phase');
    if (announce) {
      this.announceEl.textContent = announce;
      this.announceEl.classList.add('is-live');
      this.announceUntil = performance.now() + ANNOUNCE_MS;
    }
  }

  hide(): void {
    if (this.bossId === null) return;
    this.bossId = null;
    this.def = null;
    this.root.hidden = true;
    this.root.classList.remove('is-phase');
    this.announceEl.classList.remove('is-live');
  }

  /** Per-frame: expire the announce banner. */
  update(): void {
    if (this.announceUntil > 0 && performance.now() > this.announceUntil) {
      this.announceUntil = 0;
      this.announceEl.classList.remove('is-live');
    }
  }
}
