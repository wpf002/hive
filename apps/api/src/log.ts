import type { LoggerOptions } from 'pino';
import { env } from './env.js';

export const loggerOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: { service: 'api' },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }
    : {}),
};
