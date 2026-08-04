/**
 * HTTP surface.
 *
 * `/api/*` is public (through Caddy); `/ops/*` is localhost-only and additionally
 * gated by a shared secret — it is how Dawned-Admin drives live ops
 * (docs/tech/SECURITY.md §3).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, RawServerDefault } from 'fastify';
import type { Logger } from 'pino';
import { PROTOCOL_VERSION, TICK_RATE } from '@dawned/shared';
import type { Config } from '../config.js';
import type { MetricsRing } from '../metrics/ring.js';
import type { World } from '../world/world.js';
import type { Gateway } from '../net/gateway.js';
import type { GameContent } from '../content/loader.js';

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
}

const LOCALHOST = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const registerRoutes = (app: App, deps: RouteDeps): void => {
  const { config, world, gateway, metrics, reloadContent } = deps;
  // Mutable so /ops/reload-content refreshes what the content routes serve.
  let content = deps.content;

  app.get('/api/health', () => ({
    status: 'ok',
    protocolVersion: PROTOCOL_VERSION,
    tickRate: TICK_RATE,
    players: world.playerCount,
    uptimeSec: Math.round(process.uptime()),
  }));

  /**
   * Published enemy definitions (P4): the client renders enemies from the
   * same data rows the server simulates — ability clip names, hit capsules,
   * scales (content-as-data; the response only changes on publish).
   */
  app.get('/api/content/enemies', (_request, reply) => {
    void reply.header('cache-control', 'no-cache');
    return { enemies: [...content.enemies.values()] };
  });

  /** Published ability definitions (P5): hotbar defs the client predicts with. */
  app.get('/api/content/abilities', (_request, reply) => {
    void reply.header('cache-control', 'no-cache');
    return { abilities: [...content.abilities.values()] };
  });

  /** Published skill-tree nodes (P7): the trees the client draws + predicts. */
  app.get('/api/content/skill-nodes', (_request, reply) => {
    void reply.header('cache-control', 'no-cache');
    return { nodes: [...content.skillNodes.values()] };
  });

  /** Minimal public status for the login screen's server pip. */
  app.get('/api/status', () => ({
    online: true,
    players: world.playerCount,
    maxPlayers: config.MAX_PLAYERS,
  }));

  app.get('/ops/metrics', (request, reply) => {
    const remote = request.socket.remoteAddress ?? '';
    if (!LOCALHOST.has(remote)) {
      return reply.code(403).send({ error: 'ops API is localhost-only' });
    }
    if (request.headers['x-ops-secret'] !== config.OPS_SECRET) {
      return reply.code(401).send({ error: 'bad ops secret' });
    }
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
  app.post('/ops/reload-content', async (request, reply) => {
    const remote = request.socket.remoteAddress ?? '';
    if (!LOCALHOST.has(remote)) {
      return reply.code(403).send({ error: 'ops API is localhost-only' });
    }
    if (request.headers['x-ops-secret'] !== config.OPS_SECRET) {
      return reply.code(401).send({ error: 'bad ops secret' });
    }
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

  app.post('/ops/announce', (request, reply) => {
    const remote = request.socket.remoteAddress ?? '';
    if (!LOCALHOST.has(remote)) {
      return reply.code(403).send({ error: 'ops API is localhost-only' });
    }
    if (request.headers['x-ops-secret'] !== config.OPS_SECRET) {
      return reply.code(401).send({ error: 'bad ops secret' });
    }
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
    const remote = request.socket.remoteAddress ?? '';
    if (!LOCALHOST.has(remote)) {
      return reply.code(403).send({ error: 'ops API is localhost-only' });
    }
    if (request.headers['x-ops-secret'] !== config.OPS_SECRET) {
      return reply.code(401).send({ error: 'bad ops secret' });
    }
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
    const remote = request.socket.remoteAddress ?? '';
    if (!LOCALHOST.has(remote)) {
      return reply.code(403).send({ error: 'ops API is localhost-only' });
    }
    if (request.headers['x-ops-secret'] !== config.OPS_SECRET) {
      return reply.code(401).send({ error: 'bad ops secret' });
    }
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
    const remote = request.socket.remoteAddress ?? '';
    if (!LOCALHOST.has(remote)) {
      return reply.code(403).send({ error: 'ops API is localhost-only' });
    }
    if (request.headers['x-ops-secret'] !== config.OPS_SECRET) {
      return reply.code(401).send({ error: 'bad ops secret' });
    }
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
};
