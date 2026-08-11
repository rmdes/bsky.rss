import pino from 'pino';

export interface LogContext {
  botId?: string;
  feedUrl?: string;
  itemId?: string;
  postUri?: string;
  identifier?: string;
  queueId?: string;
  queueSize?: number;
  error?: Error | unknown;
  [key: string]: unknown;
}

export function createLogger(mode: 'app' | 'fleet', level?: string) {
  const isDevelopment = process.env.NODE_ENV !== 'production';
  const logLevel = level ?? process.env.LOG_LEVEL ?? 'info';

  return pino({
    level: logLevel,
    transport: isDevelopment
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'UTC:yyyy-mm-dd HH:MM:ss.l o',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
    base: {
      mode,
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
