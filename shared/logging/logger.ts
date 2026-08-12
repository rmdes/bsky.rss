export type FleetLogLevel = 'summary' | 'verbose' | 'debug';

export interface FleetLogOverride {
  level: FleetLogLevel;
  expiresAt: string;
}

export interface FleetLogRecord {
  level: FleetLogLevel;
  scope: string;
  botId?: string;
  message: string;
}

const levelRanks: Record<FleetLogLevel, number> = {
  summary: 0,
  verbose: 1,
  debug: 2,
};

function isFleetLogLevel(value: unknown): value is FleetLogLevel {
  return value === 'summary' || value === 'verbose' || value === 'debug';
}

export function parseFleetLogLevel(value: string | undefined): FleetLogLevel {
  if (value === undefined) return 'summary';
  if (isFleetLogLevel(value)) return value;
  throw new Error(`Invalid fleet log level ${value}; expected one of: summary, verbose, debug`);
}

export function formatDebugError(error: unknown): string {
  if (!(error instanceof Error)) return redactDebugText(String(error));
  return [error.name, error.message, error.stack]
    .filter(Boolean)
    .map(value => redactDebugText(value as string))
    .join('\n');
}

function redactDebugText(value: string): string {
  const redacted = '[REDACTED]';
  const secretKey = [
    'app[_-]?password',
    'password',
    'token',
    'access(?:[_-]?(?:jwt|token))?',
    'refresh(?:[_-]?(?:jwt|token))?',
    'session(?:[_-]?(?:id|token))?',
    '(?:client[_-]?)?secret',
  ].join('|');
  const secretValue = new RegExp(
    `(\\b(?:${secretKey})\\b["']?\\s*[:=]\\s*)` +
      '(?:\\{[^}\\r\\n]*\\}|\\[[^\\]\\r\\n]*\\]|"[^"]*"|\'[^\']*\'|[^\\s,;&}\\]]+)',
    'gi',
  );

  return value
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, `$1${redacted}@`)
    .replace(/\b(authorization)\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,;]+/gi, `$1: ${redacted}`)
    .replace(/\b(bearer)\s+[a-z0-9._~+/=-]+/gi, `$1 ${redacted}`)
    .replace(secretValue, `$1${redacted}`);
}

export class FleetLogger {
  private overrides = new Map<string, FleetLogOverride>();
  private readonly now: () => Date;
  private readonly sink: (line: string, record: FleetLogRecord) => void;

  constructor(
    private readonly options: {
      defaultLevel: FleetLogLevel;
      now?: () => Date;
      sink?: (line: string, record: FleetLogRecord) => void;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.sink = options.sink ?? (line => console.log(line));
  }

  replaceOverrides(overrides: ReadonlyMap<string, FleetLogOverride>): void {
    const validated = new Map<string, FleetLogOverride>();
    for (const [botId, override] of overrides) {
      if (!isFleetLogLevel(override.level)) {
        throw new Error(
          `Invalid fleet log level ${String(override.level)}; expected one of: summary, verbose, debug`,
        );
      }
      if (Number.isNaN(new Date(override.expiresAt).getTime())) {
        throw new Error(`Invalid fleet log override expiry for ${botId}`);
      }
      validated.set(botId, {level: override.level, expiresAt: override.expiresAt});
    }
    this.overrides = validated;
  }

  effectiveLevel(botId?: string): FleetLogLevel {
    return botId === undefined
      ? this.options.defaultLevel
      : (this.overrideFor(botId)?.level ?? this.options.defaultLevel);
  }

  overrideFor(botId: string): FleetLogOverride | undefined {
    const override = this.overrides.get(botId);
    if (!override || new Date(override.expiresAt).getTime() <= this.now().getTime())
      return undefined;
    return override;
  }

  summary(scope: string, message: string, botId?: string): void {
    this.emit('summary', scope, message, botId);
  }

  verbose(scope: string, message: string, botId?: string): void {
    this.emit('verbose', scope, message, botId);
  }

  debug(scope: string, message: string, botId?: string): void {
    this.emit('debug', scope, message, botId);
  }

  private emit(level: FleetLogLevel, scope: string, message: string, botId?: string): void {
    if (levelRanks[level] > levelRanks[this.effectiveLevel(botId)]) return;
    const record: FleetLogRecord = {
      level,
      scope,
      ...(botId === undefined ? {} : {botId}),
      message,
    };
    const botPrefix = botId === undefined ? '' : ` [${botId}]`;
    this.sink(`[${this.now().toUTCString()}] - [bsky.rss ${scope}]${botPrefix} ${message}`, record);
  }
}
