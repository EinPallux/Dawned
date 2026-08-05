/**
 * The in-world game: canvas + netcode + debug HUD, started once the player has
 * picked a character. Extracted from the P0 entry point; the React shell mounts
 * and unmounts this (docs/tech/ARCHITECTURE.md §4 screen flow).
 */

import * as THREE from 'three';
import {
  gatherRefusalText,
  gateForTier,
  type GatherOp,
  nodeItemRefs,
  type ProfessionSyncMessage,
  type ResourceNodeDef,
  AbilityRejectReason,
  ActionId,
  BASIC_COMBOS,
  EntityEventKind,
  EntityFlag,
  EntityKind,
  LOOT_REACH_M,
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
  type AttributeSpread,
  type ClassId,
  type ProgressSyncMessage,
  type RespecKind,
  type SkillNodeDef,
} from '@dawned/shared';
import { Connection } from '../net/connection.js';
import { api } from '../net/api.js';
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
import { BossFrame } from '../ui/boss-frame.js';
import { EnemyView, loadEnemyAssets, type EnemyAssets } from '../world/enemy-view.js';
import { TelegraphManager } from '../world/telegraphs.js';
import { CombatTextManager } from '../world/combat-text.js';
import { ProjectileManager } from '../world/projectiles.js';
import { AbilityVfxManager, abilityVfxColor } from '../world/ability-vfx.js';
import { CombatSfx, sfxSlotOf } from '../audio/combat-sfx.js';
import { loadEnemyDefs } from '../content/enemy-defs.js';
import { loadAbilityDefs } from '../content/ability-defs.js';
import { loadSkillNodeDefs } from '../content/skill-node-defs.js';
import { loadItemDefs } from '../content/item-defs.js';
import { LootBagManager } from '../world/loot-bags.js';
import { VendorPostManager, loadVendorAnchors } from '../world/vendor-posts.js';
import {
  GATHER_VERB,
  ResourceNodeManager,
  loadNodeModels,
  type NodeInReach,
} from '../world/resource-nodes.js';
import { loadResourceNodeDefs } from '../content/resource-node-defs.js';
import { loadIconUrls } from '../content/icon-urls.js';
import { setAbilityNames } from '../app/panels/panel-format.js';
import { rarityTone, refusalText as itemRefusalText } from '../app/panels/item-format.js';
import type {
  AbilityDef,
  DodgeRefusal,
  EnemyDef,
  EnemyMetaEntry,
  InventorySyncMessage,
  ItemDef,
  ItemOp,
  VendorPanelMessage,
  WireLootBag,
} from '@dawned/shared';

/** The overlay panels P7 ships (UI_UX.md §4 grows this list per phase). */
export type PanelId = 'character' | 'skills' | 'inventory' | 'vendor' | 'professions';

/** What the HUD says when `V` cannot roll (COMBAT.md §7 gates the dodge). */
const DODGE_REFUSAL_TEXT: Record<DodgeRefusal, string> = {
  stamina: 'Not enough stamina to roll.',
  cooldown: 'Still finding your feet.',
  rooted: 'You cannot roll while held.',
  swimming: 'No rolling in deep water.',
  airborne: 'You cannot roll in mid-air.',
  busy: 'Not while you are already moving like that.',
};

/**
 * What the React panels (CharacterPanel/SkillsPanel) read and drive — a thin
 * facade over the connection so the panels never touch netcode internals.
 * All prediction/validation stays in the connection (shared rules).
 */
export interface ProgressionBridge {
  /** Re-render signal: fires on any progression change. Returns unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** Monotonic change counter — the useSyncExternalStore snapshot. */
  version: () => number;
  classId: () => ClassId;
  level: () => number;
  /** Who the sheet is about: name, looks and what the roster says you hold. */
  identity: () => {
    name: string;
    appearance: Appearance;
    mainhandModel: string | null;
    offhandModel: string | null;
  };
  /** The authoritative sheet (null until the first ProgressSync). */
  sheet: () => ProgressSyncMessage | null;
  nodeDefs: () => ReadonlyMap<string, SkillNodeDef>;
  ranks: () => ReadonlyMap<string, number>;
  /** Own hotbar rows for the K panel's ability tiles (authored defs). */
  hotbar: () => { slot: number; def: AbilityDef | null; lockedUntilLevel: number }[];
  allocateStats: (deltas: AttributeSpread) => void;
  allocateSkill: (nodeId: string) => { ok: boolean; reason?: string };
  respec: (kind: RespecKind) => void;
  /** Baked icon url for a game-icons slug ('' slug → undefined → monogram). */
  iconUrl: (slug: string) => string | undefined;
}

/**
 * What the bag and vendor panels read and drive (P8-D). Same shape as the
 * progression bridge: the connection owns the truth, React just renders it and
 * sends intents — there is no client-side inventory state to disagree with.
 */
export interface InventoryBridge {
  subscribe: (listener: () => void) => () => void;
  version: () => number;
  /** The authoritative pack (null until the first InventorySync). */
  pack: () => InventorySyncMessage | null;
  /** Bags we hold a share in, nearest first. */
  bags: () => WireLootBag[];
  /** The open vendor, or null. */
  vendor: () => VendorPanelMessage | null;
  itemDef: (itemId: string) => ItemDef | undefined;
  iconUrl: (slug: string) => string | undefined;
  /** Distance in metres to a bag, for the "too far" hint. */
  distanceTo: (bagId: number) => number;
  send: (op: ItemOp) => void;
}

/** Data the `J` panel reads (P10). Same external-store shape as the others. */
export interface ProfessionsBridge {
  subscribe: (listener: () => void) => () => void;
  version: () => number;
  /** Levels + codex from the last ProfessionSync; null before the first. */
  state: () => ProfessionSyncMessage | null;
  /**
   * Everything a profession CAN produce, so the codex can show gaps as gaps.
   * Derived from the published node definitions rather than from a list here —
   * authoring a new herb must not need a client change to be collectable.
   */
  catalogue: (profession: string) => ItemDef[];
  iconUrl: (slug: string) => string | undefined;
}

export interface WorldHandle {
  dispose: () => void;
  /** Open/close an overlay panel (the React close buttons drive this). */
  setPanel: (panel: PanelId | null) => void;
  /** Data + actions for the React progression panels. */
  progression: ProgressionBridge;
  /** Data + actions for the bag/vendor panels. */
  inventory: InventoryBridge;
  /** Data for the professions panel. */
  professions: ProfessionsBridge;
}

export interface WorldCallbacks {
  /** Fired for terminal conditions the shell should surface (overlays). */
  onNotice: (code: NoticeCode, friendlyText: string) => void;
  onDisconnected: () => void;
  /** Panel open/close (keys, micro menu, click-outside) → React renders it. */
  onPanelChange: (panel: PanelId | null) => void;
}

/** WebSocket URL: same origin in production, Vite proxy in dev. */
const gameSocketUrl = (): string => {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/game`;
};

const HOTBAR_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8];

/** Level-up flourish (PROGRESSION.md §1.3): baked UAL clip, plays only when
 * idle and stays escapable — moving cancels it instantly. */
const CELEBRATION = { clip: 'Celebration', clipSeconds: 4.0, durationMs: 4000 };

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
    (panel) => {
      togglePanel(panel);
    },
  );

  // --- overlay panels (P7-D) ------------------------------------------------
  // C/K/Esc, the micro menu, the React close buttons and a click on the world
  // all funnel through setPanel: it owns the pointer-lock handoff (panels need
  // the cursor; closing re-locks into mouselook) and tells the React shell.
  let openPanel: PanelId | null = null;
  // --- professions (P10-F) ---------------------------------------------------
  /** What the `J` panel is drawn from; bumped on every ProfessionSync. */
  let professionsVersion = 0;
  const professionListeners = new Set<() => void>();
  const notifyProfessions = (): void => {
    for (const listener of professionListeners) listener();
  };
  /** Last seen level per profession, so a sync can announce what CHANGED. */
  const professionLevels = new Map<string, number>();
  /** The word the gather bar uses while you are holding (§1.1's verbs). */
  const GATHER_GERUND: Record<string, string> = {
    woodcutting: 'Chopping',
    mining: 'Mining',
    herbalism: 'Picking',
    fishing: 'Fishing',
  };
  /** Edge tracker so one refused dodge press produces one message. */
  let lastDodgeRefusal: string | null = null;
  /** Edge tracker for the roll itself (its sound + buffer consume fire once). */
  let wasRolling = false;
  /** Last few item notices, kept for the debug API (smoke diagnostics). */
  const recentNotices: string[] = [];
  function setPanel(panel: PanelId | null): void {
    if (openPanel === panel) return;
    openPanel = panel;
    if (panel) {
      document.exitPointerLock();
    } else if (!input.textEntryActive) {
      // Key/click handlers grant transient activation — same re-lock rule as
      // the Alt-release path in input.ts.
      void canvas.requestPointerLock();
    }
    callbacks.onPanelChange(panel);
  }
  function togglePanel(panel: PanelId): void {
    setPanel(openPanel === panel ? null : panel);
  }
  /**
   * Volume scale for a sound made at a world position (P9). Enemy audio is
   * the cue that arrives while you are looking the other way, but a camp
   * 40 m off must not be as loud as the thing swinging at you — linear
   * falloff to silence at AUDIBLE_RANGE_M.
   */
  const AUDIBLE_RANGE_M = 32;
  function enemyAudibility(x: number, z: number): number {
    const self = connection.renderPosition();
    const dist = Math.hypot(x - self.x, z - self.z);
    return Math.max(0, 1 - dist / AUDIBLE_RANGE_M);
  }
  // Clicking the world with a panel open means "back to the game" — the input
  // layer's own mousedown handler re-locks in the same gesture.
  canvas.addEventListener('mousedown', () => {
    if (openPanel) setPanel(null);
  });

  // Terrain: the manager owns the sampler the prediction step walks on. Chunks,
  // walkgrid and zones stream in asynchronously; simulation is gated below until
  // the ground under the spawn is real.
  const mapSource = new MapSource(MAP_VERSION);
  const terrain = new TerrainManager(scene.scene, mapSource);
  scene.scene.add(buildOceanMesh(SEA_LEVEL));
  let ambience: AmbienceController | null = null;
  let walkgridReady = false;
  let mapReady = false;
  // Ask the server which bake it is running before streaming a single chunk
  // (A2): after a map publish the compiled-in MAP_VERSION is last week's world.
  // If health is unreachable the constant still gets us onto the dev map.
  void api
    .health()
    .then((health) => health.mapVersion)
    .catch(() => undefined)
    .then((serverVersion) => mapSource.open(serverVersion))
    .then(async ({ zones }) => {
      ambience = new AmbienceController(scene.ambienceTargets, zones);
      mapReady = true;
      const walkgrid = await mapSource.loadWalkgrid();
      if (walkgrid) terrain.sampler.attachWalkgrid(walkgrid);
      walkgridReady = true;
      // Nodes wait for the map because their positions live in ITS bake — a
      // client that built them against the fallback version would plant a
      // forest on ground the server is not simulating.
      await buildNodes();
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
        // Discovery lines double as toasts (UI_UX.md §2) — the XP amount
        // rides the matching XpGained event's FCT.
        if (message.system && message.text.startsWith('Discovered: ')) {
          hud.toast(message.text, { tone: 'xp' });
        }
        // Bubble above the speaker (system lines stay chat-log only).
        if (!message.system) {
          if (message.fromId === connection.selfId) localView.showBubble(message.text);
          else remoteViews.get(message.fromId)?.showBubble(message.text);
        }
      },
      onRoster: (players) => {
        hud.setRoster(players, connection.selfId);
        // Our own hands come off the roster too — the same message everybody
        // else reads, so what we see on ourselves is what they see on us.
        const self = players.find((player) => player.id === connection.selfId);
        if (self) localView.setWeapons(self.mainhandModel ?? null, self.offhandModel ?? null);
      },
      onAbilityStart: (message) => {
        if (message.entityId === connection.selfId) return; // predicted at press
        const remote = connection.remotes.get(message.entityId);
        if (!remote) return;
        if (remote.kind === EntityKind.Enemy) {
          enemyViews
            .get(message.entityId)
            ?.playAbility(message.action, message.durationMs, message.cast);
          // Every enemy wind-up gets a voice, and the voice says WHICH kind it
          // is: a lunge/swing whooshes, a volley or a cast hums. Audio is the
          // cue that reaches you while the camera is pointed elsewhere.
          const kind = enemyDefs.get(remote.enemyMeta?.typeId ?? '')?.abilities[message.action]
            ?.kind;
          // A projectile draw stays a whoosh — its release already fires
          // 'bolt' in onProjectileSpawn, and the same sound twice in half a
          // second reads as one muddy noise instead of two beats.
          sfx.play(
            kind === 'ground_circle' || message.cast ? 'bolt' : 'whoosh',
            enemyAudibility(remote.render.x, remote.render.z) * 0.8,
          );
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
            if (def.castMs > 0 || def.channel !== null) {
              // Their bar is running: gather loop for its duration; the
              // release shows through the bolt/impact stream, not a swing.
              view.setCasting(castLoopClip(def), message.durationMs);
              const p = view.group.position;
              vfx.burst(p.x, p.y + 1.3, p.z, abilityVfxColor(def), 8, 1.2, 0.4);
              return;
            }
            view.playAttack(def.anim.clip, def.anim.clipSeconds, message.durationMs, {
              fullBody: fullBodyAnim(def),
            });
            const p = view.group.position;
            abilityCommitVfx(def, p.x, p.y, p.z, message.yaw);
          }
        }
      },
      onAbilityResolve: (message) => {
        const mine = message.attackerId === connection.selfId;
        const fromSlotAbility = slotForAction(message.action) !== null;
        let sawDamage = false;
        for (const hit of message.hits) {
          const crit = (hit.flags & HitFlag.Crit) !== 0;
          const killed = (hit.flags & HitFlag.Killed) !== 0;
          const healed = (hit.flags & HitFlag.Healed) !== 0;
          const anchor = fctAnchor(hit.targetId);
          if (mine) {
            if (healed) healingDone += hit.amount;
            else damageDealt += hit.amount;
          }
          // Heals float green with a soft holy sparkle — never a wound flash.
          if (healed) {
            if (anchor) {
              combatText.spawn('heal', hit.amount, anchor.x, anchor.y, anchor.z);
              vfx.burst(anchor.x, anchor.y - 0.7, anchor.z, 0x9fe8a8, 12, 1.8, 0.5);
            }
            continue;
          }
          sawDamage = true;
          if (anchor) {
            const kind =
              hit.targetId === connection.selfId ? 'incoming' : crit ? 'outgoing-crit' : 'outgoing';
            combatText.spawn(kind, hit.amount, anchor.x, anchor.y, anchor.z);
            // Impact reads (§9 VFX v1, beefed up in round 7): a bright flash
            // AT the wound plus a spray — crits and kills pop hardest.
            if (hit.targetId !== connection.selfId) {
              const color = crit ? 0xf0c46b : 0xffa75e;
              vfx.flash(anchor.x, anchor.y - 0.5, anchor.z, color, crit ? 2.2 : 1.5);
              vfx.burst(
                anchor.x,
                anchor.y - 0.5,
                anchor.z,
                color,
                crit ? 26 : 14,
                crit ? 5 : 3.4,
                0.4,
              );
              if (killed) {
                vfx.flash(anchor.x, anchor.y - 0.6, anchor.z, 0xffffff, 2.8);
                vfx.burst(anchor.x, anchor.y - 0.6, anchor.z, 0xffe9b8, 30, 5.5, 0.55);
              }
            }
          }
          enemyViews.get(hit.targetId)?.flash();
          if (killed) sfx.play('death');
        }
        if (mine && sawDamage) {
          // Contact confirmed: hit-stop + directional kick + impact layer (§9).
          // Slot abilities hit noticeably harder than basics — 90 ms freeze
          // and a stronger kick so "did that connect?" never needs the log.
          // Pure-heal resolves deliberately skip the kick: mending an ally
          // must not punch the healer's camera.
          const crit = message.hits.some((h) => (h.flags & HitFlag.Crit) !== 0);
          hitStopUntilMs = performance.now() + (fromSlotAbility ? 90 : 60);
          scene.addKick(input.yaw, (fromSlotAbility ? 1.3 : 1) * (crit ? 1.4 : 1));
          if (fromSlotAbility) scene.addShake(crit ? 1.2 : 0.7);
          sfx.play(crit ? 'impact_crit' : fromSlotAbility ? 'impact_heavy' : 'impact');
        }
      },
      onAbilityReject: (action, reason) => {
        // The server refused a predicted slot press (real divergence): the
        // rolled-back slot pulses + says why, so the miss never reads silent.
        const slot = slotForAction(action);
        if (slot !== null) {
          hud.pulseSlot(slot);
          sfx.play('deny', 0.8);
          const text = refusalText(reason, connection.slotView(slot).def);
          if (text) hud.showRefusal(text);
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
          case EntityEventKind.Interrupted:
            // A stun broke a cast (P6). The connection already stopped the
            // local machine; this is the presentation half.
            if (message.entityId === connection.selfId) {
              localView.setCasting(null);
              hud.flashInterrupted();
              sfx.play('deny', 0.9);
            } else {
              remoteViews.get(message.entityId)?.setCasting(null);
              // An ENEMY cast broken by the player's interrupt is the payoff
              // for reading the bar — shatter it rather than let it vanish.
              const view = enemyViews.get(message.entityId);
              if (view) {
                view.breakCast();
                const at = connection.remotes.get(message.entityId)?.render;
                if (at) {
                  vfx.ring(at.x, at.y + 1.1, at.z, 1.1, 0xd8453a);
                  sfx.play('impact_heavy', enemyAudibility(at.x, at.z) * 0.8);
                }
              }
            }
            break;
          case EntityEventKind.Phase: {
            // A boss crossed a threshold: the frame flashes and it says its
            // line. The words come from the published def the client already
            // holds, so the panel can rewrite them without a protocol change.
            bossFrame.onPhase(message.entityId, message.a);
            const at = connection.remotes.get(message.entityId)?.render;
            if (at) {
              vfx.ring(at.x, at.y + 0.2, at.z, 3.2, 0xff8a3a);
              vfx.pillar(at.x, at.y, at.z, 0xff8a3a);
              sfx.play('levelup', 0.5 * enemyAudibility(at.x, at.z));
              scene.addShake(1.5);
            }
            break;
          }
          default:
            break;
        }
      },
      onTelegraph: (message) => {
        // Player-cast decals (Meteor, Sanctuary) read gold, enemies red.
        telegraphs.show(
          message,
          message.casterId === connection.selfId ||
            connection.remotes.get(message.casterId)?.kind === EntityKind.Player,
        );
      },
      onProjectileSpawn: (message) => {
        projectiles.spawn(message);
        sfx.play('bolt', 0.7);
      },
      onProjectileEnd: (message) => {
        projectiles.end(message);
      },
      onXpGained: (message) => {
        // Every award ticks visibly (PROGRESSION.md §7): purple FCT over the
        // character + a pulse on the bar itself.
        const self = connection.renderPosition();
        combatText.spawn('xp', message.amount, self.x, self.y + 2.1, self.z);
        hud.xpPulse();
      },
      onLevelUp: (message, oldLevel) => {
        if (message.entityId !== connection.selfId) {
          // Bystanders see the pillar (the roster refresh renames the plate).
          const remote = connection.remotes.get(message.entityId);
          if (remote) vfx.pillar(remote.render.x, remote.render.y, remote.render.z);
          return;
        }
        // The §1.3 juice contract, client half (refills are server-side and
        // arrive with the next snapshot): pillar, Celebration when idle,
        // HUD gold flash + bar burst, chime, chat toast, unlock toasts.
        const self = connection.renderPosition();
        vfx.pillar(self.x, self.y, self.z);
        const moving =
          Math.abs(connection.predicted.vx) > 0.05 || Math.abs(connection.predicted.vz) > 0.05;
        if (!moving && !connection.selfDead) {
          localView.playAttack(CELEBRATION.clip, CELEBRATION.clipSeconds, CELEBRATION.durationMs);
        }
        hud.levelUpJuice();
        sfx.play('levelup');
        hud.addChat({
          from: '',
          fromId: 0,
          system: true,
          text: `You have reached level ${message.level}!`,
        });
        // Ability unlocks crossed by this level-up (slots auto-equip — §4).
        for (const slot of HOTBAR_SLOTS) {
          const def = connection.slotView(slot).def;
          if (def && def.unlockLevel > oldLevel && def.unlockLevel <= message.level) {
            hud.toast(`New ability: ${def.name} — slot ${slot}`, {
              tone: 'gold',
              onClick: () => {
                setPanel('skills');
              },
            });
          }
        }
        // The banked-points pip, spoken once (§7: gentle, never a modal).
        hud.toast(`+3 attribute · +1 skill point banked`, {
          tone: 'gold',
          onClick: () => {
            setPanel('character');
          },
        });
      },
      // --- items (P8-D) -----------------------------------------------------
      onLootBags: (message) => {
        lootBags.sync(message.bags, message.serverTimeMs);
      },
      // --- gathering (P10-F) ------------------------------------------------
      onNodeStates: (message) => {
        resourceNodes?.setDepleted(message.depleted, message.serverTimeMs);
      },
      onGatherState: (message) => {
        if (message.phase === 'start') {
          hud.setGatherBar({
            label: `${GATHER_GERUND[message.profession ?? ''] ?? 'Gathering'} ${
              nodeDefs.get(message.nodeId ?? '')?.name ?? ''
            }`.trim(),
            startedAtMs: message.startedAtMs ?? 0,
            endsAtMs: message.endsAtMs ?? 0,
          });
          // Face the node you are working: swinging at ninety degrees off is
          // the difference between chopping a tree and chopping the air.
          const at = message.placementId ? resourceNodes?.positionOf(message.placementId) : null;
          if (at) {
            const self = connection.renderPosition();
            input.yaw = Math.atan2(at.x - self.x, at.z - self.z);
          }
          return;
        }
        hud.setGatherBar(null);
        // A refusal never opened; a cancel with a reason is a hold the SERVER
        // broke under you — taking a hit, walking off. Both have to say why:
        // a bar that just stops is the player wondering whether the key even
        // registered (the dodge-refusal precedent, COMBAT.md §9).
        if (message.phase === 'refused' || (message.phase === 'cancelled' && message.reason)) {
          hud.showRefusal(gatherRefusalText(message.reason ?? ''));
          return;
        }
        if (message.phase !== 'done') return;
        for (const stack of message.gained ?? []) {
          const def = connection.itemDefs.get(stack.itemId);
          hud.toast(`+${stack.qty} ${def?.name ?? stack.itemId}`, {
            tone: (def?.rarity as 'uncommon' | undefined) ?? 'plain',
          });
        }
        if (message.proc) {
          const def = connection.itemDefs.get(message.proc.itemId);
          hud.toast(`Rare find: ${def?.name ?? message.proc.itemId}`, { tone: 'gold' });
        }
      },
      onFishingState: (message) => {
        if (message.phase === 'caught' && message.fish) {
          const def = connection.itemDefs.get(message.fish.itemId);
          hud.toast(`Landed: ${def?.name ?? message.fish.itemId}`, {
            tone: (def?.rarity as 'rare' | undefined) ?? 'plain',
          });
        }
        if (message.phase === 'escaped') hud.toast('It got away.', { tone: 'red' });
        if (message.phase === 'bite') sfx.play('deny');
      },
      onProfessionSync: (message) => {
        // Level-ups are announced from the DIFF rather than from a message the
        // server would have to send twice: the sync is the whole truth, so the
        // client just notices what changed.
        for (const entry of message.professions) {
          const before = professionLevels.get(entry.profession);
          if (before !== undefined && entry.level > before) {
            hud.toast(`${entry.profession} ${entry.level}`, {
              tone: 'gold',
              onClick: () => {
                setPanel('professions');
              },
            });
          }
          professionLevels.set(entry.profession, entry.level);
        }
        professionsVersion++;
        notifyProfessions();
      },
      onVendorPanel: (panel) => {
        // The server opens and closes the conversation (walking away breaks
        // the lease), so the panel follows it rather than the other way round.
        setPanel(panel ? 'vendor' : null);
      },
      onItemNotice: (notice) => {
        const def = notice.itemId ? connection.itemDefs.get(notice.itemId) : undefined;
        const name = def?.name ?? notice.itemId ?? 'item';
        const qty = notice.qty && notice.qty > 1 ? ` ×${notice.qty}` : '';
        // Keep the last few for the debug API: a refusal reason is the one
        // thing a failing item smoke always wants and toasts fade too fast.
        recentNotices.push(
          `${notice.kind}${notice.reason ? `:${notice.reason}` : ''}${notice.itemId ? ` ${notice.itemId}` : ''}`,
        );
        if (recentNotices.length > 8) recentNotices.shift();
        switch (notice.kind) {
          case 'picked':
            hud.toast(`${name}${qty}`, { tone: def ? rarityTone(def.rarity) : 'plain' });
            sfx.play('pickup', 0.6);
            break;
          case 'gold':
            hud.toast(`+${notice.gold ?? 0} gold`, { tone: 'gold' });
            sfx.play('coin', 0.6);
            break;
          case 'bought':
            hud.toast(`Bought ${name}${qty} — ${notice.gold ?? 0} gold`, { tone: 'gold' });
            break;
          case 'sold':
            hud.toast(`Sold ${name}${qty} — +${notice.gold ?? 0} gold`, { tone: 'gold' });
            sfx.play('coin', 0.5);
            break;
          case 'full':
            hud.toast('Your pack is full.', { tone: 'red' });
            break;
          case 'refused':
            hud.toast(itemRefusalText(notice.reason ?? ''), { tone: 'red' });
            break;
          case 'used':
          case 'equipped':
            break; // the sync itself is the feedback
        }
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
  input.onUiKey = (key) => {
    if (key === 'close') setPanel(null);
    else togglePanel(key);
  };

  /**
   * What `F` says in front of a node (§1.1 step 2).
   *
   * A locked node shows the REQUIREMENT rather than a dead key, and a depleted
   * one shows its countdown — the two ways a player learns the system without
   * being told about it.
   */
  const nodePromptText = (node: NodeInReach): string => {
    const level =
      connection.professionState?.professions.find(
        (entry) => entry.profession === node.def.profession,
      )?.level ?? 1;
    if (node.depleted) {
      return `${node.def.name} — taken · back in ${node.readyInSec}s`;
    }
    const gate = gateForTier(node.def.tier);
    if (level < gate) {
      return `${node.def.name} — needs ${node.def.profession} ${gate}`;
    }
    return `F — ${GATHER_VERB[node.def.profession] ?? 'Gather'} ${node.def.name}  ·  T${node.def.tier}`;
  };

  /** The bag we could reach right now (ITEMS_LOOT §3: 4 m), nearest first. */
  const nearestBag = (): { id: number; distance: number } | null => {
    const self = connection.renderPosition();
    let best: { id: number; distance: number } | null = null;
    for (const bag of connection.lootBags) {
      const distance = Math.hypot(bag.x - self.x, bag.z - self.z);
      if (!best || distance < best.distance) best = { id: bag.id, distance };
    }
    return best;
  };

  input.onWorldKey = (key) => {
    if (key === 'quickUse') {
      // E drinks the leftmost usable consumable — the quick slot until the
      // player can bind one themselves (UI_UX.md §4).
      const pack = connection.inventory;
      if (!pack) return;
      const entry = pack.bag.find(([, stack]) => connection.itemDefs.get(stack.itemId)?.consumable);
      if (!entry) {
        hud.toast('Nothing to drink.', { tone: 'red' });
        return;
      }
      connection.sendItemOp({ kind: 'use', from: entry[0] });
      return;
    }
    if (key === 'interactUp') {
      // Letting go ends a hold. Harmless when nothing is being gathered — the
      // server ignores a cancel with no channel, which is what makes this
      // safe to send on every F release rather than only the ones that matter.
      if (connection.gatherChannel) connection.sendGatherOp({ kind: 'cancel' });
      return;
    }
    // A bite is answered with the same key, and it beats everything else: the
    // window is 0.8 s, so a press that got spent opening a vendor is a fish
    // lost to the UI.
    const fishing = connection.fishingState;
    if (fishing?.phase === 'bite') {
      connection.sendGatherOp({ kind: 'hook' });
      return;
    }
    // F: gather the node you are standing at, then loot, then talk.
    const self0 = connection.renderPosition();
    const node = resourceNodes?.inReach(self0.x, self0.z) ?? null;
    if (node && !node.depleted && fishing === null) {
      connection.sendGatherOp({ kind: 'start', placementId: node.placementId });
      return;
    }
    const bag = nearestBag();
    if (bag && bag.distance <= LOOT_REACH_M) {
      connection.sendItemOp(
        key === 'lootAll'
          ? { kind: 'loot', bagId: bag.id, index: null }
          : { kind: 'loot', bagId: bag.id, index: 0 },
      );
      return;
    }
    const self = connection.renderPosition();
    const vendor = vendorPosts.inReach(self.x, self.z);
    if (vendor) {
      connection.sendItemOp({ kind: 'vendorOpen', vendorId: vendor.id });
      return;
    }
    if (bag) hud.toast('Too far from the bag.', { tone: 'red' });
  };

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
  // Boss frame (P9): adopted by the nearest engaged boss, released when it dies,
  // leashes home or walks out of the arena.
  const bossFrame = new BossFrame(container);
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
  // The item catalogue: every bag cell, tooltip and vendor row reads names,
  // icons and stat blocks from here (the wire carries only ids).
  void loadItemDefs().then((defs) => {
    if (!disposed) connection.setItemContent(defs);
  });
  const lootBags = new LootBagManager(scene.scene);
  const vendorPosts = new VendorPostManager(scene.scene);
  void loadVendorAnchors().then((vendors) => {
    if (!disposed) vendorPosts.build(vendors);
  });
  // Resource nodes (P10): the placements come from the bake the SERVER told us
  // to stream, the definitions from the published content, and the models from
  // the manifest. All three have to be in hand before a node can be drawn, so
  // they load together and build once.
  let resourceNodes: ResourceNodeManager | null = null;
  let nodeDefs = new Map<string, ResourceNodeDef>();
  const buildNodes = async (): Promise<void> => {
    const [placements, defs, models] = await Promise.all([
      mapSource.loadPlacements(),
      loadResourceNodeDefs(),
      loadNodeModels(),
    ]);
    if (disposed) return;
    nodeDefs = defs;
    resourceNodes = new ResourceNodeManager(scene.scene, models);
    resourceNodes.build(placements?.nodes ?? [], defs);
    // A NodeStates may have landed while we were loading; adopt it now rather
    // than waiting for the next one, or a node taken before you arrived would
    // stand there whole until somebody else chopped it.
    const pending = connection.nodeStateMessage;
    if (pending) resourceNodes.setDepleted(pending.depleted, pending.serverTimeMs);
    professionsVersion++;
    notifyProfessions();
  };
  // Published ability + skill-node defs → the prediction layer (hotbar,
  // chains, costs, node folds), plus the icon wiring: baked game-icons urls
  // and the effectId → icon map (buff chips wear their ability's icon).
  let iconUrlMap = new Map<string, string>();
  void Promise.all([loadAbilityDefs(), loadSkillNodeDefs(), loadIconUrls()]).then(
    ([defs, nodeDefs, iconUrls]) => {
      if (disposed) return;
      connection.setAbilityContent(defs);
      connection.setSkillNodeContent(nodeDefs);
      iconUrlMap = iconUrls;
      // Node tooltips speak ability NAMES ("Whirlwind: −2 s cooldown").
      setAbilityNames(new Map(defs.map((def) => [def.id, def.name])));
      const effectIcons = new Map<string, string>();
      for (const def of defs) {
        if (!def.icon) continue;
        for (const effect of def.effects) {
          if (effect.kind === 'apply_effect') {
            effectIcons.set(effect.effectId, def.icon);
            if (effect.mods.onHitApply) effectIcons.set(effect.mods.onHitApply.effectId, def.icon);
          }
        }
      }
      hud.setIcons(iconUrls, effectIcons);
    },
  );
  /** Attacker anim runs at 0.1× until this time — the §9 hit-stop. */
  let hitStopUntilMs = 0;
  /** Lifetime damage/healing we dealt (smoke observability — DPS envelopes). */
  let damageDealt = 0;
  let healingDone = 0;
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
    // durationMs is attack-speed-scaled (P7 Flurry/Killer's Rhythm) — the
    // swing anim keeps pace with the faster chain the server times.
    localView.playAttack(accepted.def.clip, accepted.def.clipSeconds, accepted.durationMs);
    sfx.play('whoosh');
    return true;
  };

  /**
   * Abilities whose anim must stay full-body even while moving: the movement
   * IS the ability (dash lunge, blinks) — an upper-body overlay over a jog
   * would erase their read. Everything else swings on the overlay layer when
   * the caster is moving (character-view.ts playAttack).
   */
  const fullBodyAnim = (def: AbilityDef): boolean =>
    def.targeting.kind === 'dash' ||
    def.targeting.kind === 'blink_behind' ||
    def.targeting.kind === 'teleport';

  /** Commit-moment VFX for an ability, at any caster (self or remote). */
  const abilityCommitVfx = (
    def: AbilityDef,
    x: number,
    y: number,
    z: number,
    yaw: number,
  ): void => {
    const color = abilityVfxColor(def);
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
      case 'teleport':
        vfx.burst(x, y + 1.0, z, 0x8a7ce8, 16, 2.2, 0.4);
        break;
      case 'projectile':
        // The bolt itself arrives via ProjectileSpawn; a hand flash sells the
        // release moment (crucial for channel ticks).
        vfx.flash(x + Math.sin(yaw) * 0.5, y + 1.35, z + Math.cos(yaw) * 0.5, color, 1.1);
        break;
      default:
        // Self buffs, heals and the rest: an upward sparkle in palette color.
        vfx.burst(x, y + 1.2, z, color, 10, 1.6, 0.5);
        break;
    }
  };

  /**
   * The casting-loop clip for a def (P6 rule, client-side by design): casts
   * gather in the one-hand pose, channels stream in the two-hand pose. The
   * release clip stays def.anim (played when the machine releases).
   */
  const castLoopClip = (def: AbilityDef): string =>
    def.channel !== null
      ? 'Spell_Double_Shoot_Loop'
      : def.anim.clip.startsWith('Spell_Double')
        ? 'Spell_Double_Idle_Loop'
        : 'Spell_Simple_Idle_Loop';

  /** Refusal reason → player words (the red seam alone went unseen, round 7). */
  const refusalText = (reason: number, def: AbilityDef | null): string | null => {
    switch (reason) {
      case AbilityRejectReason.NoResource: {
        const type = def?.cost.type ?? 'resource';
        return `Not enough ${type === 'none' ? 'resource' : type[0]!.toUpperCase() + type.slice(1)}`;
      }
      case AbilityRejectReason.OnCooldown:
        return 'Not ready yet';
      case AbilityRejectReason.Locked:
        return def ? `Locked — reach level ${def.unlockLevel}` : 'Locked';
      case AbilityRejectReason.NoComboPoints:
        return 'Needs combo points';
      case AbilityRejectReason.NoTarget:
        return 'No target';
      case AbilityRejectReason.AlreadyCasting:
        return 'Already casting';
      default:
        return null; // GCD/BadState: the seam pulse is enough — words would spam
    }
  };

  /**
   * Q19 ground quick-cast: the terrain point under the crosshair, clamped
   * onto the cast-range circle. Marches the camera ray to its heightfield
   * crossing (bisected clean); aiming at sky falls back to max range along
   * the aim yaw — the press always casts, never dead-hands.
   */
  const groundAimFor = (maxRange: number): { x: number; z: number } => {
    const self = connection.renderPosition();
    const origin = scene.camera.position;
    const dir = new THREE.Vector3();
    scene.camera.getWorldDirection(dir);
    let point: { x: number; z: number } | null = null;
    let prevT = 0;
    let prevAbove = origin.y - terrain.sampler.heightAt(origin.x, origin.z);
    for (let t = 1; t <= 90 && point === null; t += 1) {
      const px = origin.x + dir.x * t;
      const pz = origin.z + dir.z * t;
      const above = origin.y + dir.y * t - terrain.sampler.heightAt(px, pz);
      if (above <= 0 && prevAbove > 0) {
        // Bisect the crossing between prevT and t for a stable point.
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 5; i++) {
          const mid = (lo + hi) / 2;
          const mx = origin.x + dir.x * mid;
          const mz = origin.z + dir.z * mid;
          if (origin.y + dir.y * mid - terrain.sampler.heightAt(mx, mz) > 0) lo = mid;
          else hi = mid;
        }
        point = { x: origin.x + dir.x * hi, z: origin.z + dir.z * hi };
      }
      prevT = t;
      prevAbove = above;
    }
    if (!point) {
      point = {
        x: self.x + Math.sin(input.yaw) * maxRange,
        z: self.z + Math.cos(input.yaw) * maxRange,
      };
    }
    const dx = point.x - self.x;
    const dz = point.z - self.z;
    const dist = Math.hypot(dx, dz);
    if (dist > maxRange) {
      point = {
        x: self.x + (dx / dist) * maxRange,
        z: self.z + (dz / dist) * maxRange,
      };
    }
    return point;
  };

  /**
   * Q20 ally soft-target: the best living PLAYER near the reticle line, for
   * heal/shield casts. The id is a hint — the server re-picks by its own
   * rules (targeted → most injured in range → self), so a stale aim can
   * never misfire a heal.
   */
  const allyTarget = (range: number): { id: number; hpFraction: number } | null => {
    const self = connection.renderPosition();
    let best: { id: number; hpFraction: number } | null = null;
    let bestScore = Infinity;
    for (const remote of connection.remotes.values()) {
      if (remote.kind !== EntityKind.Player) continue;
      if ((remote.render.flags & EntityFlag.Dead) !== 0) continue;
      const dx = remote.render.x - self.x;
      const dz = remote.render.z - self.z;
      const dist = Math.hypot(dx, dz);
      if (dist > range) continue;
      const off = Math.abs(angleDelta(input.yaw, Math.atan2(dx, dz)));
      if (off > 0.4) continue;
      const score = off * 8 + dist * 0.1;
      if (score < bestScore) {
        bestScore = score;
        best = { id: remote.id, hpFraction: remote.render.hpFraction };
      }
    }
    return best;
  };

  /**
   * One hotbar press: predicted evaluate → commit through the shared machine
   * (connection), then the §9 presentation — instants swing now, casts and
   * channels raise the gather loop and release via machine events. A local
   * refusal answers in words + red seam immediately (no round trip).
   */
  const performSlotPress = (slot: number, groundOverride?: { x: number; z: number }): void => {
    const def = connection.slotView(slot).def;
    const before = connection.renderPosition();
    // Targeting inputs by kind: heals sweep allies, ground casts need their
    // point, everything else aims at the enemy soft-target.
    let target: { id: number; radius: number } | null = null;
    if (def?.targeting.kind === 'ally_soft') {
      const ally = allyTarget(def.targeting.range);
      if (ally) target = { id: ally.id, radius: 0.5 };
    } else {
      const enemy = softTarget();
      if (enemy) target = { id: enemy.id, radius: enemy.radius };
    }
    const ground =
      def?.targeting.kind === 'ground_aoe'
        ? (groundOverride ?? groundAimFor(def.targeting.maxRange))
        : null;
    const result = connection.requestSlotAbility(
      slot,
      input.yaw,
      -input.pitch * 0.35,
      target,
      ground,
    );
    if (!result.ok) {
      if (result.reason !== null) {
        hud.pulseSlot(slot);
        sfx.play('deny', 0.8);
        const text = refusalText(result.reason, connection.slotView(slot).def);
        if (text) hud.showRefusal(text);
      }
      return;
    }

    if (result.phase !== 'instant') {
      // Cast/channel: the gather loop runs while the bar does; the release
      // anim/VFX fire from the machine-event drain when it completes.
      localView.setCasting(castLoopClip(result.def));
      vfx.burst(before.x, before.y + 1.3, before.z, abilityVfxColor(result.def), 8, 1.2, 0.4);
      sfx.play('whoosh', 0.5);
      return;
    }

    const def2 = result.def;
    localView.playAttack(def2.anim.clip, def2.anim.clipSeconds, def2.anim.durationMs, {
      fullBody: fullBodyAnim(def2),
    });
    sfx.play(sfxSlotOf(def2.sfx));
    abilityCommitVfx(def2, before.x, before.y, before.z, input.yaw);
    // Big self-centered moments shake the camera at commit (§9).
    if (def2.targeting.kind === 'pbaoe') scene.addShake(0.8);
    // Ground casts acknowledge the point instantly — the server's telegraph
    // (with the true impact clock) draws the real decal an RTT later.
    if (ground) {
      vfx.ring(
        ground.x,
        terrain.sampler.heightAt(ground.x, ground.z),
        ground.z,
        def2.targeting.kind === 'ground_aoe' ? def2.targeting.radius : 2,
        abilityVfxColor(def2),
      );
    }
    // Blinks land elsewhere — flash out, flash in.
    if (def2.targeting.kind === 'blink_behind' || def2.targeting.kind === 'teleport') {
      vfx.flash(before.x, before.y + 1.0, before.z, 0x8a7ce8, 1.8);
      const after = connection.renderPosition();
      vfx.flash(after.x, after.y + 1.0, after.z, 0x8a7ce8, 1.8);
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
    /** Smoke hook: send a chat line (the bots use `/stuck` to free themselves). */
    say: (text: string): void => {
      handleChatSubmit(text);
    },
    /** Full hotbar-press path for smokes — identical to a 1–8 key press. */
    pressSlot: (slot: number): void => {
      performSlotPress(slot);
    },
    /** Ground quick-cast with an explicit point (headless cameras can't aim). */
    pressSlotGround: (slot: number, x: number, z: number): void => {
      performSlotPress(slot, { x, z });
    },
    /** Cast/channel bar truth (P6 smoke asserts). */
    castState: (): ReturnType<Connection['castView']> => connection.castView(),
    /** Attunement pip mirror (P6 smoke asserts). */
    attunement: (): number => connection.attunementCount,
    /** Lifetime damage/healing dealt (P6 smoke: DPS envelopes, heal checks). */
    scoreboard: (): { damageDealt: number; healingDone: number } => ({
      damageDealt,
      healingDone,
    }),
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
      yaw: number;
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
      /** Camera yaw — lets a smoke place itself so the subject is on screen. */
      yaw: input.yaw,
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
      overlay: { clip: string; time: number; weight: number; running: boolean } | null;
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
        overlay: localView.overlayActionState,
        enemies,
        rollTimeLeft: connection.predicted.rollTimeLeft,
      };
    },
    /**
     * Living-enemy state for the P7 grind bot and the P9 presentation probe.
     * `rank`, `casting` and `shielded` are what the P9 visuals are ABOUT, so
     * a run can assert on them instead of eyeballing a screenshot.
     */
    enemies: (): {
      id: number;
      name: string;
      level: number;
      rank: string;
      x: number;
      z: number;
      hpFraction: number;
      dead: boolean;
      inCombat: boolean;
      casting: boolean;
      shielded: boolean;
      shield: number;
    }[] =>
      [...connection.remotes.values()]
        .filter((remote) => remote.kind === EntityKind.Enemy && remote.enemyMeta)
        .map((remote) => {
          const shield = connection
            .effectsFor(remote.id)
            .reduce((sum, effect) => sum + (effect.shieldRemaining ?? 0), 0);
          return {
            id: remote.id,
            name: remote.enemyMeta!.name,
            level: remote.enemyMeta!.level,
            rank: remote.enemyMeta!.rank,
            x: remote.render.x,
            z: remote.render.z,
            hpFraction: remote.render.hpFraction,
            dead: (remote.render.flags & EntityFlag.Dead) !== 0,
            inCombat: (remote.render.flags & EntityFlag.InCombat) !== 0,
            casting: enemyViews.get(remote.id)?.isCasting ?? false,
            shielded: shield > 0,
            shield,
          };
        }),
    /** Progression truth + drivers (P7 smoke: grind, allocation, panels). */
    progressionState: (): {
      sheet: ProgressSyncMessage | null;
      level: number;
      nodeDefsLoaded: number;
      openPanel: PanelId | null;
      maxStamina: number;
      resourceMax: number;
    } => ({
      sheet: connection.sheet,
      level: connection.selfLevel,
      nodeDefsLoaded: connection.skillNodeDefs.size,
      openPanel,
      maxStamina: connection.predicted.maxStamina,
      resourceMax: connection.resource.max,
    }),
    /** Where the held weapons ended up vs their hand bones (P8 grip check). */
    weaponDebug: (): {
      self: [number, number, number];
      held: CharacterView['weaponDebug'];
    } => {
      const position = connection.renderPosition();
      return {
        self: [position.x, position.y, position.z],
        held: localView.weaponDebug,
      };
    },
    /** World props: where the market posts ended up vs the ground under them. */
    propsDebug: (): {
      posts: { id: string; at: [number, number, number]; visible: boolean; seated: boolean }[];
      selfY: number;
      groundUnderSelf: number;
    } => {
      const self = connection.renderPosition();
      return {
        posts: vendorPosts.debug,
        selfY: self.y,
        groundUnderSelf: terrain.sampler.heightAt(self.x, self.z),
      };
    },
    /** Item truth + drivers (P8 smoke: loot, equip, vendor). */
    inventoryState: (): {
      gold: number;
      cells: [number, { itemId: string; qty: number }][];
      equipment: Record<string, { itemId: string; qty: number }>;
      bags: { id: number; distance: number; items: number; gold: number }[];
      vendor: string | null;
      vendorInReach: string | null;
      postsSeated: number;
      openPanel: PanelId | null;
      notices: string[];
      defsLoaded: number;
      mainhandModel: string | null;
    } => {
      const self = connection.renderPosition();
      const pack = connection.inventory;
      return {
        gold: pack?.gold ?? 0,
        cells: (pack?.bag ?? []).map(([cell, stack]) => [
          cell,
          { itemId: stack.itemId, qty: stack.qty },
        ]),
        equipment: Object.fromEntries(
          Object.entries(pack?.equipment ?? {}).map(([slot, stack]) => [
            slot,
            { itemId: stack.itemId, qty: stack.qty },
          ]),
        ),
        // Nearest first — the same bag `F` would take, so a smoke that reads
        // bags[0] and a player pressing the key are talking about one bag.
        bags: connection.lootBags
          .map((bag) => ({
            id: bag.id,
            distance: Math.hypot(bag.x - self.x, bag.z - self.z),
            items: bag.items.length,
            gold: bag.gold,
          }))
          .sort((a, b) => a.distance - b.distance),
        vendor: connection.vendorPanel?.vendorId ?? null,
        vendorInReach: vendorPosts.inReach(self.x, self.z)?.id ?? null,
        postsSeated: vendorPosts.seatedCount,
        openPanel,
        notices: [...recentNotices],
        defsLoaded: connection.itemDefs.size,
        mainhandModel: connection.rosterEntryFor(connection.selfId)?.mainhandModel ?? null,
      };
    },
    sendItemOp: (op: ItemOp): void => {
      connection.sendItemOp(op);
    },
    /**
     * Gathering truth + drivers (P10 smoke). Everything the browser run needs
     * to answer "is there a node here, what does F say about it, and did the
     * hold finish" without reading pixels for facts that are data.
     */
    gatheringState: (): {
      nodes: { total: number; seated: number; depleted: number; depletedIds: string[] };
      inReach: {
        placementId: string;
        nodeId: string;
        profession: string;
        tier: number;
        distance: number;
        depleted: boolean;
      } | null;
      prompt: string | null;
      channel: { nodeId: string; endsAtMs: number } | null;
      fishing: { phase: string; markerHalf: number | null; progress: number } | null;
      professions: { profession: string; level: number; xp: number; codex: number }[];
      openPanel: PanelId | null;
    } => {
      const self = connection.renderPosition();
      const node = resourceNodes?.inReach(self.x, self.z) ?? null;
      const channel = connection.gatherChannel;
      const fishing = connection.fishingState;
      const professions = connection.professionState;
      return {
        nodes: resourceNodes?.stats ?? { total: 0, seated: 0, depleted: 0, depletedIds: [] },
        inReach: node
          ? {
              placementId: node.placementId,
              nodeId: node.def.id,
              profession: node.def.profession,
              tier: node.def.tier,
              distance: node.distance,
              depleted: node.depleted,
            }
          : null,
        prompt: node ? nodePromptText(node) : null,
        channel: channel ? { nodeId: channel.nodeId ?? '', endsAtMs: channel.endsAtMs ?? 0 } : null,
        fishing: fishing
          ? {
              phase: fishing.phase,
              markerHalf: fishing.markerHalf ?? null,
              progress: connection.reelState.progress,
            }
          : null,
        professions: (professions?.professions ?? []).map((entry) => ({
          profession: entry.profession,
          level: entry.level,
          xp: entry.xp,
          codex: professions?.codex[entry.profession]?.length ?? 0,
        })),
        openPanel,
      };
    },
    sendGatherOp: (op: GatherOp): void => {
      connection.sendGatherOp(op);
    },
    /** Hold/release the reel without a real keyboard (input.ts has the why). */
    setReel: (held: boolean): void => {
      input.debugSetReel(held);
    },
    allocateStats: (deltas: AttributeSpread): void => {
      connection.sendAllocateStats(deltas);
    },
    allocateSkill: (nodeId: string): { ok: boolean; reason?: string } =>
      connection.sendAllocateSkill(nodeId),
    respec: (kind: RespecKind): void => {
      connection.sendRespec(kind);
    },
    setPanel: (panel: PanelId | null): void => {
      setPanel(panel);
    },
  };

  const professionsBridge: ProfessionsBridge = {
    subscribe: (listener) => {
      professionListeners.add(listener);
      return () => professionListeners.delete(listener);
    },
    version: () => professionsVersion,
    state: () => connection.professionState,
    /**
     * Everything a profession can produce, derived from the node definitions
     * it owns rather than from a list in the client: authoring a new herb
     * makes it collectable without a client change, which is the whole point
     * of content-as-data.
     */
    catalogue: (profession) => {
      const ids = new Set<string>();
      for (const def of nodeDefs.values()) {
        if (def.profession !== profession) continue;
        for (const itemId of nodeItemRefs(def)) ids.add(itemId);
      }
      return [...ids]
        .map((id) => connection.itemDefs.get(id))
        .filter((def): def is ItemDef => def !== undefined)
        .sort((a, b) => a.ilvl - b.ilvl || a.name.localeCompare(b.name));
    },
    iconUrl: (slug) => iconUrlMap.get(slug),
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
    // A roll STARTED (rising edge). Testing "still near its full duration"
    // instead reads the timer at frame rate: one long frame steps several sim
    // ticks at once and the whole window is skipped, so the roll goes silent
    // and the tap buffer survives into a second roll.
    if (connection.predicted.rollTimeLeft > 0 && !wasRolling) {
      sfx.play('dodge', 0.6);
      input.clearDodgeBuffer(); // the roll took — a leftover tap must not queue a second
    }
    wasRolling = connection.predicted.rollTimeLeft > 0;
    // A dodge that could not start says so ONCE per press — silence here reads
    // as "the roll is broken" when the real answer is stamina or the cooldown.
    if (connection.dodgeRefusal !== null && connection.dodgeRefusal !== lastDodgeRefusal) {
      hud.showRefusal(DODGE_REFUSAL_TEXT[connection.dodgeRefusal]);
      sfx.play('deny', 0.7);
    }
    lastDodgeRefusal = connection.dodgeRefusal;

    // 2. Per-frame networking housekeeping (corrections, interpolation).
    connection.update(deltaMs);

    // 2b. Machine happenings (P6): cast releases swing + fire NOW, channel
    // ticks flash the hand, cancels drop the gather loop with the reason.
    for (const event of connection.takeMachineEvents()) {
      const pos = connection.renderPosition();
      switch (event.kind) {
        case 'released':
          localView.setCasting(null);
          if (event.def) {
            localView.playAttack(
              event.def.anim.clip,
              event.def.anim.clipSeconds,
              event.def.anim.durationMs,
            );
            sfx.play(sfxSlotOf(event.def.sfx));
            abilityCommitVfx(event.def, pos.x, pos.y, pos.z, input.yaw);
          }
          break;
        case 'channel-tick':
          if (event.def) abilityCommitVfx(event.def, pos.x, pos.y, pos.z, input.yaw);
          sfx.play('bolt', 0.5);
          break;
        case 'channel-ended':
          localView.setCasting(null);
          break;
        case 'move-canceled':
          localView.setCasting(null);
          hud.showRefusal('Interrupted — you moved');
          sfx.play('deny', 0.6);
          break;
      }
    }

    // 3. Draw. The local player renders extrapolated by the accumulator's
    // sub-tick remainder (smooth at any fps over the 20 Hz sim) and faces the
    // LIVE mouse yaw — tick-quantized facing reads as input lag. Stunned
    // freezes the rig's facing at the shared step's frozen yaw (server rule);
    // the camera itself stays free.
    const dtSeconds = deltaMs / 1000;
    const position = connection.renderPosition(simulationReady ? accumulatorMs : 0);
    const selfStunned = (connection.selfFlags & EntityFlag.Stunned) !== 0;
    const selfRooted = selfStunned || (connection.selfFlags & EntityFlag.Rooted) !== 0;
    localView.setPose(
      position.x,
      position.y,
      position.z,
      selfStunned ? connection.predicted.yaw : input.yaw,
    );
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
    // Absorb shields shimmer on whoever holds one (chip carries the number).
    localView.setShielded(
      connection.effectsFor(connection.selfId).some((effect) => (effect.shieldRemaining ?? 0) > 0),
    );
    localView.update(localDt, {
      grounded: connection.predicted.grounded,
      sprinting: connection.predicted.sprinting,
      swimming: connection.predicted.swimming,
      dodging: connection.predicted.rollTimeLeft > 0,
    });
    syncRemoteViews(dtSeconds);
    syncBossFrame();
    telegraphs.update();
    combatText.update(dtSeconds);
    projectiles.update(dtSeconds);
    vfx.update(dtSeconds);
    lootBags.update(dtSeconds, now / 1000);
    vendorPosts.update(terrain.sampler);
    resourceNodes?.update(terrain.sampler, now);
    // The reel bar runs per FRAME, not per tick: it is the one thing on screen
    // the player steers directly, and a marker that moves twenty times a second
    // reads as input lag. The server steps the same shared function on its own
    // tick and corrects the progress; the marker stays local.
    connection.stepReel(input.reelHeld, now);

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
    // No enemy under the reticle: healers see the ally their heal would take
    // instead (green plate). The sweep range is the longest ally cast on the
    // own bar, so non-healers never grow an ally plate.
    let allyPlate: { name: string; level: number; hpFraction: number } | null = null;
    let allyPlateId = 0;
    if (!target) {
      let allyRange = 0;
      for (const def of connection.slotDefs.values()) {
        if (def.targeting.kind === 'ally_soft') {
          allyRange = Math.max(allyRange, def.targeting.range);
        }
      }
      const ally = allyRange > 0 ? allyTarget(allyRange) : null;
      if (ally) {
        const entry = connection.rosterEntryFor(ally.id);
        allyPlate = {
          name: entry?.name ?? connection.remotes.get(ally.id)?.name ?? '',
          level: entry?.level ?? 1,
          hpFraction: ally.hpFraction,
        };
        allyPlateId = ally.id;
      }
    }
    // What `F` would do from here (P8-D): the bag in reach wins over the post
    // you are standing in, because that is the order the key handler tries.
    const interactBag = nearestBag();
    const interactVendor = vendorPosts.inReach(position.x, position.z);
    const interactNode = resourceNodes?.inReach(position.x, position.z) ?? null;
    // Nothing to advertise while an interaction is already running: `F` means
    // "let go" then, not "start this", and the prompt shares the lower middle
    // of the screen with the gather and fishing bars — on a short window it
    // sat on top of "HOLD F TO REEL".
    const interacting = connection.gatherChannel !== null || connection.fishingState !== null;
    hud.setInteractPrompt(
      interacting
        ? null
        : interactBag && interactBag.distance <= LOOT_REACH_M
          ? 'F — Loot  ·  Shift+F — Loot all'
          : interactNode
            ? nodePromptText(interactNode)
            : interactVendor
              ? `F — Trade with ${interactVendor.name}`
              : null,
    );

    // The gathering surfaces: the hold bar closes itself when the channel does
    // (the server's every non-`start` phase clears it), and the fishing block
    // is rebuilt each frame from the attempt plus the locally-stepped bar.
    const fishState = connection.fishingState;
    if (fishState && fishState.phase !== 'caught' && fishState.phase !== 'escaped') {
      const fish = connection.fishPositionNow;
      const reel = connection.reelState;
      hud.setFishing({
        phase: fishState.phase,
        ...(fish !== null ? { fish } : {}),
        marker: reel.marker,
        ...(fishState.markerHalf !== undefined ? { markerHalf: fishState.markerHalf } : {}),
        progress: reel.progress,
        onTarget: fish !== null && Math.abs(reel.marker - fish) <= (fishState.markerHalf ?? 0.16),
      });
    } else {
      hud.setFishing(null);
    }
    hud.setGold(connection.inventory?.gold ?? null);

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
      serverNowMs: connection.serverNow(),
      bytesIn: connection.stats.bytesIn,
      bytesOut: connection.stats.bytesOut,
      netsim: connection.netsim,
      position,
      stamina: connection.predicted.stamina,
      maxStamina: connection.predicted.maxStamina,
      hp: connection.selfHp,
      maxHp: connection.selfMaxHp || playerStats(connection.classId, 1).maxHp,
      dawnedRemainingMs: Math.max(0, connection.dawnedUntilMs - now),
      target: target ?? allyPlate,
      targetFriendly: allyPlate !== null,
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
      cast,
      selfEffects: connection.effectsFor(connection.selfId),
      targetEffects: target
        ? connection.effectsFor(target.id)
        : allyPlateId > 0
          ? connection.effectsFor(allyPlateId)
          : [],
      dodgeReady: connection.dodgeReady(input.secondaryHeld),
      stanceHeld: input.secondaryHeld && !connection.selfDead,
      focusHeld: input.secondaryHeld && !connection.selfDead && connection.classId === 'mage',
      ccState: selfStunned ? 'stunned' : selfRooted ? 'rooted' : null,
      attunement: connection.classId === 'mage' ? connection.attunementCount : null,
      progress: connection.sheet
        ? {
            level: connection.sheet.level,
            xp: connection.sheet.xp,
            xpToNext: connection.sheet.xpToNext,
          }
        : null,
      unspentStatPoints: connection.sheet?.unspentStatPoints ?? 0,
      unspentSkillPoints: connection.sheet?.unspentSkillPoints ?? 0,
      openPanel,
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
          // Absorbs are public on enemies too (P9 self-shields): the bubble is
          // why your burst stopped moving the bar.
          enemyView.setShielded(
            connection.effectsFor(id).some((effect) => (effect.shieldRemaining ?? 0) > 0),
          );
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
        // Held gear is public (§1): the roster is how everyone sees your sword.
        view.setWeapons(entry.mainhandModel ?? null, entry.offhandModel ?? null);
      }

      view.setPose(remote.render.x, remote.render.y, remote.render.z, remote.render.yaw);
      view.setDead((remote.render.flags & EntityFlag.Dead) !== 0);
      view.setBlocking((remote.render.flags & EntityFlag.Blocking) !== 0);
      view.setShielded(
        connection.effectsFor(id).some((effect) => (effect.shieldRemaining ?? 0) > 0),
      );
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

  /**
   * Boss frame ownership (P9). A boss takes the frame when it is ENGAGED and
   * near enough to be the fight you are in — not when it is idling in its
   * grove, which would make the frame a landmark instead of a fight. Nearest
   * wins if two are somehow up; death, leash-home and walking out of range all
   * release it.
   */
  const syncBossFrame = (): void => {
    const self = connection.renderPosition();
    let bestId: number | null = null;
    let bestDist = Infinity;
    let bestMeta: EnemyMetaEntry | null = null;
    let bestHp = 1;
    for (const remote of connection.remotes.values()) {
      const meta = remote.enemyMeta;
      if (remote.kind !== EntityKind.Enemy || !meta) continue;
      if (meta.rank !== 'zone_boss' && meta.rank !== 'world_boss') continue;
      if ((remote.render.flags & (EntityFlag.Dead | EntityFlag.Leashing)) !== 0) continue;
      if ((remote.render.flags & EntityFlag.InCombat) === 0) continue;
      // The arena IS the fight's extent when a boss declares one — past it the
      // boss turns back, so the frame has nothing left to track. Bosses without
      // an arena get a default wide enough to survive a kite, tight enough to
      // release when you have genuinely left.
      const def = enemyDefs.get(meta.typeId);
      const range = def && def.arenaRadius > 0 ? def.arenaRadius : 45;
      const dist = Math.hypot(remote.render.x - self.x, remote.render.z - self.z);
      if (dist > range || dist >= bestDist) continue;
      bestDist = dist;
      bestId = remote.id;
      bestMeta = meta;
      bestHp = remote.render.hpFraction;
    }
    if (bestId === null || !bestMeta) {
      bossFrame.hide();
      return;
    }
    bossFrame.show(bestId, bestMeta.name, bestMeta.level, enemyDefs.get(bestMeta.typeId));
    bossFrame.setHp(bestHp);
    bossFrame.update();
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

  const progression: ProgressionBridge = {
    subscribe: (listener) => connection.subscribeProgress(listener),
    version: () => connection.progressVersion,
    classId: () => connection.classId,
    level: () => connection.selfLevel,
    identity: () => {
      const entry = connection.rosterEntryFor(connection.selfId);
      return {
        name: entry?.name ?? playerName,
        appearance: entry?.appearance ?? appearance,
        mainhandModel: entry?.mainhandModel ?? null,
        offhandModel: entry?.offhandModel ?? null,
      };
    },
    sheet: () => connection.sheet,
    nodeDefs: () => connection.skillNodeDefs,
    ranks: () => connection.ranks,
    hotbar: () =>
      HOTBAR_SLOTS.map((slot) => {
        const view = connection.slotView(slot);
        return { slot, def: view.def, lockedUntilLevel: view.lockedUntilLevel };
      }),
    allocateStats: (deltas) => {
      connection.sendAllocateStats(deltas);
    },
    allocateSkill: (nodeId) => connection.sendAllocateSkill(nodeId),
    respec: (kind) => {
      connection.sendRespec(kind);
    },
    iconUrl: (slug) => (slug ? iconUrlMap.get(slug) : undefined),
  };

  const inventory: InventoryBridge = {
    subscribe: (listener) => connection.subscribeItems(listener),
    version: () => connection.itemVersion,
    pack: () => connection.inventory,
    bags: () => {
      const self = connection.renderPosition();
      return [...connection.lootBags].sort(
        (a, b) => Math.hypot(a.x - self.x, a.z - self.z) - Math.hypot(b.x - self.x, b.z - self.z),
      );
    },
    vendor: () => connection.vendorPanel,
    itemDef: (itemId) => connection.itemDefs.get(itemId),
    iconUrl: (slug) => (slug ? iconUrlMap.get(slug) : undefined),
    distanceTo: (bagId) => {
      const bag = connection.lootBags.find((entry) => entry.id === bagId);
      if (!bag) return Infinity;
      const self = connection.renderPosition();
      return Math.hypot(bag.x - self.x, bag.z - self.z);
    },
    send: (op) => {
      connection.sendItemOp(op);
    },
  };

  return {
    dispose: () => {
      disposed = true;
      connection.disconnect();
      vfx.dispose();
      lootBags.dispose();
      vendorPosts.dispose();
      resourceNodes?.dispose();
      terrain.dispose();
      container.replaceChildren();
    },
    setPanel,
    progression,
    inventory,
    professions: professionsBridge,
  };
};
