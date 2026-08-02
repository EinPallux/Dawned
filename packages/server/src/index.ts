/**
 * Dawned game server entry point.
 *
 * Boot order: config → logger → world → HTTP → WebSocket gateway → tick loop.
 * Shutdown is graceful: announce, drain sockets, stop the loop, exit.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { TICK_RATE } from '@dawned/shared';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { MetricsRing } from './metrics/ring.js';
import { World } from './world/world.js';
import { TickLoop } from './world/tick-loop.js';
import { Gateway } from './net/gateway.js';
import { registerRoutes } from './http/routes.js';
import { registerAuthRoutes } from './http/auth-routes.js';
import { assertDbReachable, createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { AuthService } from './auth/service.js';
import { CharacterService } from './characters/service.js';

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

const auth = new AuthService(dbHandle.db, config.INVITE_CODE);
const characterService = new CharacterService(dbHandle.db);

const metrics = new MetricsRing();
const world = new World();

const app = Fastify({
  loggerInstance: log.child({ component: 'http' }),
  // Per-request logs are dev noise in production — Caddy keeps the access log,
  // and health checks would otherwise spam journald every few seconds.
  disableRequestLogging: config.NODE_ENV === 'production',
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
registerRoutes(app, { config, world, gateway, metrics });
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
      for (const event of events) {
        // Fall damage has nothing to damage until P4 wires HP — but the contract
        // stays visible instead of silently vanishing.
        log.debug({ event }, 'world event');
      }
      gateway.broadcastSnapshots(tick);

      // Once a second: drop dead sockets.
      if (++idleSweepCounter >= TICK_RATE) {
        idleSweepCounter = 0;
        gateway.sweepIdle();
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
