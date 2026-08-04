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
  /** Absorb pool left on shield effects (P6) — rendered on the chip. */
  shieldRemaining?: number;
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
  /** Ally plate (P6, Q20): green frame — the heal's would-be recipient. */
  targetFriendly: boolean;
  grounded: boolean;
  sprinting: boolean;
  swimming: boolean;
  players: number;
  // --- combat cluster (P5-D) ----------------------------------------------
  resource: HudResource;
  /** Hotbar slots 1..8, polled from the connection's shared machine. */
  slots: SlotView[];
  /** Active cast or channel bar (null = hidden). Channels drain + show pips. */
  cast: {
    kind: 'cast' | 'channel';
    name: string;
    fraction: number;
    ticks: number;
    ticksDone: number;
  } | null;
  selfEffects: readonly HudEffect[];
  targetEffects: readonly HudEffect[];
  /** Stamina covers a dodge right now — the V tile's lit state. */
  dodgeReady: boolean;
  /** RMB stance currently held (shield glyph tint). */
  stanceHeld: boolean;
  /** Mage Focus held — the reticle tightens (P6). */
  focusHeld: boolean;
  /** Hard CC on self (P6) — the center ribbon says why input is dead. */
  ccState: 'stunned' | 'rooted' | null;
  /** Mage Attunement pips 0–2 (null = not a mage). */
  attunement: number | null;
  // --- progression (P7-D) ---------------------------------------------------
  /** Level + absolute bar position (null until the first ProgressSync). */
  progress: { level: number; xp: number; xpToNext: number } | null;
  /** Banked points → the micro-menu badge pips (§7: gentle, never a modal). */
  unspentStatPoints: number;
  unspentSkillPoints: number;
  /** Which panel is open (micro-menu tiles light up). */
  openPanel: 'character' | 'skills' | 'inventory' | 'vendor' | null;
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
  private readonly castTicksEl: HTMLElement;
  private readonly ccEl: HTMLElement;
  private readonly reticleEl: HTMLElement;
  private readonly attuneEl: HTMLElement;
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
  /** Channel pip row cache (rebuild only when the tick count changes). */
  private castTicksCount = -1;
  /** Interrupted flash: the bar stays up in its red state until this time. */
  private interruptedUntilMs = 0;
  private attunementShown = -2; // -1 = hidden (non-mage)
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
  // --- progression (P7-D) ---------------------------------------------------
  private readonly toastsEl: HTMLElement;
  private readonly xpFillEl: HTMLElement;
  private readonly xpLabelEl: HTMLElement;
  private readonly xpBarEl: HTMLElement;
  private readonly xpBurstCanvas: HTMLCanvasElement;
  private readonly levelFlashEl: HTMLElement;
  private readonly microBadgeC: HTMLElement;
  private readonly microBadgeK: HTMLElement;
  private readonly microTiles = new Map<string, HTMLElement>();
  private readonly interactEl: HTMLElement;
  private readonly purseEl: HTMLElement;
  /** Rising gold sparks over the XP bar while a level-up burst runs. */
  private xpBurstParticles: { x: number; y: number; vx: number; vy: number; life: number }[] = [];
  private xpBurstRafArmed = false;
  /** Last rendered xp state (skip DOM writes when nothing moved). */
  private xpShown = { level: -1, xp: -1, xpToNext: -1 };
  /** kbps window: last sample of the cumulative byte counters. */
  private lastBytes = { in: 0, out: 0, at: 0 };
  private rateKbps = { in: 0, out: 0 };

  constructor(
    parent: HTMLElement,
    private readonly onChatSubmit: (text: string) => void,
    private readonly onChatFocusChange: (focused: boolean) => void,
    private readonly onRespawn: () => void = () => undefined,
    private readonly onMenuAction: (panel: 'character' | 'skills' | 'inventory') => void = () =>
      undefined,
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
      <div class="hud-cc" data-cc hidden></div>
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
          <div class="hud-cast-ticks" data-cast-ticks></div>
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
            <div class="hud-attune" data-attune hidden></div>
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
      <div class="hud-toasts" data-toasts></div>
      <div class="hud-micromenu" data-micromenu>
        <button class="hud-micro" data-micro="character" type="button">
          <span class="hud-micro-glyph">◆</span>
          <span class="hud-micro-badge" data-badge-c hidden></span>
          <span class="hud-micro-label">Character · C</span>
        </button>
        <button class="hud-micro" data-micro="skills" type="button">
          <span class="hud-micro-glyph">✦</span>
          <span class="hud-micro-badge" data-badge-k hidden></span>
          <span class="hud-micro-label">Skills · K</span>
        </button>
        <button class="hud-micro" data-micro="inventory" type="button">
          <span class="hud-micro-glyph">▣</span>
          <span class="hud-micro-label">Pack · I</span>
        </button>
        <span class="hud-purse" data-purse hidden></span>
      </div>
      <!-- World interaction prompt (P8): loot bags and market posts. -->
      <div class="hud-interact" data-interact hidden></div>
      <div class="hud-xpbar" data-xpbar>
        <div class="hud-xpbar-fill" data-xp-fill></div>
        <div class="hud-xpbar-ticks">${Array.from({ length: 9 }, (_, i) => `<span style="left:${(i + 1) * 10}%"></span>`).join('')}</div>
        <canvas class="hud-xpbar-burst" data-xp-burst width="360" height="56"></canvas>
        <span class="hud-xpbar-label" data-xp-label></span>
      </div>
      <div class="hud-levelflash" data-levelflash hidden></div>
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
    this.interactEl = this.query('[data-interact]');
    this.purseEl = this.query('[data-purse]');
    this.targetEl = this.query('[data-target]');
    this.targetNameEl = this.query('[data-target-name]');
    this.targetHpFill = this.query('[data-target-hp]');
    this.targetEffectsEl = this.query('[data-target-effects]');
    this.effectsEl = this.query('[data-effects]');
    this.castEl = this.query('[data-cast]');
    this.castFill = this.query('[data-cast-fill]');
    this.castName = this.query('[data-cast-name]');
    this.castTicksEl = this.query('[data-cast-ticks]');
    this.ccEl = this.query('[data-cc]');
    this.reticleEl = this.query('[data-reticle]');
    this.attuneEl = this.query('[data-attune]');
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
    this.toastsEl = this.query('[data-toasts]');
    this.xpBarEl = this.query('[data-xpbar]');
    this.xpFillEl = this.query('[data-xp-fill]');
    this.xpLabelEl = this.query('[data-xp-label]');
    this.xpBurstCanvas = this.query('[data-xp-burst]') as HTMLCanvasElement;
    this.levelFlashEl = this.query('[data-levelflash]');
    this.microBadgeC = this.query('[data-badge-c]');
    this.microBadgeK = this.query('[data-badge-k]');
    for (const tile of this.root.querySelectorAll<HTMLElement>('[data-micro]')) {
      const panel = tile.dataset.micro as 'character' | 'skills' | 'inventory';
      this.microTiles.set(panel, tile);
      tile.addEventListener('click', () => {
        this.onMenuAction(panel);
      });
    }

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

  /**
   * The world-interaction prompt (P8): what `F` would do right now, or null
   * when it would do nothing. One line, bottom-centre, never a modal.
   */
  setInteractPrompt(text: string | null): void {
    this.interactEl.hidden = text === null;
    if (text !== null) this.interactEl.textContent = text;
  }

  /** Purse readout beside the micro menu; hidden until the first sync. */
  setGold(gold: number | null): void {
    this.purseEl.hidden = gold === null;
    if (gold !== null) this.purseEl.textContent = `${gold} g`;
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

  /** The cast bar flashes red for a beat when a stun broke the cast (P6). */
  flashInterrupted(): void {
    this.interruptedUntilMs = performance.now() + 650;
  }

  // --- progression (P7-D) ---------------------------------------------------

  /**
   * Toast (UI_UX.md §2): slide-in right, dwell, fade; stack max 5, oldest
   * collapse into "+n more". `onClick` makes it a click-to-open shortcut
   * (unlock toasts open the Skills panel).
   */
  toast(
    text: string,
    /** Tone tints the left rule: rarity for loot, red for refusals. */
    opts: {
      onClick?: () => void;
      tone?: 'gold' | 'xp' | 'red' | 'plain' | 'uncommon' | 'rare' | 'epic' | 'legendary';
    } = {},
  ): void {
    const row = document.createElement('div');
    row.className = 'hud-toast';
    if (opts.tone) row.dataset.tone = opts.tone;
    row.textContent = text;
    if (opts.onClick) {
      row.classList.add('is-clickable');
      row.addEventListener('click', () => {
        opts.onClick?.();
        row.remove();
        this.collapseToasts();
      });
    }
    this.toastsEl.appendChild(row);
    this.collapseToasts();
    setTimeout(() => {
      row.classList.add('is-leaving');
      setTimeout(() => {
        row.remove();
        this.collapseToasts();
      }, 260);
    }, 4500);
  }

  /** Keep at most 5 visible; older ones fold into a single "+n more" line. */
  private collapseToasts(): void {
    const rows = [...this.toastsEl.children].filter(
      (el) => !el.classList.contains('hud-toast-more'),
    ) as HTMLElement[];
    let more = this.toastsEl.querySelector<HTMLElement>('.hud-toast-more');
    const excess = rows.length - 5;
    if (excess > 0) {
      for (let i = 0; i < excess; i++) rows[i]!.hidden = true;
      if (!more) {
        more = document.createElement('div');
        more.className = 'hud-toast hud-toast-more';
        this.toastsEl.prepend(more);
      }
      more.textContent = `+${excess} more`;
    } else {
      for (const row of rows) row.hidden = false;
      more?.remove();
    }
  }

  /** Quick highlight on the XP bar when an award lands (§7: bar always ticks). */
  xpPulse(): void {
    this.xpBarEl.classList.remove('is-pulse');
    void this.xpBarEl.offsetWidth;
    this.xpBarEl.classList.add('is-pulse');
  }

  /**
   * Level-up juice, HUD half (PROGRESSION.md §1.3): gold flash frame around
   * the HUD (600 ms) + a particle burst riding the XP bar (DOM canvas).
   * The world half (pillar, Celebration) runs in run-world.
   */
  levelUpJuice(): void {
    this.levelFlashEl.hidden = false;
    this.levelFlashEl.classList.remove('is-live');
    void this.levelFlashEl.offsetWidth;
    this.levelFlashEl.classList.add('is-live');
    setTimeout(() => {
      this.levelFlashEl.hidden = true;
    }, 700);

    // Gold sparks rise off the bar for ~0.9 s.
    const canvas = this.xpBurstCanvas;
    if (canvas.width !== canvas.clientWidth && canvas.clientWidth > 0) {
      canvas.width = canvas.clientWidth; // match CSS width — crisp sparks
    }
    const w = canvas.width;
    for (let i = 0; i < 42; i++) {
      this.xpBurstParticles.push({
        x: Math.random() * w,
        y: canvas.height - 4,
        vx: (Math.random() - 0.5) * 30,
        vy: -60 - Math.random() * 90,
        life: 0.5 + Math.random() * 0.45,
      });
    }
    if (!this.xpBurstRafArmed) {
      this.xpBurstRafArmed = true;
      let last = performance.now();
      const tick = (): void => {
        const now = performance.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          this.xpBurstRafArmed = false;
          return;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        this.xpBurstParticles = this.xpBurstParticles.filter((p) => (p.life -= dt) > 0);
        for (const p of this.xpBurstParticles) {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.vy += 140 * dt;
          ctx.globalAlpha = Math.min(1, p.life * 2.2);
          ctx.fillStyle = '#f0c46b';
          ctx.fillRect(p.x, p.y, 2.5, 2.5);
        }
        ctx.globalAlpha = 1;
        if (this.xpBurstParticles.length > 0) requestAnimationFrame(tick);
        else this.xpBurstRafArmed = false;
      };
      requestAnimationFrame(tick);
    }
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
      .map(
        (e) =>
          `${e.effectId}:${e.stacks}:${Math.ceil(e.remainingMs / 1000)}:${e.harmful}:${e.shieldRemaining ?? 0}`,
      )
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
        // Shield chips wear the absorb pool left instead of the clock — the
        // number IS the state (the duration still bounds it server-side).
        const meter =
          effect.shieldRemaining !== undefined && effect.shieldRemaining > 0
            ? `<span class="hud-effect-s is-shield">${effect.shieldRemaining}</span>`
            : `<span class="hud-effect-s">${seconds}s</span>`;
        return `<div class="hud-effect${effect.harmful ? ' is-harmful' : ''}" title="${escapeHtml(effect.effectId)}">
          ${glyph}${stacks ? `<span class="hud-effect-stacks">${stacks}</span>` : ''}
          ${meter}
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

    // Cast/channel bar above the hotbar (P6): casts fill toward release,
    // channels drain toward their end with a pip per fired bolt. A stun's
    // Interrupted flash briefly outlives the (already-cleared) cast.
    const interrupted = now < this.interruptedUntilMs;
    if (stats.cast && !interrupted) {
      this.castEl.hidden = false;
      this.castEl.dataset.kind = stats.cast.kind;
      this.castEl.classList.remove('is-interrupted');
      const fillFraction =
        stats.cast.kind === 'channel' ? 1 - stats.cast.fraction : stats.cast.fraction;
      this.castFill.style.width = `${(fillFraction * 100).toFixed(1)}%`;
      this.castName.textContent = stats.cast.name;
      if (stats.cast.ticks !== this.castTicksCount) {
        this.castTicksCount = stats.cast.ticks;
        this.castTicksEl.innerHTML = Array.from(
          { length: Math.max(0, stats.cast.ticks - 1) },
          (_, i) =>
            `<span class="hud-cast-tick" style="left:${(((i + 1) / stats.cast!.ticks) * 100).toFixed(1)}%"></span>`,
        ).join('');
      }
      const pips = this.castTicksEl.children;
      for (let i = 0; i < pips.length; i++) {
        (pips[i] as HTMLElement).dataset.done = i < stats.cast.ticksDone ? 'true' : 'false';
      }
    } else if (interrupted) {
      this.castEl.hidden = false;
      this.castEl.classList.add('is-interrupted');
      this.castFill.style.width = '100%';
      this.castName.textContent = 'INTERRUPTED';
    } else {
      this.castEl.hidden = true;
      this.castEl.classList.remove('is-interrupted');
      if (this.castTicksCount !== 0) {
        this.castTicksCount = 0;
        this.castTicksEl.innerHTML = '';
      }
    }

    // Hard-CC ribbon (P6): the one moment input deadness must explain itself.
    const cc = stats.ccState;
    this.ccEl.hidden = cc === null;
    if (cc !== null) {
      const label = cc === 'stunned' ? 'STUNNED' : 'ROOTED';
      if (this.ccEl.textContent !== label) this.ccEl.textContent = label;
      this.ccEl.dataset.cc = cc;
    }

    // Focus stance: the reticle tightens while the mage slow-strafes (P6).
    this.reticleEl.dataset.focus = stats.focusHeld ? 'true' : 'false';

    // Attunement pips (mage): every third landed bolt refunds mana (P6).
    const attunement = stats.attunement ?? -1;
    if (attunement !== this.attunementShown) {
      this.attunementShown = attunement;
      this.attuneEl.hidden = attunement < 0;
      if (attunement >= 0 && this.attuneEl.childElementCount === 0) {
        this.attuneEl.innerHTML = Array.from(
          { length: 2 },
          () => `<span class="hud-attune-pip"></span>`,
        ).join('');
      }
      const pips = this.attuneEl.children;
      for (let i = 0; i < pips.length; i++) {
        (pips[i] as HTMLElement).dataset.lit = i < attunement ? 'true' : 'false';
      }
    }

    // XP bar (P7-D, §3 layout: thin bar, full bottom edge, segment ticks).
    const progress = stats.progress;
    if (progress) {
      if (
        progress.level !== this.xpShown.level ||
        progress.xp !== this.xpShown.xp ||
        progress.xpToNext !== this.xpShown.xpToNext
      ) {
        this.xpShown = { ...progress };
        const capped = progress.xpToNext <= 0;
        const fraction = capped ? 1 : Math.min(1, progress.xp / progress.xpToNext);
        this.xpFillEl.style.width = `${(fraction * 100).toFixed(2)}%`;
        this.xpLabelEl.textContent = capped
          ? `LEVEL ${progress.level} · MAX`
          : `LEVEL ${progress.level} · ${progress.xp.toLocaleString('en-US')} / ${progress.xpToNext.toLocaleString('en-US')} XP`;
      }
    }

    // Micro-menu badges: the §7 "gentle pip" for banked points.
    const statPts = stats.unspentStatPoints;
    const skillPts = stats.unspentSkillPoints;
    this.microBadgeC.hidden = statPts <= 0;
    if (statPts > 0) this.microBadgeC.textContent = String(statPts);
    this.microBadgeK.hidden = skillPts <= 0;
    if (skillPts > 0) this.microBadgeK.textContent = String(skillPts);
    for (const [panel, tile] of this.microTiles) {
      tile.dataset.open = stats.openPanel === panel ? 'true' : 'false';
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
      this.targetEl.dataset.friendly = stats.targetFriendly ? 'true' : 'false';
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
