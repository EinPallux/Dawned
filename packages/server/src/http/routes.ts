/**
 * HTTP surface.
 *
 * `/api/*` is public (through Caddy); `/ops/*` is localhost-only and additionally
 * gated by a shared secret — it is how Dawned-Admin drives live ops
 * (docs/tech/SECURITY.md §3).
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, RawServerDefault } from 'fastify';
import type { Logger } from 'pino';
import {
  MAX_PROFESSION_LEVEL,
  PROFESSIONS,
  PROTOCOL_VERSION,
  TICK_RATE,
  type Profession,
} from '@dawned/shared';
import { BUILD_ID } from '../build-id.js';
import type { Config } from '../config.js';
import type { MetricsRing } from '../metrics/ring.js';
import type { World } from '../world/world.js';
import type { Gateway } from '../net/gateway.js';
import type { GameContent } from '../content/loader.js';
import type { LoadedMap } from '../world/terrain.js';

/**
 * The concrete Fastify instance type produced by our boot options (a pino
 * `loggerInstance` narrows Fastify's logger generic away from the default).
 */
export type App = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>;

export interface RouteDeps {
  config: Config;
  world: World;
  gateway: Gateway;
  metrics: MetricsRing;
  content: GameContent;
  /** Re-read published rows + hot-swap the world's content (admin publish). */
  reloadContent: () => Promise<GameContent>;
  /** The baked map version this process booted with (A2 `current.json`). */
  mapVersion: string;
  /** Re-read `current.json` and load that bake (admin map publish). */
  reloadMap: () => Promise<LoadedMap>;
}

const LOCALHOST = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Constant-time secret comparison that tolerates different lengths. */
const secretMatches = (offered: string, expected: string): boolean => {
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still compare something of equal length so the reject path costs the same.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
};

export const registerRoutes = (app: App, deps: RouteDeps): void => {
  const { config, world, gateway, metrics, reloadContent, reloadMap } = deps;

  /**
   * Nothing this server answers may sit in a browser cache. Without an
   * explicit header a browser is free to invent a freshness lifetime for a
   * 200 response and serve it again without asking — which is how a player
   * ends up looking at yesterday's ability list in a normal tab while a
   * private window (empty cache) shows the truth. Session-bearing routes
   * (`/api/characters`, auth) must not linger on disk either.
   */
  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });
  /**
   * ONE gate for every `/ops/*` route — localhost + shared secret, applied by
   * the router rather than repeated in each handler.
   *
   * It used to be a copy of the same six lines inside all nineteen handlers.
   * All nineteen had it, and that is the problem: nothing made a twentieth
   * route carry it, and a missed one is an unauthenticated lever that grants
   * items, sets levels and teleports players. Same class as `AbilityStart.cast`
   * being rebuilt field-by-field until the field was made REQUIRED — the fix
   * for "someone will forget" is to remove the opportunity, not to be careful.
   *
   * `timingSafeEqual` because comparing a secret with `!==` leaks its length and
   * a prefix through response timing. Localhost-only makes that impractical
   * rather than impossible, and constant-time costs nothing.
   */
  app.addHook('onRequest', (request, reply, done) => {
    if (!request.url.startsWith('/ops/')) {
      done();
      return;
    }
    const remote = request.socket.remoteAddress ?? '';
    if (!LOCALHOST.has(remote)) {
      void reply.code(403).send({ error: 'ops API is localhost-only' });
      return;
    }
    const offered = request.headers['x-ops-secret'];
    if (typeof offered !== 'string' || !secretMatches(offered, config.OPS_SECRET)) {
      void reply.code(401).send({ error: 'bad ops secret' });
      return;
    }
    done();
  });

  // Mutable so /ops/reload-content refreshes what the content routes serve.
  let content = deps.content;
  // Same for the map: /ops/reload-map swaps the live bake under the world, and
  // this is what tells clients which artifacts to stream.
  let mapVersion = deps.mapVersion;

  app.get('/api/health', () => {
    return {
      status: 'ok',
      buildId: BUILD_ID,
      protocolVersion: PROTOCOL_VERSION,
      tickRate: TICK_RATE,
      // The map the SERVER is simulating. The client streams whatever this
      // says rather than a compiled-in constant, which is what stops a publish
      // from putting the two on different ground (docs/tech/NETWORKING.md §3.4).
      mapVersion,
      players: world.playerCount,
      uptimeSec: Math.round(process.uptime()),
    };
  });

  /**
   * Published enemy definitions (P4): the client renders enemies from the
   * same data rows the server simulates — ability clip names, hit capsules,
   * scales (content-as-data; the response only changes on publish).
   */
  app.get('/api/content/enemies', () => {
    return { enemies: [...content.enemies.values()] };
  });

  /** Published ability definitions (P5): hotbar defs the client predicts with. */
  app.get('/api/content/abilities', () => {
    return { abilities: [...content.abilities.values()] };
  });

  /** Published skill-tree nodes (P7): the trees the client draws + predicts. */
  app.get('/api/content/skill-nodes', () => {
    return { nodes: [...content.skillNodes.values()] };
  });

  /**
   * Published item definitions (P8): names, icons, rarity, stat blocks — the
   * catalogue every tooltip, bag cell and vendor row is drawn from. The wire
   * only ever carries item IDs; this is where they get their meaning.
   */
  app.get('/api/content/items', () => {
    return { items: [...content.items.values()] };
  });

  /**
   * Published vendors (P8): the client needs their anchors to stand a market
   * post in the world and offer the `F` prompt. Stock and prices still come
   * over the wire from the server when the panel actually opens — this is
   * geography, not an authority on what anything costs.
   */
  app.get('/api/content/vendors', () => {
    return {
      vendors: [...content.vendors.values()].map((vendor) => ({
        id: vendor.id,
        name: vendor.name,
        kind: vendor.kind,
        anchor: vendor.anchor,
      })),
    };
  });

  /**
   * Published resource-node definitions (P10): what each node standing in the
   * baked map IS — its model, its depleted model, its profession and tier, and
   * the hold time. The client already has WHERE every node stands (the bake's
   * `placements.json`, which it streams with the terrain); this is the other
   * half, and it is why the wire only ever needs to carry the exceptions —
   * which nodes are currently taken.
   */
  app.get('/api/content/resource-nodes', () => {
    return { nodes: [...content.resourceNodes.values()] };
  });

  /**
   * Published quests (P11): the client needs names, journal prose and step
   * text to render a journal at all. The STATE is never here — that comes from
   * `QuestSync` and is the server's alone; this is the catalogue, exactly as
   * `/api/content/items` is.
   */
  app.get('/api/content/quests', () => {
    return { quests: [...content.quests.values()] };
  });

  /** Published NPCs (P11): names, models and clips so the client can stand them up. */
  app.get('/api/content/npcs', () => {
    return { npcs: [...content.npcs.values()] };
  });

  /** Minimal public status for the login screen's server pip. */
  app.get('/api/status', () => ({
    online: true,
    players: world.playerCount,
    maxPlayers: config.MAX_PLAYERS,
  }));

  app.get('/ops/metrics', (_request, reply) => {
    return reply.send({
      ...metrics.snapshot(world.playerCount, world.entityCount),
      sessions: gateway.sessionCount,
    });
  });

  /**
   * Hot content reload (A1 publish pipeline): re-validate published rows and
   * swap them into the live world between ticks. Ability/enemy defs apply to
   * future uses immediately; spawner LAYOUT changes need a restart (reported).
   */
  app.post('/ops/reload-content', async (_request, reply) => {
    try {
      const next = await reloadContent();
      content = next;
      const summary = world.applyContent(next);
      return await reply.send({
        ok: true,
        ...summary,
        note: 'spawner layout changes apply on restart',
      });
    } catch (error) {
      // Validation failures keep the OLD content live — publish is the gate.
      return await reply.code(422).send({ ok: false, error: (error as Error).message });
    }
  });

  /**
   * Hot map reload (A2 map publish): re-read `current.json`, load that bake and
   * swap it under the running world. This is the endpoint that makes
   * MAP_EDITOR.md §7's "publish — and stand on it in the live game within
   * minutes" true without a deploy.
   *
   * Loading happens BEFORE the swap, so a half-written or invalid bake throws
   * with the old map still live. Connected clients notice through the
   * `mapVersion` on `/api/health` and offer a reload — a whole new world's
   * worth of terrain, walkgrid, zones and placements is not something to
   * re-stream in place while someone is mid-fight.
   */
  app.post('/ops/reload-map', async (_request, reply) => {
    try {
      const next = await reloadMap();
      const summary = world.applyMap({
        terrain: next.terrain,
        spawn: next.meta.spawn,
        zones: next.zones,
        nodes: next.nodes,
        world: { npcs: next.npcs, interactables: next.interactables, pois: next.pois },
      });
      mapVersion = next.meta.mapVersion;
      gateway.broadcastSystemChat(
        `The world has been republished (${mapVersion}). Reload to walk on the new map.`,
      );
      return await reply.send({
        ok: true,
        mapVersion,
        chunks: next.terrain.chunkCount,
        zones: next.zones.length,
        ...summary,
        note: 'players are asked to reload; enemies were re-seeded from spawners',
      });
    } catch (error) {
      // A bad bake keeps the OLD map live — the world never runs without ground.
      return await reply.code(422).send({ ok: false, error: (error as Error).message });
    }
  });

  app.post('/ops/announce', (request, reply) => {
    const body = request.body as { text?: unknown } | undefined;
    const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 300) : '';
    if (!text) return reply.code(400).send({ error: 'text required' });
    gateway.broadcastSystemChat(text);
    return reply.send({ ok: true, delivered: gateway.sessionCount });
  });

  /**
   * Apply a stun/root to a named online player (P6). The GM primitive behind
   * a future /stun command — and how the P6 smoke drives the CC/interrupt/DR
   * path until P9 enemies cast control themselves. Full DR rules apply.
   */
  app.post('/ops/cc', (request, reply) => {
    const body = request.body as
      { player?: unknown; kind?: unknown; durationMs?: unknown } | undefined;
    const player = typeof body?.player === 'string' ? body.player.trim() : '';
    const kind = body?.kind === 'stun' || body?.kind === 'root' ? body.kind : null;
    const durationMs =
      typeof body?.durationMs === 'number'
        ? Math.min(10000, Math.max(100, Math.floor(body.durationMs)))
        : 2000;
    if (!player || !kind) {
      return reply.code(400).send({ error: 'player and kind (stun|root) required' });
    }
    if (!world.queueCc(player, kind, durationMs)) {
      return reply.code(404).send({ error: 'player not online' });
    }
    return reply.send({ ok: true, kind, durationMs });
  });

  /**
   * Set an online player's level (P7): the pre-GM-suite dev/admin primitive
   * behind the panel's future Live Ops button and the P7 smoke's fixtures.
   * Runs the same setLevel path as the in-game /setlevel command.
   */
  app.post('/ops/setlevel', (request, reply) => {
    const body = request.body as { player?: unknown; level?: unknown } | undefined;
    const player = typeof body?.player === 'string' ? body.player.trim() : '';
    const level =
      typeof body?.level === 'number' ? Math.min(30, Math.max(1, Math.floor(body.level))) : 0;
    if (!player || level < 1) {
      return reply.code(400).send({ error: 'player and level (1..30) required' });
    }
    if (!world.queueSetLevelByName(player, level)) {
      return reply.code(404).send({ error: 'player not online' });
    }
    return reply.send({ ok: true, level });
  });

  /**
   * Set an online player's HP to a fraction of max (P6). GM primitive; the
   * smoke uses it to stage deterministic heal targets (OOC regen otherwise
   * erases any pre-damaged fixture within seconds). Marks combat, never kills.
   */
  app.post('/ops/hurt', (request, reply) => {
    const body = request.body as { player?: unknown; fraction?: unknown } | undefined;
    const player = typeof body?.player === 'string' ? body.player.trim() : '';
    const fraction =
      typeof body?.fraction === 'number' ? Math.min(1, Math.max(0.01, body.fraction)) : 0.5;
    if (!player) return reply.code(400).send({ error: 'player required' });
    if (!world.queueHurt(player, fraction)) {
      return reply.code(404).send({ error: 'player not online' });
    }
    return reply.send({ ok: true, fraction });
  });

  /**
   * Set an online player's gathering-profession level (P10).
   *
   * The verification run needs to reach a T3 node without gathering 1 → 13
   * first, and the owner will want to check a tier gate without an afternoon
   * of chopping. Same shape as `/ops/setlevel`, and audited the same way.
   */
  app.post('/ops/setprof', (request, reply) => {
    const body = request.body as
      { player?: unknown; profession?: unknown; level?: unknown } | undefined;
    const player = typeof body?.player === 'string' ? body.player.trim() : '';
    const profession = typeof body?.profession === 'string' ? body.profession.trim() : '';
    const level =
      typeof body?.level === 'number'
        ? Math.min(MAX_PROFESSION_LEVEL, Math.max(1, Math.floor(body.level)))
        : 0;
    if (!player || !level) return reply.code(400).send({ error: 'player and level required' });
    if (!(PROFESSIONS as readonly string[]).includes(profession)) {
      return reply.code(400).send({ error: `profession must be one of ${PROFESSIONS.join(', ')}` });
    }
    if (!world.setProfessionByName(player, profession as Profession, level)) {
      return reply.code(404).send({ error: 'player not online' });
    }
    return reply.send({ ok: true, profession, level });
  });

  /**
   * Answer the next fishing bite for an online player (P10).
   *
   * The hook window is 0.8 s of reaction, which a headless browser cannot
   * supply — one stalled frame eats the whole window, so a bot could never
   * reach the reel bar the run exists to measure. This arms the SAME
   * `hookFishing` the key calls, on the tick the bite opens: the lever is the
   * reflex, never the outcome. Same shape as `/ops/hurt` keeping the P9 boss
   * bot alive because it cannot dodge.
   */
  app.post('/ops/hook', (request, reply) => {
    const body = request.body as { player?: unknown; bites?: unknown } | undefined;
    const player = typeof body?.player === 'string' ? body.player.trim() : '';
    const bites =
      typeof body?.bites === 'number' ? Math.min(50, Math.max(1, Math.floor(body.bites))) : 1;
    if (!player) return reply.code(400).send({ error: 'player required' });
    if (!world.hookFishingByName(player, bites)) {
      return reply.code(404).send({ error: 'player not online' });
    }
    return reply.send({ ok: true, armed: player, bites });
  });

  /**
   * Put a named fish on a player's line for their next casts (P10).
   *
   * The reel bar's speed and catch width come from the fish's rarity, so "is
   * the rare's bar winnable?" cannot be answered by fishing until a rare turns
   * up — that is one weight in ten and measures the yield roll, not the reel.
   * This picks the yield entry directly; everything after it (the bite, the
   * window, the bar, the catch, the xp) is the untouched real path. It is also
   * the tuning handle for USER_QUESTIONS Q27: judging a legendary means hooking
   * one on demand. Ignored if the water does not stock that fish.
   */
  app.post('/ops/fish', (request, reply) => {
    const body = request.body as { player?: unknown; item?: unknown; casts?: unknown } | undefined;
    const player = typeof body?.player === 'string' ? body.player.trim() : '';
    const item = typeof body?.item === 'string' ? body.item.trim() : '';
    const casts =
      typeof body?.casts === 'number' ? Math.min(50, Math.max(1, Math.floor(body.casts))) : 1;
    if (!player) return reply.code(400).send({ error: 'player required' });
    if (!item) return reply.code(400).send({ error: 'item required' });
    if (!world.forceFishByName(player, item, casts)) {
      return reply.code(404).send({ error: 'player not online' });
    }
    return reply.send({ ok: true, armed: player, item, casts });
  });

  /**
   * Put a quest on a character at a given step (P11).
   *
   * The A4 quest editor's "grant to my GM character at step n" button, and how
   * a verification run reaches step 3 of a four-part chain without playing the
   * first three. It sets STATE, never rewards: the turn-in, the payout and the
   * counters are the untouched real path, same as `/ops/fish` supplying the
   * fish but not the catch.
   */
  app.post('/ops/quest', (request, reply) => {
    const body = request.body as
      { player?: unknown; quest?: unknown; step?: unknown; drop?: unknown } | undefined;
    const player = typeof body?.player === 'string' ? body.player.trim() : '';
    const quest = typeof body?.quest === 'string' ? body.quest.trim() : '';
    const step = typeof body?.step === 'number' ? Math.max(0, Math.floor(body.step)) : 0;
    const drop = body?.drop === true;
    if (!player || !quest) return reply.code(400).send({ error: 'player and quest required' });
    if (!content.quests.has(quest)) {
      return reply.code(404).send({ error: `unknown quest "${quest}"` });
    }
    if (!world.setQuestByName(player, quest, step, drop)) {
      return reply.code(404).send({ error: 'player not online' });
    }
    return reply.send({ ok: true, player, quest, step, drop });
  });

  /**
   * Un-find POIs / zones / shrines / used objects, so the discovery loop can
   * be MEASURED again (P11-E; ARCHITECTURE.md §3).
   *
   * First-entry-only is the whole point of discovery, which means a character
   * that has walked the island can never show the banner, the XP or the map
   * reveal a second time. Same argument as `/ops/hurt` keeping the P9 boss bot
   * alive and `/ops/fish` putting a rare on the line: the lever undoes the
   * SETUP, never the thing being measured.
   */
  app.post('/ops/forget', (request, reply) => {
    const body = request.body as
      | {
          player?: unknown;
          pois?: unknown;
          zones?: unknown;
          shrines?: unknown;
          objects?: unknown;
        }
      | undefined;
    const player = typeof body?.player === 'string' ? body.player.trim() : '';
    if (!player) return reply.code(400).send({ error: 'player required' });
    // POIs alone by default: zone XP is a far bigger award, and a run that
    // wants a vista back should not be handed four levels with it.
    const what = {
      pois: body?.pois !== false,
      zones: body?.zones === true,
      shrines: body?.shrines === true,
      objects: body?.objects === true,
    };
    const cleared = world.forgetDiscoveries(player, what);
    if (!cleared) return reply.code(404).send({ error: 'player not online' });
    return reply.send({ ok: true, player, ...cleared });
  });

  /**
   * What the bestiary became in this world (P12-C): camps seeded, enemies
   * alive, per-zone population, and — the line that matters — camps that
   * produced nothing. 124 camps published into open water look exactly like
   * 124 camps published onto land from the publish button's side.
   */
  app.get('/ops/camps', (_request, reply) => {
    return reply.send({ ok: true, ...world.campReport });
  });

  /**
   * What the live world actually seeded from the map bake (P11).
   *
   * The counterpart to `/ops/respawnnodes` reporting "65 nodes, 0 orphans": a
   * publish saying "ok" is the PANEL's account of its own work, and a bake that
   * carries four villagers the world quietly dropped looks identical from
   * outside. This is the line that proves the content crossed the boundary, and
   * `orphanNpcs` names the placements whose definition did not resolve.
   */
  app.get('/ops/worldobjects', (_request, reply) => {
    return reply.send({ ok: true, ...world.worldObjects });
  });

  /**
   * Bring every depleted resource node back at once (P10).
   *
   * Respawns are 90–180 s by design, which is right in play and tedious in a
   * test: a run that has to wait three minutes to gather the same tree twice
   * is a run nobody will execute.
   */
  app.post('/ops/respawnnodes', (_request, reply) => {
    return reply.send({ ok: true, respawned: world.respawnAllNodes(), ...world.nodeStats });
  });

  /**
   * Grant items or gold to an online player (P8). GM primitive behind the
   * panel's future "grant item" button and the P8 smoke's fixtures — it runs
   * the same planner a pickup does, so a full bag refuses like a full bag.
   */
  app.post('/ops/grant', (request, reply) => {
    const body = request.body as
      { player?: unknown; itemId?: unknown; qty?: unknown; gold?: unknown } | undefined;
    const player = typeof body?.player === 'string' ? body.player.trim() : '';
    const itemId = typeof body?.itemId === 'string' ? body.itemId.trim() : '';
    const qty =
      typeof body?.qty === 'number' ? Math.min(999, Math.max(1, Math.floor(body.qty))) : 1;
    const gold =
      typeof body?.gold === 'number'
        ? Math.min(1_000_000, Math.max(-1_000_000, Math.floor(body.gold)))
        : 0;
    if (!player || (!itemId && gold === 0)) {
      return reply.code(400).send({ error: 'player and itemId or gold required' });
    }
    if (itemId && !world.hasItem(itemId)) {
      return reply.code(404).send({ error: 'unknown item id' });
    }
    const delivered = itemId
      ? world.queueGrant(player, itemId, qty)
      : world.queueGrantGold(player, gold);
    if (!delivered) return reply.code(404).send({ error: 'player not online' });
    if (itemId && gold !== 0) world.queueGrantGold(player, gold);
    return reply.send({ ok: true, ...(itemId ? { itemId, qty } : {}), ...(gold ? { gold } : {}) });
  });

  /**
   * Set a living enemy's HP to a fraction of max (P9). GM primitive: it makes
   * boss phases and hp-threshold abilities reachable in seconds instead of a
   * full fight per beat. It only moves the bar — the phase walk, the announce
   * and the shield are the real AI reacting, never staged.
   */
  app.post('/ops/enemyhurt', (request, reply) => {
    const body = request.body as { enemyId?: unknown; fraction?: unknown } | undefined;
    const typeId = typeof body?.enemyId === 'string' ? body.enemyId.trim() : '';
    const fraction =
      typeof body?.fraction === 'number' ? Math.min(1, Math.max(0.01, body.fraction)) : 0.5;
    if (!typeId) return reply.code(400).send({ error: 'enemyId (content slug) required' });
    const entityId = world.queueEnemyHurt(typeId, fraction);
    if (entityId === null) return reply.code(404).send({ error: 'no living enemy of that type' });
    return reply.send({ ok: true, entityId, fraction });
  });

  /**
   * Spawn a transient wave of enemies (P9). GM primitive for world events, and
   * how the load harness reaches the 150-active-AI budget the published
   * bestiary does not by itself stand up. Wave enemies never respawn.
   */
  app.post('/ops/spawnwave', (request, reply) => {
    const body = request.body as
      | { enemyId?: unknown; count?: unknown; x?: unknown; z?: unknown; radius?: unknown }
      | undefined;
    const enemyId = typeof body?.enemyId === 'string' ? body.enemyId.trim() : '';
    const count =
      typeof body?.count === 'number' ? Math.min(200, Math.max(1, Math.floor(body.count))) : 1;
    const x = typeof body?.x === 'number' ? body.x : NaN;
    const z = typeof body?.z === 'number' ? body.z : NaN;
    const radius = typeof body?.radius === 'number' ? Math.min(120, Math.max(0, body.radius)) : 12;
    if (!enemyId || !Number.isFinite(x) || !Number.isFinite(z)) {
      return reply.code(400).send({ error: 'enemyId, x and z required' });
    }
    const spawned = world.queueSpawnWave(enemyId, count, x, z, radius);
    if (spawned === 0) return reply.code(404).send({ error: 'unknown enemy id' });
    return reply.send({ ok: true, enemyId, spawned });
  });

  /**
   * Teleport an online player (P9). Every verification run otherwise opens
   * with a two-minute walk to whichever camp or arena it is about to test.
   */
  app.post('/ops/tp', (request, reply) => {
    const body = request.body as { player?: unknown; x?: unknown; z?: unknown } | undefined;
    const player = typeof body?.player === 'string' ? body.player.trim() : '';
    const x = typeof body?.x === 'number' ? body.x : NaN;
    const z = typeof body?.z === 'number' ? body.z : NaN;
    if (!player || !Number.isFinite(x) || !Number.isFinite(z)) {
      return reply.code(400).send({ error: 'player, x and z required' });
    }
    if (!world.queueTeleport(player, x, z)) {
      return reply.code(404).send({ error: 'player not online' });
    }
    return reply.send({ ok: true, x, z });
  });
};
