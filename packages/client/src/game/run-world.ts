/**
 * The in-world game: canvas + netcode + debug HUD, started once the player has
 * picked a character. Extracted from the P0 entry point; the React shell mounts
 * and unmounts this (docs/tech/ARCHITECTURE.md §4 screen flow).
 */

import * as THREE from 'three';
import { EntityFlag, NoticeCode, TICK_MS, maxStaminaFor, type Appearance } from '@dawned/shared';
import { Connection } from '../net/connection.js';
import { InputController } from '../input/input.js';
import { GameScene } from '../world/scene.js';
import { CharacterView } from '../world/character-view.js';
import { loadCharacterAssets, type CharacterAssets } from '../world/characters.js';
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
  appearance: Appearance,
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

  const localView = new CharacterView(playerName);
  scene.scene.add(localView.group);

  const remoteViews = new Map<number, CharacterView>();

  // Rigs swap in whenever the shared assets land; the world never waits on them.
  let characterAssets: CharacterAssets | null = null;
  void loadCharacterAssets().then((assets) => {
    if (disposed || !assets.ok) return;
    characterAssets = assets;
    localView.applyAppearance(assets, appearance);
  });

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
    const dtSeconds = deltaMs / 1000;
    const position = connection.renderPosition();
    localView.setPose(position.x, position.y, position.z, connection.predicted.yaw);
    localView.update(dtSeconds, {
      grounded: connection.predicted.grounded,
      sprinting: connection.predicted.sprinting,
    });
    syncRemoteViews(dtSeconds);

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

  /** Create/advance/remove remote views to mirror the interpolated entity set. */
  const syncRemoteViews = (dtSeconds: number): void => {
    for (const [id, remote] of connection.remotes) {
      let view = remoteViews.get(id);
      if (!view) {
        view = new CharacterView(remote.name);
        remoteViews.set(id, view);
        scene.scene.add(view.group);
      }
      // Appearance and name ride the roster, which can trail the first snapshot —
      // apply as soon as (and whenever) known. Both calls no-op when unchanged.
      const entry = connection.rosterEntryFor(id);
      if (entry) {
        view.setName(entry.name);
        if (characterAssets) view.applyAppearance(characterAssets, entry.appearance);
      }

      view.setPose(remote.render.x, remote.render.y, remote.render.z, remote.render.yaw);
      view.update(dtSeconds, {
        grounded: (remote.render.flags & EntityFlag.Grounded) !== 0,
        sprinting: (remote.render.flags & EntityFlag.Sprinting) !== 0,
      });
    }
    for (const [id, view] of remoteViews) {
      if (!connection.remotes.has(id)) {
        view.dispose(scene.scene);
        remoteViews.delete(id);
      }
    }
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
