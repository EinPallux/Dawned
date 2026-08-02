/**
 * The in-world game: canvas + netcode + debug HUD, started once the player has
 * picked a character. Extracted from the P0 entry point; the React shell mounts
 * and unmounts this (docs/tech/ARCHITECTURE.md §4 screen flow).
 */

import * as THREE from 'three';
import { NoticeCode, TICK_MS, maxStaminaFor } from '@dawned/shared';
import { Connection, type RemoteEntity } from '../net/connection.js';
import { InputController } from '../input/input.js';
import { GameScene, PlayerView, remoteColorFor } from '../world/scene.js';
import { Hud } from '../ui/hud.js';

export interface WorldHandle {
  dispose: () => void;
}

export interface WorldCallbacks {
  /** Fired for terminal conditions the shell should surface (overlays). */
  onNotice: (code: NoticeCode, friendlyText: string) => void;
  onDisconnected: () => void;
}

/** WebSocket URL: same origin in production, Vite proxy in dev. */
const gameSocketUrl = (): string => {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/game`;
};

export const runWorld = (
  container: HTMLElement,
  token: string,
  characterId: number,
  playerName: string,
  callbacks: WorldCallbacks,
): WorldHandle => {
  const canvas = document.createElement('canvas');
  canvas.className = 'game';
  container.appendChild(canvas);

  const scene = new GameScene(canvas);
  const hud = new Hud(
    container,
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
          hud.setStatus('disconnected', 'error');
          if (everPlayed) callbacks.onDisconnected();
          break;
        case 'error':
          hud.setStatus(detail ?? 'connection error', 'error');
          break;
      }
    },
    onNotice: callbacks.onNotice,
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
  connection.connect(gameSocketUrl(), token, characterId);

  const localView = new PlayerView(playerName, scene.localPlayerColor, true);
  scene.scene.add(localView.group);

  const remoteViews = new Map<number, PlayerView>();

  /** Debug/automation handle (tools/smoke/browser-sync.mjs). Safe: the server owns all state. */
  (window as unknown as { __dawned?: unknown }).__dawned = {
    connection,
    input,
    scene,
    remoteSnapshot: (): Record<string, { x: number; y: number; z: number }> => {
      const out: Record<string, { x: number; y: number; z: number }> = {};
      for (const remote of connection.remotes.values()) {
        out[remote.name] = { x: remote.render.x, y: remote.render.y, z: remote.render.z };
      }
      return out;
    },
  };

  // --- loop ------------------------------------------------------------------

  let accumulatorMs = 0;
  let lastFrameMs = performance.now();
  let fps = 0;
  let disposed = false;
  const cameraTarget = new THREE.Vector3();

  const frame = (): void => {
    if (disposed) return;
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

    // 2. Per-frame networking housekeeping (corrections, interpolation).
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

  return {
    dispose: () => {
      disposed = true;
      connection.disconnect();
      container.replaceChildren();
    },
  };
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
