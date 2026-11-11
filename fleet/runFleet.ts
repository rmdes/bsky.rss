// fleet/runFleet.ts
import 'dotenv/config';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {BotStore} from './botStore.ts';
import {Scheduler} from './scheduler.ts';
import {BskyClient} from './bskyClient.ts';
import {FeedReader} from './feedReader.ts';
import {BotWorker} from './botWorker.ts';
import {SharedLimiters} from './sharedLimiters.ts';
import {installProcessSafetyNet} from './processSafety.ts';
import {loadFleet, loadOneBot} from './configLoader.ts';
import {fingerprintBot, listBotIds, type BotFingerprint} from './botFingerprint.ts';
import {ConfigReconciler, type RunningBotConfig} from './configReconciler.ts';
import {createBotLifecycle} from './botLifecycle.ts';
import {NotifierClaims} from './notifierClaims.ts';
import {reloadRequestsPath, takeReloadRequests} from './reloadRequests.ts';
import {AuthCoordinator} from './authCoordinator.ts';
import {acquireLock, releaseLock} from './pidLock.ts';
import {BotOperations} from './botOperations.ts';
import {FleetOperationsRuntime} from './fleetOperationsRuntime.ts';
import {Logger, formatDebugError, parseLogLevel} from '../shared/logging/logger.ts';
import {overridesPath} from './logOverrides.ts';
import {statusPath} from './status.ts';
import health from '../app/utils/healthHandler.ts';
import type {FreshnessConfig} from './freshnessPolicy.ts';
import type {BotSpec} from './configLoader.ts';

async function buildWorker(
  spec: BotSpec,
  sharedLimiters: SharedLimiters,
  operations: BotOperations,
  logger: Logger,
  dryRun: boolean,
  runIntervalSeconds: number,
  freshnessConfig: FreshnessConfig,
  perBotQueueMaxLength: number,
  identityStore: BotStore,
  ntfyUrl: string | undefined,
  ntfyToken: string | undefined,
  holdsNotifier: () => boolean,
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
      runIntervalSeconds,
      freshnessConfig,
      perBotQueueMaxLength,
      operations,
      logger,
      ntfyUrl,
      ntfyToken,
      holdsNotifier,
      accountStore: identityStore,
      botHandle: spec.identifier,
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
let startupLogger = new Logger({defaultLevel: 'summary'});

export function reportFleetStarted(
  logger: Logger,
  counts: {active: number; failed: number},
  shuttingDown: boolean,
): void {
  if (shuttingDown) return;
  logger.summary('FLEET', `Fleet started: ${counts.active} active, ${counts.failed} failed`);
}

async function main(): Promise<void> {
  const logLevel = parseLogLevel(process.env.FLEET_LOG_LEVEL);
  const logger = new Logger({defaultLevel: logLevel});
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
  const ntfyUrl = process.env.NTFY_URL;
  const ntfyToken = process.env.NTFY_TOKEN;

  acquireLock(lockFilePath);
  process.on('exit', () => releaseLock(lockFilePath));

  const {fleetConfig, bots, errors} = loadFleet(configRoot, secretsFilePath, dataRoot);

  logger.summary('FLEET', `Loaded ${bots.length} bot(s), ${errors.length} config error(s)`);
  for (const error of errors) {
    logger.summary('CONFIG', 'Config invalid', error.botId);
    logger.debug('CONFIG', formatDebugError(error.error), error.botId);
  }

  const readSecrets = (): Record<string, string> =>
    JSON.parse(readFileSync(secretsFilePath, 'utf-8')) as Record<string, string>;
  const startupFingerprints = new Map<string, BotFingerprint>();
  try {
    const startupSecrets = readSecrets();
    for (const botId of listBotIds(configRoot)) {
      startupFingerprints.set(botId, fingerprintBot(configRoot, startupSecrets, botId));
    }
  } catch {
    // loadFleet already succeeded with these files; a race here only means a bot may be reloaded once.
  }

  if (!ntfyUrl) {
    logger.summary('FLEET', 'NTFY_URL not set - reply/mention/quote notifications disabled');
  }

  const claims = new NotifierClaims();

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
    activateBot: spec => lifecycle.build(spec),
  });
  const lifecycle = createBotLifecycle({
    coordinator,
    operations,
    claims,
    // Every worker gets ntfyUrl; the claim, asked on each check, decides which one uses it.
    buildWorker: spec =>
      buildWorker(
        spec,
        sharedLimiters,
        operations.get(spec.botId)!,
        logger,
        dryRun,
        fleetConfig.runIntervalSeconds,
        fleetConfig.freshness,
        fleetConfig.perBotQueueMaxLength,
        getIdentityStore(spec.identifier),
        ntfyUrl,
        ntfyToken,
        () => claims.claim(spec.botId, spec.identifier),
      ),
    shutdownTimeoutMs: shutdownPerBotTimeoutMs,
    logger,
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
    sharedLimiters,
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
  let reconciler: ConfigReconciler<BotSpec> | undefined;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.summary('FLEET', `Received ${signal}, shutting down gracefully`);
    // try/finally: a failing step must never keep the process alive until Docker's SIGKILL.
    try {
      clearInterval(healthHeartbeatHandle);
      clearInterval(identityCleanupHandle);
      coordinator.abortActivation();
      await Promise.race([
        reconciler?.stop(),
        new Promise(resolve => setTimeout(resolve, shutdownOverallTimeoutMs)),
      ]);
      operationsRuntime.markStopping();
      operationsRuntime.stop();
      await Promise.race([
        coordinator.shutdownAll(shutdownPerBotTimeoutMs),
        new Promise(resolve => setTimeout(resolve, shutdownOverallTimeoutMs)),
      ]);
    } catch (error) {
      logger.summary('FLEET', 'Shutdown step failed; exiting anyway');
      logger.debug('FLEET', formatDebugError(error));
    } finally {
      // Closed even when a worker failed to shut down; one bad store must not skip the rest.
      for (const identityStore of identityStores.values()) {
        try {
          identityStore.close();
        } catch (error) {
          logger.debug('FLEET', formatDebugError(error));
        }
      }
      releaseLock(lockFilePath);
      logger.summary('FLEET', 'Shutdown complete');
      process.exit(0);
    }
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  operationsRuntime.start();
  await coordinator.start();
  if (!shuttingDown) {
    operationsRuntime.markRunning();
    health.markReady();

    const active = new Set(coordinator.activeWorkers().map(worker => worker.botId));
    const running = new Map<string, RunningBotConfig<BotSpec>>();
    // Every active bot must be tracked, or the first tick would start a second worker for it.
    // With no usable startup fingerprint (read race), an empty hash forces one clean reload.
    for (const spec of bots) {
      if (!active.has(spec.botId)) continue;
      const fingerprint = startupFingerprints.get(spec.botId);
      running.set(
        spec.botId,
        fingerprint?.ok
          ? {hash: fingerprint.hash, fields: fingerprint.fields, spec}
          : {hash: '', fields: {}, spec},
      );
    }
    // Bots that failed activation or had invalid config: not retried until their config changes.
    const failed = new Map<string, string>();
    for (const [botId, fingerprint] of startupFingerprints) {
      if (fingerprint.ok && fingerprint.enabled && !active.has(botId))
        failed.set(botId, fingerprint.hash);
    }
    reconciler = new ConfigReconciler<BotSpec>(
      {
        readSecrets,
        listBotIds: () => listBotIds(configRoot),
        fingerprint: (secrets, botId) => fingerprintBot(configRoot, secrets, botId),
        loadSpec: (secrets, botId) => loadOneBot(configRoot, dataRoot, secrets, botId),
        takeReloadRequests: () => takeReloadRequests(reloadRequestsPath(dataRoot)),
        startBot: spec => lifecycle.startBot(spec),
        stopBot: (botId, reason) => lifecycle.stopBot(botId, reason),
        recordOutcome: (botId, outcome) => operations.get(botId)?.recordConfigOutcome(outcome),
        logger,
      },
      running,
      failed,
    );
    reconciler.start();
    logger.summary('FLEET', 'Config reload active: bot config changes apply within ~10s');
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
