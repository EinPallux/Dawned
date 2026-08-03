/**
 * Debug HUD and chat (P0; carried through P1).
 *
 * Deliberately plain DOM: the real React UI with the "Cut Facets" design system
 * arrives in P1 (docs/design/UI_UX.md). What matters here is that every number a
 * netcode bug would show up in is on screen while we build P3/P4.
 */

import type { ChatBroadcastMessage, RosterEntry } from '@dawned/shared';

export interface HudStats {
  fps: number;
  ping: number;
  serverTick: number;
  snapshots: number;
  corrections: number;
  snaps: number;
  lastCorrectionM: number;
  /** ms since the newest snapshot arrived (0 = none yet). */
  snapshotAgeMs: number;
  /** Smoothed arrival gap between snapshots (healthy ≈ 50 ms). */
  snapshotIntervalMs: number;
  bytesIn: number;
  bytesOut: number;
  /** Lag-lab injection currently active (all zero = off). */
  netsim: { rttMs: number; jitterMs: number };
  position: { x: number; y: number; z: number };
  stamina: number;
  maxStamina: number;
  hp: number;
  maxHp: number;
  /** Ms left on the "Dawned" respawn debuff (0 = none). */
  dawnedRemainingMs: number;
  /** Soft-target under the reticle, when any (COMBAT.md §1). */
  target: { name: string; level: number; hpFraction: number } | null;
  grounded: boolean;
  sprinting: boolean;
  swimming: boolean;
  players: number;
}

export class Hud {
  private readonly root: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly rosterEl: HTMLElement;
  private readonly chatLogEl: HTMLElement;
  private readonly chatInput: HTMLInputElement;
  private readonly staminaFill: HTMLElement;
  private readonly hpFill: HTMLElement;
  private readonly hpText: HTMLElement;
  private readonly deathEl: HTMLElement;
  private readonly dawnedEl: HTMLElement;
  private readonly dawnedSecondsEl: HTMLElement;
  private readonly targetEl: HTMLElement;
  private readonly targetNameEl: HTMLElement;
  private readonly targetHpFill: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly pingCanvas: HTMLCanvasElement;
  private readonly correctionCanvas: HTMLCanvasElement;
  private readonly pingHistory: number[] = [];
  private readonly correctionHistory: number[] = [];
  /** kbps window: last sample of the cumulative byte counters. */
  private lastBytes = { in: 0, out: 0, at: 0 };
  private rateKbps = { in: 0, out: 0 };

  constructor(
    parent: HTMLElement,
    private readonly onChatSubmit: (text: string) => void,
    private readonly onChatFocusChange: (focused: boolean) => void,
    private readonly onRespawn: () => void = () => undefined,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-panel hud-topleft">
        <div class="hud-title">DAWNED <span class="hud-dim">P3</span></div>
        <div class="hud-status" data-status>connecting…</div>
        <pre class="hud-stats" data-stats></pre>
        <canvas class="hud-ping" width="220" height="44" data-ping></canvas>
        <canvas class="hud-ping" width="220" height="32" data-correction title="prediction correction, m"></canvas>
      </div>
      <div class="hud-panel hud-topright">
        <div class="hud-title">IN WORLD</div>
        <div data-roster class="hud-roster"></div>
      </div>
      <div class="hud-banner" data-banner hidden></div>
      <div class="hud-reticle" data-reticle></div>
      <div class="hud-target" data-target hidden>
        <span class="hud-target-name" data-target-name></span>
        <div class="hud-target-hp"><div class="hud-target-hp-fill" data-target-hp></div></div>
      </div>
      <div class="hud-death" data-death hidden>
        <div class="hud-death-title">THE DAWN AWAITS</div>
        <button class="hud-death-button" data-respawn>RETURN TO SHRINE</button>
        <div class="hud-death-hint">Respawning carries the Dawned mark: −15% damage for 30 s.</div>
      </div>
      <div class="hud-bottom">
        <div class="hud-dawned" data-dawned hidden>DAWNED <span data-dawned-s></span></div>
        <div class="hud-hp"><div class="hud-hp-fill" data-hp></div><span class="hud-hp-text" data-hp-text></span></div>
        <div class="hud-stamina"><div class="hud-stamina-fill" data-stamina></div></div>
        <div class="hud-hint">
          <b>WASD</b> move · <b>Shift</b> sprint · <b>Space</b> jump · <b>Mouse</b> look
          (click captures, hold <b>Alt</b> frees the cursor) · <b>Enter</b> chat ·
          <b>/stuck</b> if trapped
        </div>
      </div>
      <div class="hud-panel hud-chat">
        <div class="hud-chat-log" data-chatlog></div>
        <input class="hud-chat-input" data-chatinput placeholder="Press Enter to chat…" maxlength="200" />
      </div>
    `;
    parent.appendChild(this.root);

    this.statusEl = this.query('[data-status]');
    this.statsEl = this.query('[data-stats]');
    this.rosterEl = this.query('[data-roster]');
    this.chatLogEl = this.query('[data-chatlog]');
    this.staminaFill = this.query('[data-stamina]');
    this.hpFill = this.query('[data-hp]');
    this.hpText = this.query('[data-hp-text]');
    this.deathEl = this.query('[data-death]');
    this.dawnedEl = this.query('[data-dawned]');
    this.dawnedSecondsEl = this.query('[data-dawned-s]');
    this.targetEl = this.query('[data-target]');
    this.targetNameEl = this.query('[data-target-name]');
    this.targetHpFill = this.query('[data-target-hp]');
    this.query('[data-respawn]').addEventListener('click', () => {
      this.onRespawn();
    });
    this.bannerEl = this.query('[data-banner]');
    this.pingCanvas = this.query('[data-ping]') as HTMLCanvasElement;
    this.correctionCanvas = this.query('[data-correction]') as HTMLCanvasElement;
    this.chatInput = this.query('[data-chatinput]') as HTMLInputElement;

    this.chatInput.addEventListener('focus', () => {
      this.onChatFocusChange(true);
    });
    this.chatInput.addEventListener('blur', () => {
      this.onChatFocusChange(false);
    });
    this.chatInput.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        const text = this.chatInput.value.trim();
        this.chatInput.value = '';
        this.chatInput.blur();
        if (text) this.onChatSubmit(text);
      } else if (event.key === 'Escape') {
        this.chatInput.value = '';
        this.chatInput.blur();
      }
    });
  }

  private query(selector: string): HTMLElement {
    const element = this.root.querySelector(selector);
    if (!element) throw new Error(`HUD element missing: ${selector}`);
    return element as HTMLElement;
  }

  focusChat(): void {
    this.chatInput.focus();
  }

  setStatus(text: string, tone: 'ok' | 'warn' | 'error'): void {
    this.statusEl.textContent = text;
    this.statusEl.dataset.tone = tone;
  }

  /** Center-screen banner for states the player must not miss (reconnecting). */
  /** Soul screen on death (COMBAT.md §10); hides again on respawn. */
  showDeath(visible: boolean): void {
    this.deathEl.hidden = !visible;
  }

  setBanner(text: string | null): void {
    this.bannerEl.hidden = text === null;
    this.bannerEl.textContent = text ?? '';
  }

  setRoster(players: RosterEntry[], selfId: number): void {
    this.rosterEl.innerHTML = players
      .map(
        (player) =>
          `<div class="hud-roster-row${player.id === selfId ? ' is-self' : ''}">${escapeHtml(player.name)}</div>`,
      )
      .join('');
  }

  addChat(message: ChatBroadcastMessage): void {
    const row = document.createElement('div');
    row.className = message.system ? 'hud-chat-row is-system' : 'hud-chat-row';
    row.innerHTML = message.system
      ? `<span class="hud-chat-text">${escapeHtml(message.text)}</span>`
      : `<span class="hud-chat-from">${escapeHtml(message.from)}</span><span class="hud-chat-text">${escapeHtml(message.text)}</span>`;
    this.chatLogEl.appendChild(row);
    while (this.chatLogEl.childElementCount > 50)
      this.chatLogEl.removeChild(this.chatLogEl.firstChild!);
    this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
  }

  update(stats: HudStats): void {
    // Throughput from the cumulative byte counters, refreshed twice a second.
    const now = performance.now();
    if (this.lastBytes.at === 0) {
      this.lastBytes = { in: stats.bytesIn, out: stats.bytesOut, at: now };
    } else if (now - this.lastBytes.at >= 500) {
      const seconds = (now - this.lastBytes.at) / 1000;
      this.rateKbps.in = ((stats.bytesIn - this.lastBytes.in) * 8) / 1000 / seconds;
      this.rateKbps.out = ((stats.bytesOut - this.lastBytes.out) * 8) / 1000 / seconds;
      this.lastBytes = { in: stats.bytesIn, out: stats.bytesOut, at: now };
    }

    const state = stats.swimming ? 'swimming' : stats.grounded ? 'grounded' : 'airborne';
    const netsim =
      stats.netsim.rttMs > 0 || stats.netsim.jitterMs > 0
        ? [`netsim   +${stats.netsim.rttMs.toFixed(0)} ms ±${stats.netsim.jitterMs.toFixed(0)}`]
        : [];
    this.statsEl.textContent = [
      `fps      ${stats.fps.toFixed(0).padStart(5)}`,
      `ping     ${stats.ping.toFixed(0).padStart(5)} ms`,
      `snaps    ${String(stats.snapshots).padStart(5)} · ${stats.snapshotIntervalMs.toFixed(0)} ms gap · age ${stats.snapshotAgeMs.toFixed(0)} ms`,
      `net      ${this.rateKbps.in.toFixed(1).padStart(5)} ↓ ${this.rateKbps.out.toFixed(1)} ↑ kbps`,
      ...netsim,
      `tick     ${String(stats.serverTick).padStart(5)}`,
      `corr     ${String(stats.corrections).padStart(5)} (${stats.lastCorrectionM.toFixed(3)} m)`,
      `hard     ${String(stats.snaps).padStart(5)}`,
      `pos      ${stats.position.x.toFixed(1)}, ${stats.position.y.toFixed(1)}, ${stats.position.z.toFixed(1)}`,
      `state    ${state}${stats.sprinting ? ' · sprinting' : ''}`,
      `players  ${String(stats.players).padStart(5)}`,
    ].join('\n');

    const fraction = stats.maxStamina > 0 ? stats.stamina / stats.maxStamina : 0;
    this.staminaFill.style.width = `${(fraction * 100).toFixed(1)}%`;
    this.staminaFill.dataset.low = fraction < 0.25 ? 'true' : 'false';

    const hpFraction = stats.maxHp > 0 ? stats.hp / stats.maxHp : 0;
    this.hpFill.style.width = `${(hpFraction * 100).toFixed(1)}%`;
    this.hpFill.dataset.low = hpFraction < 0.3 ? 'true' : 'false';
    this.hpText.textContent = `${stats.hp} / ${stats.maxHp}`;

    if (stats.dawnedRemainingMs > 0) {
      this.dawnedEl.hidden = false;
      this.dawnedSecondsEl.textContent = `${Math.ceil(stats.dawnedRemainingMs / 1000)}s`;
    } else {
      this.dawnedEl.hidden = true;
    }

    if (stats.target) {
      this.targetEl.hidden = false;
      this.targetNameEl.textContent = `${stats.target.name} · ${stats.target.level}`;
      this.targetHpFill.style.width = `${(stats.target.hpFraction * 100).toFixed(1)}%`;
    } else {
      this.targetEl.hidden = true;
    }

    this.pingHistory.push(stats.ping);
    if (this.pingHistory.length > 110) this.pingHistory.shift();
    this.correctionHistory.push(stats.lastCorrectionM);
    if (this.correctionHistory.length > 110) this.correctionHistory.shift();
    this.drawPingGraph();
    this.drawCorrectionGraph();
  }

  private drawPingGraph(): void {
    const ctx = this.pingCanvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = this.pingCanvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(21,26,38,0.55)';
    ctx.fillRect(0, 0, width, height);

    const max = Math.max(80, ...this.pingHistory);
    ctx.strokeStyle = '#57c77b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    this.pingHistory.forEach((ping, index) => {
      const x = (index / 110) * width;
      const y = height - (ping / max) * (height - 4) - 2;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = '#9aa3b5';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(`${max.toFixed(0)} ms`, 4, 11);
  }

  /**
   * Correction magnitude per frame, scaled to the 1.5 m snap threshold — the
   * one graph that must stay flat for movement to feel LAN-like (P3 DoD).
   */
  private drawCorrectionGraph(): void {
    const ctx = this.correctionCanvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = this.correctionCanvas;
    const scaleM = 1.5; // CORRECTION_SNAP_M — bars that reach the top mean snaps
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(21,26,38,0.55)';
    ctx.fillRect(0, 0, width, height);

    const barWidth = width / 110;
    this.correctionHistory.forEach((meters, index) => {
      if (meters <= 0.001) return;
      const fraction = Math.min(1, meters / scaleM);
      ctx.fillStyle = meters < 0.1 ? '#57c77b' : meters < 0.5 ? '#d9a441' : '#d95757';
      const barHeight = Math.max(1, fraction * (height - 4));
      ctx.fillRect(
        index * barWidth,
        height - barHeight - 2,
        Math.max(1, barWidth - 0.5),
        barHeight,
      );
    });

    ctx.fillStyle = '#9aa3b5';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText('corr ≤1.5 m', 4, 11);
  }
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
