import {basename} from 'node:path';
import type {FleetLogLevel, FleetLogOverride} from '../shared/logging/logger.ts';
import {overridesPath, parseDuration, readValidOverrides, writeOverrides} from './logOverrides.ts';
import {readFleetStatus, statusPath} from './status.ts';

const usage = (executable: string): string =>
  [
    `Usage: ${executable} set <bot-id> summary|verbose|debug --for <positive duration>`,
    `       ${executable} list`,
    `       ${executable} clear <bot-id>`,
  ].join('\n');

export function runLogControl(
  args: string[],
  options: {dataRoot: string; now?: () => Date},
): string {
  const now = options.now?.() ?? new Date();
  const path = overridesPath(options.dataRoot);

  if (args.length === 1 && args[0] === 'list') {
    const knownBotIds = currentBotIds(options.dataRoot);
    return formatOverrides(readValidOverrides(path, knownBotIds, now), now);
  }

  if (args.length === 5 && args[0] === 'set' && args[3] === '--for') {
    const botId = args[1] as string;
    const level = parseLevel(args[2]);
    const duration = parseDuration(args[4] as string);
    const expiresAt = new Date(now.getTime() + duration);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new Error('Duration produces an invalid expiry timestamp');
    }
    const knownBotIds = currentBotIds(options.dataRoot);
    requireKnownBot(botId, knownBotIds);
    const overrides = new Map(readValidOverrides(path, knownBotIds, now));
    overrides.set(botId, {level, expiresAt: expiresAt.toISOString()});
    writeOverrides(path, overrides);
    return `Set ${botId} to ${level} until ${expiresAt.toISOString()}.`;
  }

  if (args.length === 2 && args[0] === 'clear') {
    const botId = args[1] as string;
    const knownBotIds = currentBotIds(options.dataRoot);
    requireKnownBot(botId, knownBotIds);
    const overrides = new Map(readValidOverrides(path, knownBotIds, now));
    overrides.delete(botId);
    writeOverrides(path, overrides);
    return `Cleared log override for ${botId}.`;
  }

  throw new Error(usage('logControl.ts'));
}

function currentBotIds(dataRoot: string): ReadonlySet<string> {
  return new Set(readFleetStatus(statusPath(dataRoot)).botStates.map(bot => bot.botId));
}

function requireKnownBot(botId: string, knownBotIds: ReadonlySet<string>): void {
  if (!knownBotIds.has(botId)) throw new Error(`Unknown bot ID: ${botId}`);
}

function parseLevel(value: string | undefined): FleetLogLevel {
  if (value === 'summary' || value === 'verbose' || value === 'debug') return value;
  throw new Error('Invalid log level; expected summary, verbose, or debug');
}

function formatOverrides(overrides: ReadonlyMap<string, FleetLogOverride>, now: Date): string {
  if (overrides.size === 0) return 'No active log overrides.';
  return [...overrides]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([botId, override]) => {
      const remaining = new Date(override.expiresAt).getTime() - now.getTime();
      return `${botId} · ${override.level} · expires ${override.expiresAt} · ${formatDuration(remaining)} remaining`;
    })
    .join('\n');
}

// Deliberately different from status.ts's formatDuration (that one shows elapsed age - uptime,
// heartbeat - capped at 2 units and rolled into days) - this one shows remaining time until a
// log override expires, always up to 3 units (h/m/s) and never rolled into days.
function formatDuration(milliseconds: number): string {
  let seconds = Math.ceil(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  seconds %= 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  return [
    hours > 0 ? `${hours}h` : '',
    minutes > 0 ? `${minutes}m` : '',
    seconds > 0 ? `${seconds}s` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function main(): void {
  try {
    const dataRoot = process.env.FLEET_DATA_ROOT ?? './data/fleet';
    console.log(runLogControl(process.argv.slice(2), {dataRoot}));
  } catch (error) {
    const executable = basename(process.argv[1] ?? 'logControl.ts');
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.replace(/^Usage: logControl\.ts/, `Usage: ${executable}`));
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
