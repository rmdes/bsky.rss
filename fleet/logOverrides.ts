import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {writePrivateJsonAtomic} from './atomicJson.ts';
import {type LogOverride, Logger} from '../shared/logging/logger.ts';
import {hasErrorCode, isLogLevel, isRecord, isTimestamp} from './jsonGuards.ts';

export type LogOverrideDocument = Record<string, LogOverride>;

class InvalidLogOverrideDocumentError extends Error {}

const durationFactors = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
} as const;

export function overridesPath(dataRoot: string): string {
  return join(dataRoot, 'log-overrides.json');
}

export function parseDuration(value: string): number {
  const match = /^(\d+)([smh])$/.exec(value);
  if (!match) throw new Error('Expected a positive duration using s, m, or h');
  const amount = Number(match[1]);
  const factor = durationFactors[match[2] as keyof typeof durationFactors];
  const milliseconds = amount * factor;
  if (amount <= 0 || !Number.isSafeInteger(milliseconds)) {
    throw new Error('Expected a positive duration using s, m, or h');
  }
  return milliseconds;
}

export function readValidOverrides(
  path: string,
  knownBotIds: ReadonlySet<string>,
  now: Date,
): ReadonlyMap<string, LogOverride> {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return new Map();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new InvalidLogOverrideDocumentError(
      `Invalid log override document at ${path}: malformed JSON`,
    );
  }
  if (!isRecord(parsed)) {
    throw new InvalidLogOverrideDocumentError(
      `Invalid log override document at ${path}: expected an object`,
    );
  }

  const validated = new Map<string, LogOverride>();
  for (const [botId, value] of Object.entries(parsed)) {
    if (!isRecord(value) || !isLogLevel(value.level) || !isTimestamp(value.expiresAt)) {
      throw new InvalidLogOverrideDocumentError(
        `Invalid log override document at ${path}: invalid entry for ${botId}`,
      );
    }
    validated.set(botId, {level: value.level, expiresAt: value.expiresAt});
  }

  const overrides = new Map<string, LogOverride>();
  for (const [botId, override] of validated) {
    if (new Date(override.expiresAt).getTime() <= now.getTime()) continue;
    if (!knownBotIds.has(botId)) {
      throw new InvalidLogOverrideDocumentError(
        `Invalid log override document at ${path}: unknown bot ${botId}`,
      );
    }
    overrides.set(botId, override);
  }
  return overrides;
}

export function writeOverrides(path: string, overrides: ReadonlyMap<string, LogOverride>): void {
  writePrivateJsonAtomic(path, Object.fromEntries(overrides));
}

export class LogOverrideWatcher {
  private activeOverrides = new Map<string, LogOverride>();
  private malformedWarningEmitted = false;
  private readonly now: () => Date;

  constructor(
    private readonly options: {
      path: string;
      knownBotIds: ReadonlySet<string>;
      logger: Logger;
      now?: () => Date;
    },
  ) {
    this.now = options.now ?? (() => new Date());
  }

  poll(): void {
    const now = this.now();
    this.expireRetainedOverrides(now);

    let nextOverrides: ReadonlyMap<string, LogOverride>;
    try {
      nextOverrides = readValidOverrides(this.options.path, this.options.knownBotIds, now);
      this.malformedWarningEmitted = false;
    } catch (error) {
      if (!(error instanceof InvalidLogOverrideDocumentError)) throw error;
      if (!this.malformedWarningEmitted) {
        this.options.logger.summary(
          'log-control',
          'Malformed log override document ignored; retaining the last valid overrides',
        );
        this.malformedWarningEmitted = true;
      }
      return;
    }

    const removedBotIds = [...this.activeOverrides.keys()].filter(
      botId => !nextOverrides.has(botId),
    );
    const changedOverrides = [...nextOverrides].filter(
      ([botId, override]) => !sameOverride(this.activeOverrides.get(botId), override),
    );
    const debugActivations = new Set(
      changedOverrides
        .filter(
          ([botId, override]) =>
            override.level === 'debug' && this.activeOverrides.get(botId)?.level !== 'debug',
        )
        .map(([botId]) => botId),
    );
    if (removedBotIds.length === 0 && changedOverrides.length === 0) return;

    this.activeOverrides = cloneOverrides(nextOverrides);
    this.options.logger.replaceOverrides(this.activeOverrides);

    for (const botId of removedBotIds) {
      this.options.logger.summary(
        'log-control',
        'Log override cleared; returned to the global level',
        botId,
      );
    }
    for (const [botId, override] of changedOverrides) {
      this.options.logger.summary(
        'log-control',
        `Log override set to ${override.level} until ${override.expiresAt}`,
        botId,
      );
      if (debugActivations.has(botId)) {
        this.options.logger.summary(
          'log-control',
          'Debug logging may contain private feed URLs, titles, and post text',
          botId,
        );
      }
    }
  }

  private expireRetainedOverrides(now: Date): void {
    const expiredBotIds = [...this.activeOverrides]
      .filter(([, override]) => new Date(override.expiresAt).getTime() <= now.getTime())
      .map(([botId]) => botId);
    if (expiredBotIds.length === 0) return;

    for (const botId of expiredBotIds) this.activeOverrides.delete(botId);
    this.options.logger.replaceOverrides(this.activeOverrides);
    for (const botId of expiredBotIds) {
      this.options.logger.summary(
        'log-control',
        'Log override expired; returned to the global level',
        botId,
      );
    }
  }
}

function cloneOverrides(overrides: ReadonlyMap<string, LogOverride>): Map<string, LogOverride> {
  return new Map(
    [...overrides].map(([botId, override]) => [
      botId,
      {level: override.level, expiresAt: override.expiresAt},
    ]),
  );
}

function sameOverride(current: LogOverride | undefined, next: LogOverride): boolean {
  return current?.level === next.level && current.expiresAt === next.expiresAt;
}
