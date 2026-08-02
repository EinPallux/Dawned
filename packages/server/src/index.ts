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

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL, config.NODE_ENV !== 'production');

const metrics = new MetricsRing();
const world = new World();

const app = Fastify({ loggerInstance: log.child({ component: 'http' }) });

await app.register(cors, {
  origin: config.NODE_ENV === 'production' ? [config.CLIENT_ORIGIN] : true,
});

// Order matters: Fastify refuses new routes once listening, and the gateway needs
// the raw http server (which exists before listen) to handle WS upgrades.
const gateway = new Gateway(app.server, world, config, log.child({ component: 'net' }), metrics);
registerRoutes(app, { config, world, gateway, metrics });

await app.listen({ host: config.HOST, port: config.PORT });

let idleSweepCounter = 0;

const loop = new TickLoop(
  (tick) => {
    world.step();
    gateway.broadcastSnapshots(tick);

    // Once a second: drop dead sockets.
    if (++idleSweepCounter >= TICK_RATE) {
      idleSweepCounter = 0;
      gateway.sweepIdle();
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
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  loop.stop();
  gateway.shutdown();
  void app.close().then(
    () => {
      process.exit(0);
    },
    (error: unknown) => {
      log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    },
  );
  // Never hang a restart: hard-exit if something refuses to close.
  setTimeout(() => {
    process.exit(0);
  }, 3000).unref();
};

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('uncaughtException', (error) => {
  log.fatal({ err: error }, 'uncaught exception');
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  log.fatal({ err: reason }, 'unhandled rejection');
});
