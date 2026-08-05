import {
  emptyBotCounters,
  type BotCounters,
  type BotOperationalSnapshot,
  type BotOperations,
} from './botOperations.ts';
import type {BotWorker} from './botWorker.ts';
import type {FleetLogger, FleetLogLevel} from './logging.ts';

export type FleetPhase = 'starting' | 'running' | 'stopping';
export type ActivationState = 'pending' | 'active' | 'failed';

export interface FleetBotStatus extends BotOperationalSnapshot {
  activationState: ActivationState;
  queueDepth: number | null;
  effectiveLogLevel: FleetLogLevel;
  logOverrideExpiresAt: string | null;
}

export interface FleetStatusSnapshot {
  schemaVersion: 1;
  phase: FleetPhase;
  startedAt: string;
  heartbeatAt: string;
  bots: {
    configured: number;
    active: number;
    activationFailed: number;
    configInvalid: number;
    feedsStarting: number;
    feedsOk: number;
    feedsFailing: number;
  };
  totals: BotCounters & {queueDepth: number};
  memory: {rssBytes: number; heapUsedBytes: number};
  botStates: FleetBotStatus[];
}

export interface BuildFleetStatusSnapshotOptions {
  phase: FleetPhase;
  startedAt: Date;
  now: Date;
  operations: ReadonlyMap<string, BotOperations>;
  activeWorkers: ReadonlyMap<string, BotWorker>;
  activationFailureIds: ReadonlySet<string>;
  configErrorCount: number;
  logger: FleetLogger;
  memoryUsage: Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed'>;
}

const counterNames: readonly (keyof BotCounters)[] = [
  'feedPollSucceeded',
  'feedPollFailed',
  'openGraphAttempted',
  'openGraphSucceeded',
  'openGraphFallback',
  'queued',
  'policySkipped',
  'postSucceeded',
  'postUncertain',
  'postDeferred',
  'postException',
];

export function buildFleetStatusSnapshot(
  options: BuildFleetStatusSnapshotOptions,
): FleetStatusSnapshot {
  const totals = {...emptyBotCounters(), queueDepth: 0};
  const botStates: FleetBotStatus[] = [];

  for (const [botId, operations] of options.operations) {
    const operational = operations.snapshot();
    const worker = options.activeWorkers.get(botId);
    const activationState: ActivationState = worker
      ? 'active'
      : options.activationFailureIds.has(botId)
        ? 'failed'
        : 'pending';
    const queueDepth = worker ? worker.queueLength() : null;
    const override = options.logger.overrideFor(botId);

    for (const counterName of counterNames) {
      totals[counterName] += operational.counters[counterName];
    }
    if (queueDepth !== null) totals.queueDepth += queueDepth;

    botStates.push({
      ...operational,
      counters: {...operational.counters},
      activationState,
      queueDepth,
      effectiveLogLevel: options.logger.effectiveLevel(botId),
      logOverrideExpiresAt: override?.expiresAt ?? null,
    });
  }

  botStates.sort((left, right) =>
    left.botId < right.botId ? -1 : left.botId > right.botId ? 1 : 0,
  );

  return {
    schemaVersion: 1,
    phase: options.phase,
    startedAt: options.startedAt.toISOString(),
    heartbeatAt: options.now.toISOString(),
    bots: {
      configured: botStates.length,
      active: botStates.filter(state => state.activationState === 'active').length,
      activationFailed: botStates.filter(state => state.activationState === 'failed').length,
      configInvalid: options.configErrorCount,
      feedsStarting: botStates.filter(state => state.feedState === 'starting').length,
      feedsOk: botStates.filter(state => state.feedState === 'ok').length,
      feedsFailing: botStates.filter(state => state.feedState === 'failing').length,
    },
    totals,
    memory: {
      rssBytes: options.memoryUsage.rss,
      heapUsedBytes: options.memoryUsage.heapUsed,
    },
    botStates,
  };
}
