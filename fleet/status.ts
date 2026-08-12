import {readFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import type {FeedFailureCategory, FeedState} from './botOperations.ts';
import {counterNames} from './botOperations.ts';
import {hasErrorCode, isFleetLogLevel, isRecord, isTimestamp} from './jsonGuards.ts';
import type {
  ActivationState,
  FleetBotStatus,
  FleetPhase,
  FleetStatusSnapshot,
} from './statusSnapshot.ts';

const staleAfterMilliseconds = 150_000;
const numberFormatter = new Intl.NumberFormat('en-US');

export function statusPath(dataRoot: string): string {
  return join(dataRoot, 'status.json');
}

export function readFleetStatus(path: string): FleetStatusSnapshot {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      throw new Error(`Fleet status not found at ${path}`);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`Fleet status at ${path} contains malformed JSON`);
  }

  if (isRecord(parsed) && 'schemaVersion' in parsed && parsed.schemaVersion !== 1) {
    throw new Error(
      `Unsupported fleet status schemaVersion ${String(parsed.schemaVersion)}; expected 1`,
    );
  }
  if (!isFleetStatusSnapshot(parsed)) {
    throw new Error(`Fleet status at ${path} is a malformed snapshot`);
  }
  return parsed;
}

export function formatFleetStatus(
  snapshot: FleetStatusSnapshot,
  options: {showBots: boolean; now?: Date},
): string {
  const now = options.now ?? new Date();
  const heartbeatAge = elapsedMilliseconds(snapshot.heartbeatAt, now);
  const uptimeEnd =
    snapshot.phase === 'stopping' || heartbeatAge > staleAfterMilliseconds
      ? new Date(snapshot.heartbeatAt)
      : now;
  const uptime = formatDuration(elapsedMilliseconds(snapshot.startedAt, uptimeEnd));
  const heartbeat = formatDuration(heartbeatAge);
  const phase = phaseLabel(snapshot.phase, heartbeatAge);
  const lines = [`Fleet ${phase} ${uptime} · heartbeat ${heartbeat} ago`];

  const pending = Math.max(
    0,
    snapshot.bots.configured - snapshot.bots.active - snapshot.bots.activationFailed,
  );
  const botFacts = [`${formatInteger(snapshot.bots.active)} active`];
  if (snapshot.bots.feedsOk > 0) {
    botFacts.push(
      `${formatInteger(snapshot.bots.feedsOk)} feed${plural(snapshot.bots.feedsOk)} ok`,
    );
  }
  if (snapshot.bots.feedsFailing > 0) {
    botFacts.push(
      `${formatInteger(snapshot.bots.feedsFailing)} feed${plural(snapshot.bots.feedsFailing)} failing`,
    );
  }
  if (snapshot.bots.feedsStarting > 0) {
    botFacts.push(
      `${formatInteger(snapshot.bots.feedsStarting)} feed${plural(snapshot.bots.feedsStarting)} starting`,
    );
  }
  if (pending > 0) botFacts.push(`${formatInteger(pending)} activation pending`);
  if (snapshot.bots.activationFailed > 0) {
    botFacts.push(`${formatInteger(snapshot.bots.activationFailed)} activation failed`);
  }
  if (snapshot.bots.configInvalid > 0) {
    botFacts.push(`${formatInteger(snapshot.bots.configInvalid)} config invalid`);
  }
  lines.push(formatLine('Bots', botFacts.join(' · ')));

  const feedAttempts = snapshot.totals.feedPollSucceeded + snapshot.totals.feedPollFailed;
  lines.push(
    formatLine(
      'Feed polls',
      `${formatInteger(snapshot.totals.feedPollSucceeded)} / ${formatInteger(feedAttempts)} successful (${formatPercentage(snapshot.totals.feedPollSucceeded, feedAttempts)})`,
    ),
  );
  lines.push(
    formatLine(
      'OpenGraph',
      `${formatInteger(snapshot.totals.openGraphSucceeded)} / ${formatInteger(snapshot.totals.openGraphAttempted)} successful (${formatPercentage(snapshot.totals.openGraphSucceeded, snapshot.totals.openGraphAttempted)}) · ${formatInteger(snapshot.totals.openGraphFallback)} RSS fallbacks`,
    ),
  );
  const terminalOutcomes = snapshot.totals.postSucceeded + snapshot.totals.postUncertain;
  lines.push(
    formatLine(
      'Posts',
      `${formatInteger(snapshot.totals.postSucceeded)} / ${formatInteger(terminalOutcomes)} terminal outcomes successful (${formatPercentage(snapshot.totals.postSucceeded, terminalOutcomes)}) · ${formatInteger(snapshot.totals.postUncertain)} uncertain · ${formatInteger(snapshot.totals.postDeferred)} deferred · ${formatInteger(snapshot.totals.postException)} exceptions`,
    ),
  );
  lines.push(
    formatLine(
      'Queue',
      `${formatInteger(snapshot.totals.queueDepth)} waiting · ${formatInteger(snapshot.totals.policySkipped)} policy-skipped`,
    ),
  );
  lines.push(formatLine('Memory', `${formatMegabytes(snapshot.memory.rssBytes)} MB RSS`));
  lines.push(
    formatLine(
      'Limiters',
      `${formatInteger(snapshot.limiters.ogQueueDepth)} waiting for OG capacity · ${formatInteger(snapshot.limiters.imageQueueDepth)} waiting for image capacity`,
    ),
  );

  if (options.showBots) {
    lines.push('', 'Bot states');
    for (const bot of snapshot.botStates) lines.push(formatBotStatus(bot));
  }

  return lines.join('\n');
}

function formatBotStatus(bot: FleetBotStatus): string {
  const counters = counterNames.map(name => `${name}=${formatInteger(bot.counters[name])}`);
  return [
    `Bot ${bot.botId}`,
    `feed=${bot.feedState}`,
    `lastFeedSuccess=${bot.lastFeedSuccessAt ?? 'n/a'}`,
    `consecutiveFailures=${formatInteger(bot.consecutiveFeedFailures)}`,
    `failureCategory=${bot.lastFeedFailureCategory ?? 'n/a'}`,
    `lastPostSuccess=${bot.lastPostSuccessAt ?? 'n/a'}`,
    `queueDepth=${bot.queueDepth === null ? 'n/a' : formatInteger(bot.queueDepth)}`,
    ...counters,
    `effectiveLogLevel=${bot.effectiveLogLevel}`,
    `logOverrideExpiresAt=${bot.logOverrideExpiresAt ?? 'n/a'}`,
  ].join(' · ');
}

function phaseLabel(phase: FleetPhase, heartbeatAge: number): string {
  if (heartbeatAge > staleAfterMilliseconds) return `stale (last reported ${phase})`;
  return phase;
}

function formatLine(label: string, value: string): string {
  return `${label.padEnd(11)}${value}`;
}

function formatInteger(value: number): string {
  return numberFormatter.format(value);
}

function formatPercentage(numerator: number, denominator: number): string {
  if (denominator === 0) return 'n/a';
  return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

function formatMegabytes(bytes: number): string {
  return formatInteger(Math.round(bytes / (1024 * 1024)));
}

function elapsedMilliseconds(timestamp: string, now: Date): number {
  return Math.max(0, now.getTime() - new Date(timestamp).getTime());
}

// Deliberately different from logControl.ts's formatDuration (that one shows remaining time
// until a log override expires, unrounded to days) - this one shows elapsed age (uptime,
// heartbeat), capped at 2 units and rolled into days once the duration is long enough.
function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  if (days > 0) return [`${days}d`, hours > 0 ? `${hours}h` : ''].filter(Boolean).join(' ');
  if (hours > 0) return [`${hours}h`, minutes > 0 ? `${minutes}m` : ''].filter(Boolean).join(' ');
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

function plural(value: number): string {
  return value === 1 ? '' : 's';
}

function isFiniteNonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isFeedState(value: unknown): value is FeedState {
  return value === 'starting' || value === 'ok' || value === 'failing';
}

function isActivationState(value: unknown): value is ActivationState {
  return value === 'pending' || value === 'active' || value === 'failed';
}

function isFleetPhase(value: unknown): value is FleetPhase {
  return value === 'starting' || value === 'running' || value === 'stopping';
}

function isFeedFailureCategory(value: unknown): value is FeedFailureCategory | null {
  return (
    value === null ||
    value === 'timeout' ||
    value === 'dns' ||
    value === 'tls' ||
    value === 'connection' ||
    value === 'parse' ||
    value === 'other' ||
    (typeof value === 'string' && /^http-\d+$/.test(value))
  );
}

function hasNumericProperties(
  value: unknown,
  names: readonly string[],
): value is Record<string, number> {
  return isRecord(value) && names.every(name => isFiniteNonnegativeNumber(value[name]));
}

function isFleetBotStatus(value: unknown): value is FleetBotStatus {
  return (
    isRecord(value) &&
    typeof value.botId === 'string' &&
    isActivationState(value.activationState) &&
    isFeedState(value.feedState) &&
    isNullableTimestamp(value.lastFeedSuccessAt) &&
    isNullableTimestamp(value.lastFeedFailureAt) &&
    isFiniteNonnegativeNumber(value.consecutiveFeedFailures) &&
    isFeedFailureCategory(value.lastFeedFailureCategory) &&
    isNullableTimestamp(value.lastPostSuccessAt) &&
    hasNumericProperties(value.counters, counterNames) &&
    (value.queueDepth === null || isFiniteNonnegativeNumber(value.queueDepth)) &&
    isFleetLogLevel(value.effectiveLogLevel) &&
    isNullableTimestamp(value.logOverrideExpiresAt)
  );
}

function isFleetStatusSnapshot(value: unknown): value is FleetStatusSnapshot {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isFleetPhase(value.phase) ||
    !isTimestamp(value.startedAt) ||
    !isTimestamp(value.heartbeatAt) ||
    !hasNumericProperties(value.bots, [
      'configured',
      'active',
      'activationFailed',
      'configInvalid',
      'feedsStarting',
      'feedsOk',
      'feedsFailing',
    ]) ||
    !hasNumericProperties(value.totals, [...counterNames, 'queueDepth']) ||
    !hasNumericProperties(value.memory, ['rssBytes', 'heapUsedBytes']) ||
    !hasNumericProperties(value.limiters, ['ogQueueDepth', 'imageQueueDepth']) ||
    !Array.isArray(value.botStates)
  ) {
    return false;
  }
  return value.botStates.every(isFleetBotStatus);
}

function main(): void {
  const args = process.argv.slice(2);
  const usage = `Usage: ${basename(process.argv[1] ?? 'status.ts')} [--bots]`;
  if (args.length > 1 || (args.length === 1 && args[0] !== '--bots')) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }

  try {
    const dataRoot = process.env.FLEET_DATA_ROOT ?? './data/fleet';
    const snapshot = readFleetStatus(statusPath(dataRoot));
    console.log(formatFleetStatus(snapshot, {showBots: args[0] === '--bots'}));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
