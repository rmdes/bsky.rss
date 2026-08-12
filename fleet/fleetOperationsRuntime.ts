import type {BotOperations, BotOperationalSnapshot, BotCounters} from './botOperations.ts';
import type {BotWorker} from './botWorker.ts';
import {formatFleetIntervalSummary, subtractBotCounters, sumBotCounters} from './fleetSummary.ts';
import {LogOverrideWatcher} from './logOverrides.ts';
import {Logger, formatDebugError} from '../shared/logging/logger.ts';
import {writePrivateJsonAtomic} from './atomicJson.ts';
import {buildFleetStatusSnapshot, type FleetPhase} from './statusSnapshot.ts';
import type {SharedLimiters} from './sharedLimiters.ts';

const statusIntervalMs = 60_000;
const overrideIntervalMs = 5_000;
const summaryIntervalMs = 300_000;

export interface FleetOperationsRuntimeTimers {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface FleetOperationsRuntimeOptions {
  timers: FleetOperationsRuntimeTimers;
  now: () => Date;
  memoryUsage: () => Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed'>;
  paths: {status: string; overrides: string};
  logger: Logger;
  operations: ReadonlyMap<string, BotOperations>;
  coordinator: {
    activeWorkers(): readonly BotWorker[];
    activationFailures(): readonly {botId: string}[];
  };
  configInvalidCount: number;
  sharedLimiters: SharedLimiters;
}

export class FleetOperationsRuntime {
  private phase: FleetPhase = 'starting';
  private startedAt: Date | null = null;
  private previousCounters: BotCounters | null = null;
  private timerHandles: unknown[] = [];
  private snapshotWriteWarningEmitted = false;
  private readonly overrideWatcher: LogOverrideWatcher;

  constructor(private readonly options: FleetOperationsRuntimeOptions) {
    this.overrideWatcher = new LogOverrideWatcher({
      path: options.paths.overrides,
      knownBotIds: new Set(options.operations.keys()),
      logger: options.logger,
      now: options.now,
    });
  }

  start(): void {
    if (this.timerHandles.length > 0) return;
    this.phase = 'starting';
    this.startedAt = this.options.now();
    this.writeSnapshot();
    this.previousCounters = sumBotCounters(this.operationalStates());
    this.pollOverrides();
    this.timerHandles = [
      this.options.timers.setInterval(() => this.writeSnapshot(), statusIntervalMs),
      this.options.timers.setInterval(() => this.pollOverrides(), overrideIntervalMs),
      this.options.timers.setInterval(() => this.writeIntervalSummary(), summaryIntervalMs),
    ];
  }

  markRunning(): void {
    this.phase = 'running';
    this.writeSnapshot();
  }

  markStopping(): void {
    this.phase = 'stopping';
    this.writeSnapshot();
  }

  stop(): void {
    for (const handle of this.timerHandles) this.options.timers.clearInterval(handle);
    this.timerHandles = [];
  }

  private writeSnapshot(): void {
    try {
      const activeWorkers = new Map(
        this.options.coordinator.activeWorkers().map(worker => [worker.botId, worker]),
      );
      const activationFailureIds = new Set(
        this.options.coordinator.activationFailures().map(failure => failure.botId),
      );
      const now = this.options.now();
      const snapshot = buildFleetStatusSnapshot({
        phase: this.phase,
        startedAt: this.startedAt ?? now,
        now,
        operations: this.options.operations,
        activeWorkers,
        activationFailureIds,
        configErrorCount: this.options.configInvalidCount,
        logger: this.options.logger,
        memoryUsage: this.options.memoryUsage(),
        sharedLimiters: this.options.sharedLimiters,
      });
      writePrivateJsonAtomic(this.options.paths.status, snapshot);
      this.snapshotWriteWarningEmitted = false;
    } catch (error) {
      if (!this.snapshotWriteWarningEmitted) {
        this.options.logger.summary(
          'STATUS',
          'Status snapshot write failed; fleet execution continues',
        );
        this.snapshotWriteWarningEmitted = true;
      }
      this.options.logger.debug('STATUS', formatDebugError(error));
    }
  }

  private pollOverrides(): void {
    try {
      this.overrideWatcher.poll();
    } catch (error) {
      this.options.logger.summary(
        'log-control',
        'Log override observation failed; fleet execution continues',
      );
      this.options.logger.debug('log-control', formatDebugError(error));
    }
  }

  private writeIntervalSummary(): void {
    try {
      const states = this.operationalStates();
      const current = sumBotCounters(states);
      const previous = this.previousCounters ?? current;
      const activeWorkers = this.options.coordinator.activeWorkers();
      const {ogQueue, imageQueue} = this.options.sharedLimiters.getQueueDepths();
      this.options.logger.summary(
        'FLEET',
        formatFleetIntervalSummary({
          delta: subtractBotCounters(current, previous),
          queueDepth: activeWorkers.reduce((total, worker) => total + worker.queueLength(), 0),
          feedsFailing: states.filter(state => state.feedState === 'failing').length,
          rssBytes: this.options.memoryUsage().rss,
          ogQueueDepth: ogQueue,
          imageQueueDepth: imageQueue,
        }),
      );
      this.previousCounters = current;
    } catch (error) {
      try {
        this.options.logger.summary('FLEET', 'Interval summary failed; fleet execution continues');
        this.options.logger.debug('FLEET', formatDebugError(error));
      } catch {
        // A failing log sink cannot be allowed to escape its timer callback.
      }
    }
  }

  private operationalStates(): BotOperationalSnapshot[] {
    return [...this.options.operations.values()].map(operations => operations.snapshot());
  }
}
