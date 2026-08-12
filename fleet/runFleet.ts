// fleet/runFleet.ts
import 'dotenv/config';
import {join} from 'node:path';
import {BotStore} from './botStore.ts';
import {Scheduler} from './scheduler.ts';
import {BskyClient} from './bskyClient.ts';
import {FeedReader} from './feedReader.ts';
import {BotWorker} from './botWorker.ts';
import {SharedLimiters} from './sharedLimiters.ts';
import {installProcessSafetyNet} from './processSafety.ts';
import {loadFleet} from './configLoader.ts';
import {AuthCoordinator} from './authCoordinator.ts';
import {acquireLock, releaseLock} from './pidLock.ts';
import {BotOperations} from './botOperations.ts';
import {FleetOperationsRuntime} from './fleetOperationsRuntime.ts';
import {FleetLogger, formatDebugError, parseFleetLogLevel} from '../shared/logging/logger.ts';
import {overridesPath} from './logOverrides.ts';
import {statusPath} from './status.ts';
import health from '../app/utils/healthHandler.ts';
import type {FreshnessConfig} from './freshnessPolicy.ts';
import type {BotSpec} from './configLoader.ts';

async function buildWorker(
  spec: BotSpec,
  sharedLimiters: SharedLimiters,
  operations: BotOperations,
  logger: FleetLogger,
  dryRun: boolean,
  runIntervalSeconds: number,
  freshnessConfig: FreshnessConfig,
  perBotQueueMaxLength: number,
  identityStore: BotStore,
): Promise<BotWorker> {
  const store = new BotStore(spec.dbPath);
  try {
    const bskyClient = new BskyClient(spec.botId, spec.instanceUrl, store, logger, dryRun);
    await bskyClient.login(spec.identifier, spec.appPassword);

    const feedReader = new FeedReader(
      spec.botId,
      spec.identifier,
      new URL(spec.feedUrl),
      spec.fetchIntervalMinutes,
      spec.feedReaderConfig,
      store,
      identityStore,
      sharedLimiters,
      {operations, logger},
    );

    const worker = new BotWorker({
      botId: spec.botId,
      feedReader,
      scheduler: new Scheduler(spec.schedulerConfig),
      bskyClient,
      store,
      identityStore,
      runIntervalSeconds,
      freshnessConfig,
      perBotQueueMaxLength,
      operations,
      logger,
    });
    await worker.start();
    return worker;
  } catch (err) {
    store.close();
    throw err;
  }
}

// Runs in dry-run mode by default (no real posts); set DRY_RUN=false to actually publish.
// Point FLEET_CONFIG_ROOT/FLEET_SECRETS_PATH/FLEET_DATA_ROOT at a real config tree
// (see config.example/ for the shape) before running against real bot accounts.
let startupLogger = new FleetLogger({defaultLevel: 'summary'});

export function reportFleetStarted(
  logger: FleetLogger,
  counts: {active: number; failed: number},
  shuttingDown: boolean,
): void {
  if (shuttingDown) return;
  logger.summary('FLEET', `Fleet started: ${counts.active} active, ${counts.failed} failed`);
}

async function main(): Promise<void> {
  const logLevel = parseFleetLogLevel(process.env.FLEET_LOG_LEVEL);
  const logger = new FleetLogger({defaultLevel: logLevel});
  startupLogger = logger;
  installProcessSafetyNet(logger);
  health.start();
  if (logLevel === 'debug') {
    logger.summary('FLEET', 'Debug logging may contain private feed URLs, titles, and post text');
  }

  const configRoot = process.env.FLEET_CONFIG_ROOT ?? './config.example';
  const secretsFilePath =
    process.env.FLEET_SECRETS_PATH ?? './config.example/secrets/bsky-fleet.json';
  const dataRoot = process.env.FLEET_DATA_ROOT ?? './data/fleet';
  const dryRun = process.env.DRY_RUN !== 'false';
  const lockFilePath = process.env.FLEET_LOCK_PATH ?? './data/fleet/fleet.pid';
  const shutdownPerBotTimeoutMs = Number(process.env.FLEET_SHUTDOWN_PER_BOT_TIMEOUT_MS ?? '10000');
  const shutdownOverallTimeoutMs = Number(process.env.FLEET_SHUTDOWN_OVERALL_TIMEOUT_MS ?? '30000');

  acquireLock(lockFilePath);
  process.on('exit', () => releaseLock(lockFilePath));

  const {fleetConfig, bots, errors} = loadFleet(configRoot, secretsFilePath, dataRoot);

  logger.summary('FLEET', `Loaded ${bots.length} bot(s), ${errors.length} config error(s)`);
  for (const error of errors) {
    logger.summary('CONFIG', 'Config invalid', error.botId);
    logger.debug('CONFIG', formatDebugError(error.error), error.botId);
  }

  const identityStores = new Map<string, BotStore>();
  function getIdentityStore(identifier: string): BotStore {
    let store = identityStores.get(identifier);
    if (!store) {
      store = new BotStore(join(dataRoot, 'identities', `${identifier}.sqlite`));
      identityStores.set(identifier, store);
    }
    return store;
  }

  const sharedLimiters = new SharedLimiters(fleetConfig.sharedLimiters);
  const operations = new Map(bots.map(spec => [spec.botId, new BotOperations(spec.botId)]));

  const coordinator = new AuthCoordinator({
    logger,
    bots,
    staggerSeconds: fleetConfig.staggerSeconds,
    activateBot: spec => {
      const botOperations = operations.get(spec.botId);
      if (!botOperations) throw new Error(`Missing operational state for ${spec.botId}`);
      return buildWorker(
        spec,
        sharedLimiters,
        botOperations,
        logger,
        dryRun,
        fleetConfig.runIntervalSeconds,
        fleetConfig.freshness,
        fleetConfig.perBotQueueMaxLength,
        getIdentityStore(spec.identifier),
      );
    },
  });
  const operationsRuntime = new FleetOperationsRuntime({
    timers: {
      setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
      clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
    },
    now: () => new Date(),
    memoryUsage: () => process.memoryUsage(),
    paths: {status: statusPath(dataRoot), overrides: overridesPath(dataRoot)},
    logger,
    operations,
    coordinator,
    configInvalidCount: errors.length,
  });

  const healthHeartbeatIntervalMs = 60_000;
  const healthHeartbeatHandle = setInterval(
    () => health.updateActivity(),
    healthHeartbeatIntervalMs,
  );

  // Coordinated cleanup of shared identity stores to prevent race conditions when
  // multiple bots share the same Bluesky identity. Each identity store is cleaned
  // once per hour by this single fleet-wide interval, not once per bot per drain
  // tick (which caused SQLite contention on shared databases).
  const identityCleanupIntervalMs = 3600_000; // 1 hour
  const identityCleanupHandle = setInterval(() => {
    for (const identityStore of identityStores.values()) {
      identityStore.cleanupOldSeenValues(96);
    }
  }, identityCleanupIntervalMs);

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.summary('FLEET', `Received ${signal}, shutting down gracefully`);
    clearInterval(healthHeartbeatHandle);
    clearInterval(identityCleanupHandle);
    coordinator.abortActivation();
    operationsRuntime.markStopping();
    operationsRuntime.stop();
    await Promise.race([
      coordinator.shutdownAll(shutdownPerBotTimeoutMs),
      new Promise(resolve => setTimeout(resolve, shutdownOverallTimeoutMs)),
    ]);
    for (const identityStore of identityStores.values()) identityStore.close();
    releaseLock(lockFilePath);
    logger.summary('FLEET', 'Shutdown complete');
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  operationsRuntime.start();
  await coordinator.start();
  if (!shuttingDown) {
    operationsRuntime.markRunning();
    health.markReady();
  }

  reportFleetStarted(
    logger,
    {
      active: coordinator.activeWorkers().length,
      failed: coordinator.activationFailures().length,
    },
    shuttingDown,
  );

  // A SIGTERM arriving before any bot has activated resolves coordinator.start()
  // (via abortActivation's interrupted stagger wait) at nearly the same moment
  // shutdown() is already tearing things down - defer to shutdown()'s own exit
  // path rather than racing it with a second, contradictory process.exit() call.
  if (!shuttingDown && coordinator.activeWorkers().length === 0 && bots.length > 0) {
    logger.summary('FLEET', 'No bots activated - exiting non-zero');
    releaseLock(lockFilePath);
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch(error => {
    startupLogger.summary('FATAL', 'Fleet startup failed');
    startupLogger.debug('FATAL', formatDebugError(error));
    process.exit(1);
  });
}
