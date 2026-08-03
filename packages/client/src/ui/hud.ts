/**
 * In-world HUD and chat: the netcode debug panel (P0) plus the combat cluster
 * (P5-D, UI_UX.md §3) — twin faceted globes flanking an 8-slot hotbar with
 * cooldown radials, Rogue combo pips, cast bar, buff/debuff row. Plain DOM on
 * purpose: this surface updates every frame and needs no reconciliation; the
 * React screens (menus now, panels at P7) stay separate.
 */

import type { ChatBroadcastMessage, RosterEntry } from '@dawned/shared';
import type { SlotView } from '../net/connection.js';

/** Class resource palette (UI_UX.md §1 — vibrant, no pastel mush). */
const RESOURCE_COLORS: Record<string, { fill: string; deep: string }> = {
  rage: { fill: '#e0563f', deep: '#7c221a' },
  energy: { fill: '#d9c94a', deep: '#6e6218' },
  mana: { fill: '#5f86e8', deep: '#243a78' },
};

export interface HudResource {
  type: string;
  value: number;
  max: number;
  comboPoints: number;
  /** Rogues show the pip arc; others hide it. */
  showComboPoints: boolean;
}

export interface HudEffect {
  effectId: string;
  stacks: number;
  remainingMs: number;
  harmful: boolean;
}

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
  // --- combat cluster (P5-D) ----------------------------------------------
  resource: HudResource;
  /** Hotbar slots 1..8, polled from the connection's shared machine. */
  slots: SlotView[];
  /** Active cast (null = bar hidden; P5 kits are instants). */
  cast: { name: string; fraction: number } | null;
  selfEffects: readonly HudEffect[];
  targetEffects: readonly HudEffect[];
  /** Stamina covers a dodge right now — the V tile's lit state. */
  dodgeReady: boolean;
  /** RMB stance currently held (shield glyph tint). */
  stanceHeld: boolean;
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
  private readonly targetEffectsEl: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly effectsEl: HTMLElement;
  private readonly castEl: HTMLElement;
  private readonly castFill: HTMLElement;
  private readonly castName: HTMLElement;
  private readonly hotbarEl: HTMLElement;
  private readonly resourceGlobeEl: HTMLElement;
  private readonly resourceFill: HTMLElement;
  private readonly resourceText: HTMLElement;
  private readonly cpEl: HTMLElement;
  /** Per-slot element cache, built by setSlots. */
  private readonly slotEls = new Map<
    number,
    {
      root: HTMLElement;
      glyph: HTMLElement;
      cd: HTMLElement;
      cdText: HTMLElement;
      gcd: HTMLElement;
      cost: HTMLElement;
      lock: HTMLElement;
    }
  >();
  private dodgeTile: HTMLElement | null = null;
  /** Signature of the last-built hotbar (rebuild only on def changes). */
  private slotsKey = '';
  /** Signature of the last-rendered effect rows (rebuild only on change). */
  private effectsKey = '';
  private targetEffectsKey = '';
  private resourceType = '';
  /** game-icons slug → baked SVG url (masked; states tint them). */
  private iconUrls = new Map<string, string>();
  /** effectId → icon slug of the ability that applies it (buff chips). */
  private effectIcons = new Map<string, string>();
  /** Floating refusal label + its hide timer. */
  private refusalEl: HTMLElement | null = null;
  private refusalTimer: ReturnType<typeof setTimeout> | null = null;
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
        <div class="hud-target-effects" data-target-effects></div>
      </div>
      <div class="hud-death" data-death hidden>
        <div class="hud-death-title">THE DAWN AWAITS</div>
        <button class="hud-death-button" data-respawn>RETURN TO SHRINE</button>
        <div class="hud-death-hint">Respawning carries the Dawned mark: −15% damage for 30 s.</div>
      </div>
      <div class="hud-effects" data-effects></div>
      <div class="hud-bottom">
        <div class="hud-dawned" data-dawned hidden>DAWNED <span data-dawned-s></span></div>
        <div class="hud-cast" data-cast hidden>
          <div class="hud-cast-fill" data-cast-fill></div>
          <span class="hud-cast-name" data-cast-name></span>
        </div>
        <div class="hud-cluster">
          <div class="hud-globe is-hp">
            <div class="hud-globe-fill" data-hp></div>
            <span class="hud-globe-text hud-hp-text" data-hp-text></span>
          </div>
          <div class="hud-cluster-mid">
            <div class="hud-hotbar" data-hotbar></div>
            <div class="hud-stamina"><div class="hud-stamina-fill" data-stamina></div></div>
          </div>
          <div class="hud-globe is-resource" data-resource-globe>
            <div class="hud-cp" data-cp hidden></div>
            <div class="hud-globe-fill" data-resource></div>
            <span class="hud-globe-text" data-resource-text></span>
          </div>
        </div>
        <div class="hud-hint">
          <b>WASD</b> move · <b>Shift</b> sprint · <b>LMB</b> attack · <b>1–8</b> abilities ·
          <b>RMB</b> hold stance · <b>V</b> dodge · <b>Alt</b> cursor · <b>Enter</b> chat
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
    this.targetEffectsEl = this.query('[data-target-effects]');
    this.effectsEl = this.query('[data-effects]');
    this.castEl = this.query('[data-cast]');
    this.castFill = this.query('[data-cast-fill]');
    this.castName = this.query('[data-cast-name]');
    this.hotbarEl = this.query('[data-hotbar]');
    this.resourceGlobeEl = this.query('[data-resource-globe]');
    this.resourceFill = this.query('[data-resource]');
    this.resourceText = this.query('[data-resource-text]');
    this.cpEl = this.query('[data-cp]');
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

  /**
   * Baked icon urls + effectId → icon mapping. Arrives once the manifest and
   * ability defs load; the hotbar rebuilds so tiles pick their icons up.
   */
  setIcons(iconUrls: Map<string, string>, effectIcons: Map<string, string>): void {
    this.iconUrls = iconUrls;
    this.effectIcons = effectIcons;
    this.slotsKey = '';
    this.effectsKey = '';
    this.targetEffectsKey = '';
  }

  /** Masked-icon markup for a slug, or empty when the icon isn't baked. */
  private iconMarkup(slug: string | undefined, className: string): string {
    const url = slug ? this.iconUrls.get(slug) : undefined;
    if (!url) return '';
    return `<span class="${className}" style="--icon:url('${url}')"></span>`;
  }

  /**
   * (Re)build the hotbar DOM when the slot defs change (content load, class,
   * publish hot-reload). Per-frame state rides updateSlots — this only builds.
   */
  private buildHotbar(slots: SlotView[]): void {
    this.slotEls.clear();
    this.hotbarEl.innerHTML = '';
    for (const view of slots) {
      const root = document.createElement('div');
      root.className = 'hud-slot';
      root.dataset.slot = String(view.slot);
      const def = view.def;
      const icon = def ? this.iconMarkup(def.icon, 'hud-slot-icon') : '';
      root.innerHTML = `
        <span class="hud-slot-key">${view.slot}</span>
        ${icon || `<span class="hud-slot-glyph">${def ? escapeHtml(monogram(def.name)) : ''}</span>`}
        <span class="hud-slot-cost"></span>
        <span class="hud-slot-lock" hidden></span>
        <div class="hud-slot-gcd"></div>
        <div class="hud-slot-cd" hidden><span class="hud-slot-cd-s"></span></div>
        <div class="hud-slot-seam"></div>
      `;
      if (def) root.title = `${def.name}${def.description ? ` — ${def.description}` : ''}`;
      else root.classList.add('is-empty');
      this.hotbarEl.appendChild(root);
      this.slotEls.set(view.slot, {
        root,
        glyph: root.querySelector('.hud-slot-glyph, .hud-slot-icon') as HTMLElement,
        cd: root.querySelector('.hud-slot-cd') as HTMLElement,
        cdText: root.querySelector('.hud-slot-cd-s') as HTMLElement,
        gcd: root.querySelector('.hud-slot-gcd') as HTMLElement,
        cost: root.querySelector('.hud-slot-cost') as HTMLElement,
        lock: root.querySelector('.hud-slot-lock') as HTMLElement,
      });
    }
    // The V dodge tile closes the row (UI_UX.md §3: shows stamina-ready state).
    const dodge = document.createElement('div');
    dodge.className = 'hud-slot is-dodge';
    dodge.innerHTML = `<span class="hud-slot-key">V</span><span class="hud-slot-glyph">⟁</span>`;
    dodge.title = 'Dodge roll (i-frames) — costs stamina';
    this.hotbarEl.appendChild(dodge);
    this.dodgeTile = dodge;
  }

  /** Per-frame hotbar state: radials, GCD sweep, affordability, proc glow. */
  private updateSlots(slots: SlotView[], comboPoints: number): void {
    const key = slots.map((s) => `${s.slot}:${s.def?.id ?? ''}`).join('|');
    if (key !== this.slotsKey) {
      this.slotsKey = key;
      this.buildHotbar(slots);
    }
    for (const view of slots) {
      const els = this.slotEls.get(view.slot);
      if (!els || !view.def) continue;
      const def = view.def;

      if (view.lockedUntilLevel > 0) {
        els.root.dataset.state = 'locked';
        els.lock.hidden = false;
        els.lock.textContent = `Lv ${view.lockedUntilLevel}`;
        els.cost.textContent = '';
        els.cd.hidden = true;
        els.gcd.style.height = '0%';
        continue;
      }
      els.lock.hidden = true;

      // Cooldown radial (conic wipe) + a seconds readout the whole way down.
      const cooling = view.cooldownMs > 0 && view.cooldownTotalMs > 0;
      if (cooling) {
        els.cd.hidden = false;
        const fraction = view.cooldownMs / view.cooldownTotalMs;
        els.cd.style.setProperty('--cd', `${(fraction * 360).toFixed(1)}deg`);
        els.cdText.textContent =
          view.cooldownMs >= 9950
            ? `${Math.ceil(view.cooldownMs / 1000)}`
            : (view.cooldownMs / 1000).toFixed(1);
      } else {
        if (!els.cd.hidden) {
          els.cd.hidden = true;
          // End-of-cooldown "ready" ping (§2 motion table).
          els.root.classList.remove('is-ready-ping');
          void els.root.offsetWidth; // restart the animation
          els.root.classList.add('is-ready-ping');
        }
      }

      // GCD: a quick bottom-up sweep on the whole row while it runs.
      els.gcd.style.height =
        view.gcdMs > 0 && view.cooldownMs <= 0
          ? `${Math.min(100, (view.gcdMs / 400) * 100)}%`
          : '0%';

      // Cost tag + a three-way state the whole TILE wears (not just the icon):
      // ready = lit, cooling = shaded with the timer, poor = dark + red cost.
      els.cost.textContent = def.cost.amount > 0 ? String(def.cost.amount) : '';
      els.root.dataset.state = cooling ? 'cooling' : view.affordable ? 'ready' : 'poor';

      // Proc glow: a finisher at full pips is the "press me" moment.
      els.root.classList.toggle(
        'is-proc',
        def.comboFinisher && comboPoints >= 5 && view.affordable,
      );
    }
    if (this.dodgeTile) this.dodgeTile.dataset.state = 'ready';
  }

  /**
   * Why a press was refused, in words, floating above the hotbar (§3 — the
   * red seam alone was invisible in the playtest). One label, re-triggered.
   */
  showRefusal(text: string): void {
    if (!this.refusalEl) {
      this.refusalEl = document.createElement('div');
      this.refusalEl.className = 'hud-refusal';
      this.query('[data-cast]').parentElement?.insertBefore(
        this.refusalEl,
        this.query('[data-cast]'),
      );
    }
    this.refusalEl.textContent = text;
    this.refusalEl.classList.remove('is-live');
    void this.refusalEl.offsetWidth;
    this.refusalEl.classList.add('is-live');
    if (this.refusalTimer) clearTimeout(this.refusalTimer);
    this.refusalTimer = setTimeout(() => {
      this.refusalEl?.classList.remove('is-live');
    }, 900);
  }

  /** Red seam pulse on a refused press (local evaluate or server reject). */
  pulseSlot(slot: number): void {
    const els = this.slotEls.get(slot);
    if (!els) return;
    els.root.classList.remove('is-refused');
    void els.root.offsetWidth;
    els.root.classList.add('is-refused');
  }

  /** Render an effect row (self top-right; target strip under the plate). */
  private renderEffects(
    parent: HTMLElement,
    effects: readonly HudEffect[],
    keyField: 'effectsKey' | 'targetEffectsKey',
  ): void {
    const key = effects
      .map((e) => `${e.effectId}:${e.stacks}:${Math.ceil(e.remainingMs / 1000)}:${e.harmful}`)
      .join('|');
    if (key === this[keyField]) return;
    this[keyField] = key;
    parent.innerHTML = effects
      .map((effect) => {
        const seconds = Math.ceil(effect.remainingMs / 1000);
        const stacks = effect.stacks > 1 ? `<b>${effect.stacks}</b>` : '';
        const icon = this.iconMarkup(this.effectIcons.get(effect.effectId), 'hud-effect-icon');
        const glyph =
          icon ||
          `<span class="hud-effect-glyph">${escapeHtml(monogram(effect.effectId.replace(/^(buff|debuff|bleed|poison|slow)_/, '')))}</span>`;
        return `<div class="hud-effect${effect.harmful ? ' is-harmful' : ''}" title="${escapeHtml(effect.effectId)}">
          ${glyph}${stacks ? `<span class="hud-effect-stacks">${stacks}</span>` : ''}
          <span class="hud-effect-s">${seconds}s</span>
        </div>`;
      })
      .join('');
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

    // HP globe: liquid fill by height (UI_UX.md §3 vitals).
    const hpFraction = stats.maxHp > 0 ? stats.hp / stats.maxHp : 0;
    this.hpFill.style.height = `${(hpFraction * 100).toFixed(1)}%`;
    this.hpFill.dataset.low = hpFraction < 0.3 ? 'true' : 'false';
    this.hpText.textContent = `${stats.hp} / ${stats.maxHp}`;

    // Resource globe: fill + palette by type, numbers floored (wire truth).
    const resource = stats.resource;
    if (resource.type !== this.resourceType) {
      this.resourceType = resource.type;
      const palette = RESOURCE_COLORS[resource.type] ?? RESOURCE_COLORS['mana']!;
      this.resourceFill.style.background = `linear-gradient(180deg, ${palette.fill}, ${palette.deep})`;
      this.cpEl.hidden = !resource.showComboPoints;
      if (resource.showComboPoints && this.cpEl.childElementCount === 0) {
        this.cpEl.innerHTML = Array.from(
          { length: 5 },
          (_, i) => `<span class="hud-cp-pip" data-pip="${i}"></span>`,
        ).join('');
      }
    }
    const resourceFraction = resource.max > 0 ? resource.value / resource.max : 0;
    this.resourceFill.style.height = `${(Math.min(1, resourceFraction) * 100).toFixed(1)}%`;
    this.resourceText.textContent = `${Math.floor(resource.value)}`;
    if (resource.showComboPoints) {
      const pips = this.cpEl.children;
      for (let i = 0; i < pips.length; i++) {
        (pips[i] as HTMLElement).dataset.lit = i < resource.comboPoints ? 'true' : 'false';
      }
      this.cpEl.dataset.full = resource.comboPoints >= 5 ? 'true' : 'false';
    }

    // Stance tint on the resource globe frame (shield up / evasive).
    this.resourceGlobeEl.dataset.stance = stats.stanceHeld ? 'true' : 'false';

    // Hotbar + V tile.
    this.updateSlots(stats.slots, resource.comboPoints);
    if (this.dodgeTile) this.dodgeTile.dataset.state = stats.dodgeReady ? 'ready' : 'poor';

    // Cast bar (above the hotbar; P5 kits are instants so usually hidden).
    if (stats.cast) {
      this.castEl.hidden = false;
      this.castFill.style.width = `${(stats.cast.fraction * 100).toFixed(1)}%`;
      this.castName.textContent = stats.cast.name;
    } else {
      this.castEl.hidden = true;
    }

    // Buff/debuff rows.
    this.renderEffects(this.effectsEl, stats.selfEffects, 'effectsKey');

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
      this.renderEffects(this.targetEffectsEl, stats.targetEffects, 'targetEffectsKey');
    } else {
      this.targetEl.hidden = true;
      if (this.targetEffectsKey !== '') {
        this.targetEffectsKey = '';
        this.targetEffectsEl.innerHTML = '';
      }
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

/**
 * Auto glyph for ability tiles and effect chips: a two-letter monogram from
 * the name — the schema-sanctioned fallback until the curated icon atlas
 * (icon ids are already in the defs; empty means "monogram me").
 */
const monogram = (name: string): string => {
  const words = name.replace(/[_-]+/g, ' ').trim().split(/\s+/);
  if (words.length >= 2) return `${words[0]![0] ?? ''}${words[1]![0] ?? ''}`.toUpperCase();
  return (words[0] ?? '??').slice(0, 2).toUpperCase();
};
