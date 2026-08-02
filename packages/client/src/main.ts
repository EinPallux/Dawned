/**
 * Client entry point: login → world.
 *
 * The loop is deliberately split:
 *  - a FIXED-timestep simulation at the server tick rate, which is what gets
 *    predicted and sent (matching ticks is what makes reconciliation exact),
 *  - a variable-rate render pass that draws interpolated state.
 * Never simulate on the render clock — that path leads to desync.
 */

import './styles.css';
import * as THREE from 'three';
import { NoticeCode, TICK_MS, maxStaminaFor } from '@dawned/shared';
import { Connection, type RemoteEntity } from './net/connection.js';
import { InputController } from './input/input.js';
import { GameScene, PlayerView, remoteColorFor } from './world/scene.js';
import { Hud } from './ui/hud.js';

const app = document.getElementById('app');
if (!app) throw new Error('#app container missing from index.html');

/** WebSocket URL: same origin in production, Vite proxy in dev. */
const gameSocketUrl = (): string => {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/game`;
};

const supportsWebGL2 = (): boolean => {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
};

let overlayShown = false;
const showOverlay = (title: string, text: string, withReloadButton = false): void => {
  if (overlayShown) return; // first message wins; stacking overlays helps nobody
  overlayShown = true;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div><div class="overlay-title">${title}</div><div class="overlay-text">${text}</div>${
    withReloadButton ? '<button class="overlay-button" type="button">RELOAD</button>' : ''
  }</div>`;
  overlay.querySelector('button')?.addEventListener('click', () => {
    location.reload();
  });
  document.body.appendChild(overlay);
};

// ---------------------------------------------------------------------------
// Login (P1 replaces this with real accounts + character select)
// ---------------------------------------------------------------------------

const showLogin = (): void => {
  const login = document.createElement('div');
  login.className = 'login';
  login.innerHTML = `
    <div class="login-card">
      <h1 class="login-title">DAWNED</h1>
      <p class="login-sub">Phase 0 · walking skeleton</p>
      <input id="name" placeholder="Choose a name" maxlength="16" autocomplete="off" spellcheck="false" />
      <button id="enter">ENTER THE WORLD</button>
      <div class="login-error" id="login-error"></div>
    </div>
  `;
  document.body.appendChild(login);

  const nameInput = login.querySelector<HTMLInputElement>('#name')!;
  const button = login.querySelector<HTMLButtonElement>('#enter')!;
  const errorEl = login.querySelector<HTMLElement>('#login-error')!;

  const saved = localStorage.getItem('dawned.name');
  if (saved) nameInput.value = saved;
  nameInput.focus();

  const submit = (): void => {
    const name = nameInput.value.trim();
    if (!/^[A-Za-z0-9_]{2,16}$/.test(name)) {
      errorEl.textContent = 'Names are 2–16 characters: letters, digits and underscore.';
      return;
    }
    localStorage.setItem('dawned.name', name);
    login.remove();
    startGame(name);
  };

  button.addEventListener('click', submit);
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
};

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

const startGame = (name: string): void => {
  const canvas = document.createElement('canvas');
  canvas.className = 'game';
  app.appendChild(canvas);

  const scene = new GameScene(canvas);
  const hud = new Hud(
    document.body,
    (text) => {
      connection.sendChat(text);
    },
    (focused) => {
      input.textEntryActive = focused;
    },
  );

  let everPlayed = false;
  const connection = new Connection({
    onStatus: (status, detail) => {
      switch (status) {
        case 'playing':
          everPlayed = true;
          hud.setStatus('connected · in world', 'ok');
          break;
        case 'connecting':
        case 'connected':
          hud.setStatus('connecting…', 'warn');
          break;
        case 'closed':
          hud.setStatus('disconnected — reload to reconnect', 'error');
          break;
        case 'error':
          hud.setStatus(detail ?? 'connection error', 'error');
          break;
      }
    },
    onNotice: (code, friendlyText) => {
      if (code === NoticeCode.ServerShuttingDown) {
        // Deploys restart the server in seconds (UPDATE.sh) — reload onto the
        // login screen automatically; the saved name makes rejoining two clicks.
        showOverlay('Restarting', 'The world is restarting — reloading in a few seconds…');
        setTimeout(() => {
          location.reload();
        }, 5000);
      } else if (!everPlayed) {
        // Rejected before entering (name taken, server full, old client…):
        // without this the player would sit on an empty world with only a tiny
        // status line explaining why.
        showOverlay('Could not enter the world', friendlyText, true);
      }
    },
    onChat: (message) => {
      hud.addChat(message);
    },
    onRoster: (players) => {
      hud.setRoster(players, connection.selfId);
    },
  });

  const input = new InputController(canvas, () => {
    hud.focusChat();
  });

  connection.predicted.maxStamina = maxStaminaFor(1, 0);
  connection.predicted.stamina = connection.predicted.maxStamina;
  connection.connect(gameSocketUrl(), name);

  const localView = new PlayerView(name, scene.localPlayerColor, true);
  scene.scene.add(localView.group);

  const remoteViews = new Map<number, PlayerView>();

  /**
   * Debug/automation handle used by tools/smoke/browser-sync.mjs and by hand in the
   * console. Safe to expose: the client is never a security boundary — the server
   * owns all state (docs/tech/SECURITY.md §2).
   */
  (window as unknown as { __dawned?: unknown }).__dawned = {
    connection,
    input,
    scene,
    /** Positions of remote players as this client currently renders them. */
    remoteSnapshot: (): Record<string, { x: number; y: number; z: number }> => {
      const out: Record<string, { x: number; y: number; z: number }> = {};
      for (const remote of connection.remotes.values()) {
        out[remote.name] = { x: remote.render.x, y: remote.render.y, z: remote.render.z };
      }
      return out;
    },
  };

  // --- loop -----------------------------------------------------------------

  let accumulatorMs = 0;
  let lastFrameMs = performance.now();
  let fps = 0;
  const cameraTarget = new THREE.Vector3();

  const frame = (): void => {
    requestAnimationFrame(frame);

    const now = performance.now();
    const deltaMs = Math.min(250, now - lastFrameMs); // clamp: tab-switch safety
    lastFrameMs = now;
    fps = fps * 0.9 + (1000 / Math.max(deltaMs, 0.001)) * 0.1;

    // 1. Fixed-timestep simulation — one predicted tick per server tick.
    accumulatorMs += deltaMs;
    let ticks = 0;
    while (accumulatorMs >= TICK_MS && ticks < 5) {
      connection.simulateTick(input.sampleIntent());
      accumulatorMs -= TICK_MS;
      ticks++;
    }
    if (accumulatorMs > TICK_MS * 5) accumulatorMs = 0; // gave up catching up

    // 2. Per-frame networking housekeeping (corrections, interpolation, ping).
    connection.update(deltaMs);

    // 3. Draw.
    const position = connection.renderPosition();
    localView.setPose(position.x, position.y, position.z, connection.predicted.yaw);
    syncRemoteViews(connection.remotes, remoteViews, scene);

    cameraTarget.set(position.x, position.y, position.z);
    scene.updateCamera(cameraTarget, input.yaw, input.pitch);
    scene.render();

    hud.update({
      fps,
      ping: connection.rttMs,
      serverTick: connection.stats.serverTick,
      snapshots: connection.stats.snapshotsReceived,
      corrections: connection.stats.corrections,
      snaps: connection.stats.snaps,
      lastCorrectionM: connection.stats.lastCorrectionM,
      position,
      stamina: connection.predicted.stamina,
      maxStamina: connection.predicted.maxStamina,
      grounded: connection.predicted.grounded,
      sprinting: connection.predicted.sprinting,
      players: connection.remotes.size + 1,
    });
  };

  requestAnimationFrame(frame);
};

const syncRemoteViews = (
  remotes: Map<number, RemoteEntity>,
  views: Map<number, PlayerView>,
  scene: GameScene,
): void => {
  for (const [id, remote] of remotes) {
    let view = views.get(id);
    if (!view) {
      view = new PlayerView(remote.name, remoteColorFor(id), false);
      views.set(id, view);
      scene.scene.add(view.group);
    }
    view.setPose(remote.render.x, remote.render.y, remote.render.z, remote.render.yaw);
  }
  for (const [id, view] of views) {
    if (!remotes.has(id)) {
      view.dispose(scene.scene);
      views.delete(id);
    }
  }
};

// ---------------------------------------------------------------------------

if (!supportsWebGL2()) {
  showOverlay(
    'WebGL2 required',
    'Dawned needs a browser with WebGL2 — try a recent Chrome, Firefox or Safari on desktop.',
  );
} else if (window.innerWidth < 900) {
  showOverlay(
    'Desktop only',
    'Dawned is built desktop-first (1080p and 1440p). Mobile support is not planned for 0.1.0.',
  );
} else {
  showLogin();
}
