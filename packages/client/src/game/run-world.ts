/**
 * The in-world game: canvas + netcode + debug HUD, started once the player has
 * picked a character. Extracted from the P0 entry point; the React shell mounts
 * and unmounts this (docs/tech/ARCHITECTURE.md §4 screen flow).
 */

import * as THREE from 'three';
import {
  ActionId,
  BASIC_COMBOS,
  EntityEventKind,
  EntityFlag,
  EntityKind,
  HitFlag,
  MAP_VERSION,
  NoticeCode,
  SEA_LEVEL,
  TICK_MS,
  angleDelta,
  maxStaminaFor,
  playerStats,
  slotForAction,
  type Appearance,
} from '@dawned/shared';
import { Connection } from '../net/connection.js';
import { InputController } from '../input/input.js';
import { headingFromInput } from '../world/anim-math.js';
import { GameScene } from '../world/scene.js';
import { CharacterView } from '../world/character-view.js';
import { loadCharacterAssets, type CharacterAssets } from '../world/characters.js';
import { MapSource } from '../world/map-source.js';
import { TerrainManager } from '../world/terrain-manager.js';
import { AmbienceController } from '../world/ambience.js';
import { buildOceanMesh, updateWaterTime } from '../world/terrain-mesh.js';
import { loadFoliageAssets, updateFoliageWind } from '../world/foliage.js';
import { Hud } from '../ui/hud.js';
import { EnemyView, loadEnemyAssets, type EnemyAssets } from '../world/enemy-view.js';
import { TelegraphManager } from '../world/telegraphs.js';
import { CombatTextManager } from '../world/combat-text.js';
import { ProjectileManager } from '../world/projectiles.js';
import { AbilityVfxManager, abilityVfxColor } from '../world/ability-vfx.js';
import { CombatSfx, sfxSlotOf } from '../audio/combat-sfx.js';
import { loadEnemyDefs } from '../content/enemy-defs.js';
import { loadAbilityDefs } from '../content/ability-defs.js';
import type { AbilityDef, EnemyDef } from '@dawned/shared';

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

const HOTBAR_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8];

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
      handleChatSubmit(text);
    },
    (focused) => {
      input.textEntryActive = focused;
    },
    () => {
      connection.requestRespawn();
    },
  );

  // Terrain: the manager owns the sampler the prediction step walks on. Chunks,
  // walkgrid and zones stream in asynchronously; simulation is gated below until
  // the ground under the spawn is real.
  const mapSource = new MapSource(MAP_VERSION);
  const terrain = new TerrainManager(scene.scene, mapSource);
  scene.scene.add(buildOceanMesh(SEA_LEVEL));
  let ambience: AmbienceController | null = null;
  let walkgridReady = false;
  let mapReady = false;
  void mapSource
    .open()
    .then(async ({ zones }) => {
      ambience = new AmbienceController(scene.ambienceTargets, zones);
      mapReady = true;
      const walkgrid = await mapSource.loadWalkgrid();
      if (walkgrid) terrain.sampler.attachWalkgrid(walkgrid);
      walkgridReady = true;
    })
    .catch((error: unknown) => {
      console.error('[terrain] map artifacts failed to load:', error);
      hud.setStatus('map failed to load — refresh', 'error');
    });
  void loadFoliageAssets().then((assets) => {
    if (assets && !disposed) terrain.attachFoliage(assets);
  });

  let everPlayed = false;
  const connection = new Connection(
    {
      onStatus: (status, detail) => {
        switch (status) {
          case 'playing':
            everPlayed = true;
            hud.setStatus('connected · in world', 'ok');
            hud.setBanner(null);
            break;
          case 'connecting':
          case 'connected':
            hud.setStatus('connecting…', 'warn');
            break;
          case 'reconnecting':
            // The server holds our entity for 15 s (NETWORKING.md §6) — the
            // connection retries inside that window while inputs are frozen.
            hud.setStatus(`reconnecting… ${detail ?? ''}`, 'warn');
            hud.setBanner('Connection lost — reconnecting…');
            break;
          case 'closed':
            hud.setStatus('disconnected', 'error');
            hud.setBanner(null);
            if (everPlayed) callbacks.onDisconnected();
            break;
          case 'error':
            hud.setStatus(detail ?? 'connection error', 'error');
            hud.setBanner(null);
            break;
        }
      },
      onNotice: callbacks.onNotice,
      onWelcome: (welcome) => {
        // Look where the character faces on entry — a camera stuck at yaw 0
        // would stare into their face until the first mouse move.
        input.yaw = welcome.spawn.yaw;
      },
      onChat: (message) => {
        hud.addChat(message);
        // Bubble above the speaker (system lines stay chat-log only).
        if (!message.system) {
          if (message.fromId === connection.selfId) localView.showBubble(message.text);
          else remoteViews.get(message.fromId)?.showBubble(message.text);
        }
      },
      onRoster: (players) => {
        hud.setRoster(players, connection.selfId);
      },
      onAbilityStart: (message) => {
        if (message.entityId === connection.selfId) return; // predicted at press
        const remote = connection.remotes.get(message.entityId);
        if (!remote) return;
        if (remote.kind === EntityKind.Enemy) {
          enemyViews.get(message.entityId)?.playAbility(message.action, message.durationMs);
          return;
        }
        // Remote player basic swing: clip from their class's chain data.
        if (message.action === (ActionId.BasicAttack as number)) {
          const classId = connection.rosterEntryFor(message.entityId)?.classId ?? 'warrior';
          const step = BASIC_COMBOS[classId].steps[message.step];
          if (step) {
            remoteViews
              .get(message.entityId)
              ?.playAttack(step.clip, step.clipSeconds, message.durationMs);
          }
          return;
        }
        // Remote player slot ability: def by their class + slot (v7).
        const slot = slotForAction(message.action);
        if (slot !== null) {
          const classId = connection.rosterEntryFor(message.entityId)?.classId ?? 'warrior';
          const def = connection.abilityDefFor(classId, slot);
          const view = remoteViews.get(message.entityId);
          if (def && view) {
            view.playAttack(def.anim.clip, def.anim.clipSeconds, message.durationMs);
            const p = view.group.position;
            abilityCommitVfx(def, p.x, p.y, p.z, message.yaw);
          }
        }
      },
      onAbilityResolve: (message) => {
        const mine = message.attackerId === connection.selfId;
        for (const hit of message.hits) {
          const crit = (hit.flags & HitFlag.Crit) !== 0;
          const anchor = fctAnchor(hit.targetId);
          if (anchor) {
            const kind =
              hit.targetId === connection.selfId ? 'incoming' : crit ? 'outgoing-crit' : 'outgoing';
            combatText.spawn(kind, hit.amount, anchor.x, anchor.y, anchor.z);
            // Impact burst at the wound point (§9 VFX v1) — crits pop harder.
            if (hit.targetId !== connection.selfId) {
              vfx.burst(
                anchor.x,
                anchor.y - 0.5,
                anchor.z,
                crit ? 0xf0c46b : 0xffa75e,
                crit ? 18 : 8,
                crit ? 4 : 2.6,
                0.35,
              );
            }
          }
          enemyViews.get(hit.targetId)?.flash();
          if ((hit.flags & HitFlag.Killed) !== 0) sfx.play('death');
        }
        if (mine && message.hits.length > 0) {
          // Contact confirmed: hit-stop + directional kick + impact layer (§9).
          hitStopUntilMs = performance.now() + 60;
          scene.addKick(
            input.yaw,
            message.hits.some((h) => (h.flags & HitFlag.Crit) !== 0) ? 1.4 : 1,
          );
          sfx.play(
            message.hits.some((h) => (h.flags & HitFlag.Crit) !== 0) ? 'impact_crit' : 'impact',
          );
        }
      },
      onAbilityReject: (action) => {
        // The server refused a predicted slot press (real divergence): the
        // rolled-back slot pulses so the player knows the cast didn't happen.
        const slot = slotForAction(action);
        if (slot !== null) {
          hud.pulseSlot(slot);
          sfx.play('deny', 0.8);
        }
      },
      onEntityEvent: (message) => {
        switch (message.event) {
          case EntityEventKind.Alert:
            enemyViews.get(message.entityId)?.playAlert();
            break;
          case EntityEventKind.Stagger:
            enemyViews.get(message.entityId)?.playHitReact();
            break;
          case EntityEventKind.Flinch:
            if (message.entityId === connection.selfId) {
              localView.playFlinch();
              scene.addShake(1);
              sfx.play('hurt');
            } else if (connection.remotes.get(message.entityId)?.kind === EntityKind.Player) {
              remoteViews.get(message.entityId)?.playFlinch();
            }
            break;
          case EntityEventKind.Death:
            if (message.entityId === connection.selfId) sfx.play('death');
            break;
          default:
            break;
        }
      },
      onTelegraph: (message) => {
        telegraphs.show(message);
      },
      onProjectileSpawn: (message) => {
        projectiles.spawn(message);
        sfx.play('bolt', 0.7);
      },
      onProjectileEnd: (message) => {
        projectiles.end(message);
      },
    },
    terrain.sampler,
    (x, z) => terrain.isGroundReadyAt(x, z),
  );

  /** Client-side commands (`/netsim`) — anything else goes to the server. */
  const handleChatSubmit = (text: string): void => {
    const netsim = /^\/netsim(?:\s+(\d+))?(?:\s+(\d+))?\s*$/.exec(text);
    if (netsim) {
      const rtt = Number(netsim[1] ?? 0);
      const jitter = Number(netsim[2] ?? 0);
      connection.setNetsim(rtt, jitter);
      hud.addChat({
        from: '',
        fromId: 0,
        system: true,
        text:
          rtt > 0 || jitter > 0
            ? `Lag lab: injecting ${rtt} ms RTT ± ${jitter} ms jitter (local only). "/netsim" to reset.`
            : 'Lag lab off.',
      });
      return;
    }
    connection.sendChat(text);
  };

  const input = new InputController(canvas, () => {
    hud.focusChat();
  });

  connection.predicted.maxStamina = maxStaminaFor(1, 0);
  connection.predicted.stamina = connection.predicted.maxStamina;
  connection.connect(gameSocketUrl(), token, characterId);

  const localView = new CharacterView(playerName);
  scene.scene.add(localView.group);

  const remoteViews = new Map<number, CharacterView>();
  const enemyViews = new Map<number, EnemyView>();
  const enemyLastPos = new Map<number, { x: number; z: number }>();

  // --- combat presentation (P4) --------------------------------------------
  const telegraphs = new TelegraphManager(scene.scene, terrain.sampler);
  const combatText = new CombatTextManager(scene.scene);
  const projectiles = new ProjectileManager(scene.scene);
  const vfx = new AbilityVfxManager(scene.scene);
  const sfx = new CombatSfx();
  canvas.addEventListener('mousedown', () => {
    sfx.unlock();
  });
  let enemyAssets: EnemyAssets | null = null;
  void loadEnemyAssets().then((assets) => {
    if (!disposed) enemyAssets = assets;
  });
  let enemyDefs = new Map<string, EnemyDef>();
  void loadEnemyDefs().then((defs) => {
    if (!disposed) enemyDefs = defs;
  });
  // Published ability defs → the prediction layer (hotbar, chains, costs).
  void loadAbilityDefs().then((defs) => {
    if (!disposed) connection.setAbilityContent(defs);
  });
  /** Attacker anim runs at 0.1× until this time — the §9 hit-stop. */
  let hitStopUntilMs = 0;
  /** Wall time the current death began (0 = alive) — drives the §10 beat. */
  let deathStartedMs = 0;
  /** The soul screen waits for the death clip + camera drift to land. */
  const DEATH_SOUL_DELAY_MS = 1800;
  /**
   * One LMB press: predicted chain via the shared rules, swing anim NOW, and
   * the request on the wire. Aim pitch leans a fraction of the camera pitch so
   * mid-range bolts fly at torso height, not into the ground (feel-tunable).
   */
  const performAttackPress = (): boolean => {
    const accepted = connection.requestBasicAttack(input.yaw, -input.pitch * 0.35);
    if (!accepted) return false;
    localView.playAttack(accepted.def.clip, accepted.def.clipSeconds, accepted.def.durationMs);
    sfx.play('whoosh');
    return true;
  };

  /** Commit-moment VFX for an ability, at any caster (self or remote). */
  const abilityCommitVfx = (
    def: AbilityDef,
    x: number,
    y: number,
    z: number,
    yaw: number,
  ): void => {
    const school = def.effects.find((e) => e.kind === 'damage')?.school ?? 'physical';
    const color = abilityVfxColor(def.classId, school);
    switch (def.targeting.kind) {
      case 'melee_arc':
        vfx.trail(x, y, z, yaw, def.targeting.reach, color);
        break;
      case 'cone':
        vfx.trail(x, y, z, yaw, def.targeting.reach * 0.7, color);
        vfx.spray(x, y + 1.1, z, yaw, (def.targeting.angleDeg * Math.PI) / 180, color, 12, 7, 0.3);
        break;
      case 'pbaoe':
        vfx.ring(x, y, z, def.targeting.radius, color);
        break;
      case 'dash':
        vfx.spray(x, y + 0.5, z, yaw + Math.PI, 0.7, color, 10, 4, 0.35);
        break;
      case 'blink_behind':
        vfx.burst(x, y + 1.0, z, 0x8a7ce8, 16, 2.2, 0.4);
        break;
      default:
        // Self buffs and the rest: an upward gold sparkle at the caster.
        vfx.burst(x, y + 1.2, z, 0xf0c46b, 10, 1.6, 0.5);
        break;
    }
  };

  /**
   * One hotbar press: predicted evaluate → commit through the shared machine
   * (connection), then the §9 presentation — anim, sfx slot, commit VFX. A
   * local refusal pulses the slot immediately (no round trip).
   */
  const performSlotPress = (slot: number): void => {
    const target = softTarget();
    const before = connection.renderPosition();
    const result = connection.requestSlotAbility(
      slot,
      input.yaw,
      -input.pitch * 0.35,
      target ? { id: target.id, radius: target.radius } : null,
    );
    if (!result.ok) {
      if (result.reason !== null) {
        hud.pulseSlot(slot);
        sfx.play('deny', 0.8);
      }
      return;
    }
    const def = result.def;
    localView.playAttack(def.anim.clip, def.anim.clipSeconds, def.anim.durationMs);
    sfx.play(sfxSlotOf(def.sfx));
    abilityCommitVfx(def, before.x, before.y, before.z, input.yaw);
    // Shadowstep lands elsewhere — a second burst where we arrived.
    if (def.targeting.kind === 'blink_behind') {
      const after = connection.renderPosition();
      vfx.burst(after.x, after.y + 1.0, after.z, 0x8a7ce8, 16, 2.2, 0.4);
    }
  };
  /** Where FCT for a target entity should appear. */
  const fctAnchor = (entityId: number): { x: number; y: number; z: number } | null => {
    if (entityId === connection.selfId) {
      const p = connection.renderPosition();
      return { x: p.x, y: p.y + 1.9, z: p.z };
    }
    const remote = connection.remotes.get(entityId);
    if (!remote) return null;
    const lift = remote.kind === EntityKind.Enemy ? 1.4 : 1.9;
    return { x: remote.render.x, y: remote.render.y + lift, z: remote.render.z };
  };

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
    terrainStats: (): { resident: number; pending: number; zone: string | null } => ({
      resident: terrain.residentCount,
      pending: terrain.pendingCount,
      zone: ambience?.zone?.id ?? null,
    }),
    rendererInfo: (): { calls: number; triangles: number } => ({
      calls: scene.renderer.info.render.calls,
      triangles: scene.renderer.info.render.triangles,
    }),
    remoteSnapshot: (): Record<string, { x: number; y: number; z: number }> => {
      const out: Record<string, { x: number; y: number; z: number }> = {};
      for (const remote of connection.remotes.values()) {
        out[remote.name] = { x: remote.render.x, y: remote.render.y, z: remote.render.z };
      }
      return out;
    },
    /** Full attack-press path for smokes (pointer lock is unreliable headless). */
    attack: (): boolean => performAttackPress(),
    /** Full hotbar-press path for smokes — identical to a 1–8 key press. */
    pressSlot: (slot: number): void => {
      performSlotPress(slot);
    },
    /** Ability layer truth for the P5 smoke asserts. */
    abilityState: (): {
      defsLoaded: number;
      hotbar: { slot: number; id: string | null; cooldownMs: number; affordable: boolean }[];
      resource: { type: string; value: number; max: number; comboPoints: number };
      selfEffects: string[];
      targetEffects: string[];
      blocking: boolean;
      selfFlags: number;
    } => {
      const target = softTarget();
      return {
        defsLoaded: HOTBAR_SLOTS.filter((s) => connection.slotView(s).def !== null).length,
        hotbar: HOTBAR_SLOTS.map((slot) => {
          const view = connection.slotView(slot);
          return {
            slot,
            id: view.def?.id ?? null,
            cooldownMs: view.cooldownMs,
            affordable: view.affordable,
          };
        }),
        resource: {
          type: connection.resource.type,
          value: Math.floor(connection.resource.value),
          max: connection.resource.max,
          comboPoints: connection.resource.comboPoints,
        },
        selfEffects: connection.effectsFor(connection.selfId).map((e) => e.effectId),
        targetEffects: target ? connection.effectsFor(target.id).map((e) => e.effectId) : [],
        blocking: input.secondaryHeld,
        selfFlags: connection.selfFlags,
      };
    },
    /** Smoke hook: hold/release the RMB stance without pointer lock. */
    setStance: (held: boolean): void => {
      input.debugSetSecondary(held);
    },
    combatState: (): {
      hp: number;
      maxHp: number;
      dead: boolean;
      enemies: number;
      enemiesInView: number;
      telegraphs: number;
      combatTexts: number;
      fctTotal: number;
      dawnedMs: number;
      target: string | null;
    } => ({
      hp: connection.selfHp,
      maxHp: connection.selfMaxHp,
      dead: connection.selfDead,
      enemies: [...connection.remotes.values()].filter((r) => r.kind === EntityKind.Enemy).length,
      enemiesInView: enemyViews.size,
      telegraphs: telegraphs.count,
      combatTexts: combatText.count,
      fctTotal: combatText.spawnedTotal,
      dawnedMs: Math.max(0, connection.dawnedUntilMs - performance.now()),
      target: softTarget()?.name ?? null,
    }),
    animState: (): { local: string; localBubble: boolean; remotes: Record<string, string> } => {
      const remotes: Record<string, string> = {};
      for (const [id, view] of remoteViews) {
        remotes[connection.rosterEntryFor(id)?.name ?? String(id)] = view.clipName;
      }
      return { local: localView.clipName, localBubble: localView.hasBubble, remotes };
    },
    /** Mixer truth: what is REALLY playing (catches silently-unbound clips). */
    animDebug: (): {
      local: { clip: string; time: number; weight: number; running: boolean } | null;
      enemies: Record<string, { clip: string; time: number; running: boolean; actions: number }>;
      rollTimeLeft: number;
    } => {
      const enemies: Record<
        string,
        { clip: string; time: number; running: boolean; actions: number }
      > = {};
      for (const [id, view] of enemyViews) enemies[String(id)] = view.animDebug;
      return {
        local: localView.actionState,
        enemies,
        rollTimeLeft: connection.predicted.rollTimeLeft,
      };
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

    // 0. Stream terrain around wherever the player is (spawn until first input).
    const streamPosition = connection.renderPosition();
    terrain.update(deltaMs / 1000, streamPosition.x, streamPosition.z);

    // 1. Fixed-timestep simulation — one predicted tick per server tick. Gated
    // until the map, walkgrid and the ground under our feet are loaded: inputs
    // sent while the client would predict against ocean floor only cause
    // corrections (the server never waits on our assets). Also gated on being
    // in-world: while reconnecting, predicting movement the server never hears
    // would only earn a snap back to where the entity actually stands.
    const simulationReady =
      connection.status === 'playing' &&
      !connection.selfDead &&
      mapReady &&
      walkgridReady &&
      terrain.isGroundReadyAt(streamPosition.x, streamPosition.z);
    if (!simulationReady) accumulatorMs = 0;
    accumulatorMs += deltaMs;
    let ticks = 0;
    while (simulationReady && accumulatorMs >= TICK_MS && ticks < 5) {
      connection.simulateTick(input.sampleIntent());
      accumulatorMs -= TICK_MS;
      ticks++;
    }
    if (accumulatorMs > TICK_MS * 5) accumulatorMs = 0; // gave up catching up

    // 1b. LMB presses → predicted swings + server requests (COMBAT.md §4).
    for (let presses = input.takeAttackPresses(); presses > 0; presses--) {
      performAttackPress();
    }
    // 1c. Hotbar presses → predicted slot abilities (P5).
    for (const slot of input.takeSlotPresses()) {
      performSlotPress(slot);
    }
    if (connection.predicted.rollTimeLeft > 0.5) sfx.play('dodge', 0.6);

    // 2. Per-frame networking housekeeping (corrections, interpolation).
    connection.update(deltaMs);

    // 3. Draw. The local player renders extrapolated by the accumulator's
    // sub-tick remainder (smooth at any fps over the 20 Hz sim) and faces the
    // LIVE mouse yaw — tick-quantized facing reads as input lag.
    const dtSeconds = deltaMs / 1000;
    const position = connection.renderPosition(simulationReady ? accumulatorMs : 0);
    localView.setPose(position.x, position.y, position.z, input.yaw);
    localView.setDead(connection.selfDead);
    // Death beat (COMBAT.md §10): let the Death clip play under a slow camera
    // orbit before the soul screen takes over — an instant overlay was "there
    // is no death animation" (round 6).
    if (connection.selfDead && deathStartedMs === 0) deathStartedMs = now;
    else if (!connection.selfDead) deathStartedMs = 0;
    hud.showDeath(connection.selfDead && now - deathStartedMs > DEATH_SOUL_DELAY_MS);
    // The 8-way clip follows the held keys, not measured velocity: the rig
    // faces the live yaw while velocity trails the 20 Hz intents, so a camera
    // flick would sweep a velocity heading across sectors (anim-math.ts).
    const axes = input.moveAxes();
    localView.setIntentHeading(headingFromInput(axes.forward, axes.strafe));
    // Hit-stop (§9): the attacker's rig freezes for a beat on confirmed contact.
    const localDt = performance.now() < hitStopUntilMs ? dtSeconds * 0.1 : dtSeconds;
    // RMB stance: shield-up overlay for the block classes, instant from input.
    localView.setBlocking(
      input.secondaryHeld &&
        !connection.selfDead &&
        (connection.classId === 'warrior' || connection.classId === 'cleric'),
    );
    localView.update(localDt, {
      grounded: connection.predicted.grounded,
      sprinting: connection.predicted.sprinting,
      swimming: connection.predicted.swimming,
      dodging: connection.predicted.rollTimeLeft > 0,
    });
    syncRemoteViews(dtSeconds);
    telegraphs.update();
    combatText.update(dtSeconds);
    projectiles.update(dtSeconds);
    vfx.update(dtSeconds);

    ambience?.update(dtSeconds, position.x, position.z);
    updateWaterTime(now / 1000);
    updateFoliageWind(now / 1000);

    cameraTarget.set(position.x, position.y, position.z);
    // Sprint gets a small FOV push — speed you can feel, not just read.
    scene.setSprintBoost(
      connection.predicted.sprinting && !connection.predicted.swimming,
      dtSeconds,
    );
    // Dead: the camera drifts around the body (input.yaw itself stays put, so
    // control returns exactly where the player left it on respawn).
    const cameraYaw =
      deathStartedMs > 0 ? input.yaw + ((now - deathStartedMs) / 1000) * 0.45 : input.yaw;
    scene.updateCamera(cameraTarget, cameraYaw, input.pitch, dtSeconds);
    scene.render();

    const target = softTarget();
    const cast = connection.castView();
    hud.update({
      fps,
      ping: connection.rttMs,
      serverTick: connection.stats.serverTick,
      snapshots: connection.stats.snapshotsReceived,
      corrections: connection.stats.corrections,
      snaps: connection.stats.snaps,
      lastCorrectionM: connection.stats.lastCorrectionM,
      snapshotAgeMs:
        connection.stats.lastSnapshotAtMs > 0 ? now - connection.stats.lastSnapshotAtMs : 0,
      snapshotIntervalMs: connection.stats.snapshotIntervalMs,
      bytesIn: connection.stats.bytesIn,
      bytesOut: connection.stats.bytesOut,
      netsim: connection.netsim,
      position,
      stamina: connection.predicted.stamina,
      maxStamina: connection.predicted.maxStamina,
      hp: connection.selfHp,
      maxHp: connection.selfMaxHp || playerStats(connection.classId, 1).maxHp,
      dawnedRemainingMs: Math.max(0, connection.dawnedUntilMs - now),
      target,
      grounded: connection.predicted.grounded,
      sprinting: connection.predicted.sprinting,
      swimming: connection.predicted.swimming,
      players: connection.remotes.size + 1,
      resource: {
        type: connection.resource.type,
        value: connection.resource.value,
        max: connection.resource.max,
        comboPoints: connection.resource.comboPoints,
        showComboPoints: connection.classId === 'rogue',
      },
      slots: HOTBAR_SLOTS.map((slot) => connection.slotView(slot)),
      cast: cast ? { name: cast.name, fraction: cast.fraction } : null,
      selfEffects: connection.effectsFor(connection.selfId),
      targetEffects: target ? connection.effectsFor(target.id) : [],
      dodgeReady: connection.dodgeReady(input.secondaryHeld),
      stanceHeld: input.secondaryHeld && !connection.selfDead,
    });
  };

  /** Create/advance/remove remote views to mirror the interpolated entity set. */
  const syncRemoteViews = (dtSeconds: number): void => {
    for (const [id, remote] of connection.remotes) {
      if (remote.kind === EntityKind.Enemy) {
        let enemyView = enemyViews.get(id);
        if (!enemyView && remote.enemyMeta && enemyAssets) {
          enemyView = new EnemyView(
            id,
            remote.enemyMeta,
            enemyDefs.get(remote.enemyMeta.typeId),
            enemyAssets,
          );
          enemyViews.set(id, enemyView);
          enemyLastPos.set(id, { x: remote.render.x, z: remote.render.z });
          scene.scene.add(enemyView.group);
        }
        if (enemyView) {
          enemyView.update(dtSeconds, remote.render, enemyLastPos.get(id)!);
        }
        continue;
      }

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
      view.setDead((remote.render.flags & EntityFlag.Dead) !== 0);
      view.setBlocking((remote.render.flags & EntityFlag.Blocking) !== 0);
      view.update(dtSeconds, {
        grounded: (remote.render.flags & EntityFlag.Grounded) !== 0,
        sprinting: (remote.render.flags & EntityFlag.Sprinting) !== 0,
        swimming: (remote.render.flags & EntityFlag.Swimming) !== 0,
        dodging: (remote.render.flags & EntityFlag.Dodging) !== 0,
      });
    }
    for (const [id, view] of remoteViews) {
      if (!connection.remotes.has(id)) {
        view.dispose(scene.scene);
        remoteViews.delete(id);
      }
    }
    for (const [id, view] of enemyViews) {
      if (!connection.remotes.has(id)) {
        view.dispose(scene.scene);
        enemyViews.delete(id);
        enemyLastPos.delete(id);
      }
    }
  };

  /** Soft-target (COMBAT.md §1): the best living enemy near the reticle line.
   * Carries the entity id + hit radius so ability requests can aim at it. */
  interface SoftTarget {
    id: number;
    name: string;
    level: number;
    hpFraction: number;
    radius: number;
  }
  const softTarget = (): SoftTarget | null => {
    const self = connection.renderPosition();
    let best: SoftTarget | null = null;
    let bestScore = Infinity;
    for (const remote of connection.remotes.values()) {
      if (remote.kind !== EntityKind.Enemy || !remote.enemyMeta) continue;
      if ((remote.render.flags & EntityFlag.Dead) !== 0) continue;
      const dx = remote.render.x - self.x;
      const dz = remote.render.z - self.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 22) continue;
      const off = Math.abs(angleDelta(input.yaw, Math.atan2(dx, dz)));
      if (off > 0.4) continue;
      const score = off * 8 + dist * 0.1;
      if (score < bestScore) {
        bestScore = score;
        best = {
          id: remote.id,
          name: remote.enemyMeta.name,
          level: remote.enemyMeta.level,
          hpFraction: remote.render.hpFraction,
          radius: enemyDefs.get(remote.enemyMeta.typeId)?.hitRadius ?? 0.5,
        };
      }
    }
    return best;
  };

  requestAnimationFrame(frame);

  return {
    dispose: () => {
      disposed = true;
      connection.disconnect();
      vfx.dispose();
      terrain.dispose();
      container.replaceChildren();
    },
  };
};
