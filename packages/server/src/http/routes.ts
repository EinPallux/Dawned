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
}

const LOCALHOST = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const registerRoutes = (app: App, deps: RouteDeps): void => {
  const { config, world, gateway, metrics } = deps;

  app.get('/api/health', () => ({
    status: 'ok',
    protocolVersion: PROTOCOL_VERSION,
    tickRate: TICK_RATE,
    players: world.playerCount,
    uptimeSec: Math.round(process.uptime()),
  }));

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
};
