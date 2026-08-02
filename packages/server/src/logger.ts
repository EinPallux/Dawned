/** Structured logging (pino → journald in production, pretty in dev). */

import { pino, type Logger } from 'pino';

export const createLogger = (level: string, pretty: boolean): Logger =>
  pino(
    pretty
      ? {
          level,
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : { level },
  );

export type { Logger };
