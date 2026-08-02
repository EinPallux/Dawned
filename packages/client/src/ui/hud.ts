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
  position: { x: number; y: number; z: number };
  stamina: number;
  maxStamina: number;
  grounded: boolean;
  sprinting: boolean;
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
  private readonly pingCanvas: HTMLCanvasElement;
  private readonly pingHistory: number[] = [];

  constructor(
    parent: HTMLElement,
    private readonly onChatSubmit: (text: string) => void,
    private readonly onChatFocusChange: (focused: boolean) => void,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-panel hud-topleft">
        <div class="hud-title">DAWNED <span class="hud-dim">P1</span></div>
        <div class="hud-status" data-status>connecting…</div>
        <pre class="hud-stats" data-stats></pre>
        <canvas class="hud-ping" width="220" height="44" data-ping></canvas>
      </div>
      <div class="hud-panel hud-topright">
        <div class="hud-title">IN WORLD</div>
        <div data-roster class="hud-roster"></div>
      </div>
      <div class="hud-bottom">
        <div class="hud-stamina"><div class="hud-stamina-fill" data-stamina></div></div>
        <div class="hud-hint">
          <b>WASD</b> move · <b>Shift</b> sprint · <b>Space</b> jump · <b>Mouse</b> look
          (click to capture, <b>Esc</b> to release) · <b>Enter</b> chat
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
    this.pingCanvas = this.query('[data-ping]') as HTMLCanvasElement;
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
    this.statsEl.textContent = [
      `fps      ${stats.fps.toFixed(0).padStart(5)}`,
      `ping     ${stats.ping.toFixed(0).padStart(5)} ms`,
      `tick     ${String(stats.serverTick).padStart(5)}`,
      `snaps    ${String(stats.snapshots).padStart(5)}`,
      `corr     ${String(stats.corrections).padStart(5)} (${stats.lastCorrectionM.toFixed(3)} m)`,
      `hard     ${String(stats.snaps).padStart(5)}`,
      `pos      ${stats.position.x.toFixed(1)}, ${stats.position.y.toFixed(1)}, ${stats.position.z.toFixed(1)}`,
      `state    ${stats.grounded ? 'grounded' : 'airborne'}${stats.sprinting ? ' · sprinting' : ''}`,
      `players  ${String(stats.players).padStart(5)}`,
    ].join('\n');

    const fraction = stats.maxStamina > 0 ? stats.stamina / stats.maxStamina : 0;
    this.staminaFill.style.width = `${(fraction * 100).toFixed(1)}%`;
    this.staminaFill.dataset.low = fraction < 0.25 ? 'true' : 'false';

    this.pingHistory.push(stats.ping);
    if (this.pingHistory.length > 110) this.pingHistory.shift();
    this.drawPingGraph();
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
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
