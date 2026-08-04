/**
 * Dawned game server entry point.
 *
 * Boot order: config → logger → world → HTTP → WebSocket gateway → tick loop.
 * Shutdown is graceful: announce, drain sockets, stop the loop, exit.
 */

import path from 'node:path';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { MAP_VERSION, TICK_RATE } from '@dawned/shared';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { MetricsRing } from './metrics/ring.js';
import { World } from './world/world.js';
import { loadMapTerrain } from './world/terrain.js';
import { TickLoop } from './world/tick-loop.js';
import { Gateway } from './net/gateway.js';
import { registerRoutes } from './http/routes.js';
import { registerAuthRoutes } from './http/auth-routes.js';
import { assertDbReachable, assertSchemaPresent, createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { AuthService } from './auth/service.js';
import { CharacterService } from './characters/service.js';
import { loadContent } from './content/loader.js';

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL, config.NODE_ENV !== 'production');

// --- database ---------------------------------------------------------------
// Dev runs migrations automatically for a zero-step loop; production applies
// them explicitly via UPDATE.sh *before* the restart (docs/tech/DEPLOYMENT.md).
if (config.NODE_ENV !== 'production') {
  await runMigrations(config.DATABASE_URL);
  log.info('dev migrations applied');
}
const dbHandle = createDb(config.DATABASE_URL);
await assertDbReachable(dbHandle);
await assertSchemaPresent(dbHandle);

const auth = new AuthService(dbHandle.db, config.INVITE_CODE);
const characterService = new CharacterService(dbHandle.db);

// --- terrain ----------------------------------------------------------------
// The full map lives in memory (~8 MB) — the server is authoritative for
// ground height and walkability on every tick.
const map = await loadMapTerrain(path.join(config.MAP_DIR, MAP_VERSION));
log.info({ mapVersion: map.meta.mapVersion, chunks: map.terrain.chunkCount }, 'map terrain loaded');

// --- content ----------------------------------------------------------------
// Published enemies + spawners, zod-validated at the door (P4). A world with
// invalid content refuses to boot rather than half-run.
const content = await loadContent(dbHandle.db);
log.info(
  { enemies: content.enemies.size, spawners: content.spawners.length },
  'published content loaded',
);

const metrics = new MetricsRing();
const world = new World(map.terrain, map.meta.spawn, content, Math.random, map.zones);
log.info({ entities: world.entityCount, zones: map.zones.length }, 'world populated from spawners');

const app = Fastify({
  loggerInstance: log.child({ component: 'http' }),
  // Per-request logs are dev noise in production — Caddy keeps the access log,
  // and health checks would otherwise spam journald every few seconds.
  disableRequestLogging: config.NODE_ENV === 'production',
});

// Internal errors must never leak to the client — a failed DB query's message
// carries the SQL and its params (which for auth include the password hash).
// Log the real error; answer with a generic envelope. Fastify's own 4xx errors
// (bad content type, body too large, …) keep their safe client-facing messages.
app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
  const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
  if (status >= 500) {
    request.log.error({ err: error }, 'unhandled route error');
    void reply
      .code(500)
      .send({ error: 'internal', message: 'Something went wrong on the server — try again.' });
    return;
  }
  void reply.code(status).send({ error: 'bad_request', message: error.message });
});

await app.register(cors, {
  origin: config.NODE_ENV === 'production' ? [config.CLIENT_ORIGIN] : true,
});

// Order matters: Fastify refuses new routes once listening, and the gateway needs
// the raw http server (which exists before listen) to handle WS upgrades.
const gateway = new Gateway(
  app.server,
  world,
  config,
  log.child({ component: 'net' }),
  metrics,
  auth,
  characterService,
);
registerRoutes(app, {
  config,
  world,
  gateway,
  metrics,
  content,
  reloadContent: () => loadContent(dbHandle.db),
});
registerAuthRoutes(app, { auth, characters: characterService });

await app.listen({ host: config.HOST, port: config.PORT });

gateway.startPersistence();

// Hourly housekeeping: expired sessions don't need a cron, just an interval.
setInterval(
  () => {
    auth.purgeExpiredSessions().catch((error: unknown) => {
      log.error({ err: error }, 'session purge failed');
    });
  },
  60 * 60 * 1000,
).unref();

let idleSweepCounter = 0;
let consecutiveTickErrors = 0;
/** A tick throwing this many times in a row means the world is wedged — bail out. */
const MAX_CONSECUTIVE_TICK_ERRORS = 100;

const loop = new TickLoop(
  (tick) => {
    // The tick is guarded: one bad tick must not take 20 players down with it
    // (packet handling has its own guards in the gateway — this catches bugs in
    // the simulation itself). Persistent failure still exits so systemd restarts
    // us instead of leaving a wedged world running.
    try {
      const events = world.step();
      // Snapshots FIRST: entitiesFor refreshes every viewer's interest set,
      // and the event fan-out scopes by those sets — the other order drops
      // events about entities a client is meeting this very tick (a fresh
      // join stood next to an alerting enemy and never heard the alert).
      gateway.broadcastSnapshots(tick);
      gateway.broadcastCombatEvents(events);

      // Once a second: drop dead sockets and expire reconnect grace windows.
      if (++idleSweepCounter >= TICK_RATE) {
        idleSweepCounter = 0;
        gateway.sweepIdle();
        gateway.sweepLingering();
      }
      consecutiveTickErrors = 0;
    } catch (error) {
      consecutiveTickErrors++;
      log.error({ err: error, consecutiveTickErrors }, 'tick failed');
      if (consecutiveTickErrors >= MAX_CONSECUTIVE_TICK_ERRORS) {
        log.fatal('tick loop is persistently failing — shutting down for a clean restart');
        shutdown('tick-loop-failure', 1);
      }
    }
  },
  (durationMs) => {
    metrics.recordTick(durationMs);
  },
);

loop.start();

log.info(
  {
    host: config.HOST,
    port: config.PORT,
    tickRate: TICK_RATE,
    env: config.NODE_ENV,
  },
  'Dawned game server ready',
);

let shuttingDown = false;
/** Graceful shutdown. `exitCode` 0 = intentional stop, non-zero = crash path. */
function shutdown(signal: string, exitCode = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal, exitCode }, 'shutting down');
  loop.stop();
  gateway.shutdown();
  void dbHandle.close().catch(() => undefined);
  void app.close().then(
    () => {
      process.exit(exitCode);
    },
    (error: unknown) => {
      log.error({ err: error }, 'error during shutdown');
      process.exit(exitCode || 1);
    },
  );
  // Never hang a restart: hard-exit if something refuses to close.
  setTimeout(() => {
    process.exit(exitCode);
  }, 3000).unref();
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('uncaughtException', (error) => {
  log.fatal({ err: error }, 'uncaught exception');
  // Exit non-zero: masking a crash as a clean stop hides it from ops tooling.
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  log.fatal({ err: reason }, 'unhandled rejection');
});
