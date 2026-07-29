// fleet/runFleet.ts
import "dotenv/config";
import { BotStore } from "./botStore.ts";
import { Scheduler } from "./scheduler.ts";
import { BskyClient } from "./bskyClient.ts";
import { FeedReader } from "./feedReader.ts";
import { BotWorker } from "./botWorker.ts";
import { SharedLimiters } from "./sharedLimiters.ts";
import { installProcessSafetyNet } from "./processSafety.ts";
import { loadFleet } from "./configLoader.ts";
import { AuthCoordinator } from "./authCoordinator.ts";
import type { FreshnessConfig } from "./freshnessPolicy.ts";
import type { BotSpec } from "./configLoader.ts";

function log(message: string): void {
  console.log(`[${new Date().toUTCString()}] - [bsky.rss APP] ${message}`);
}

async function buildWorker(
  spec: BotSpec,
  sharedLimiters: SharedLimiters,
  dryRun: boolean,
  runIntervalSeconds: number,
  freshnessConfig: FreshnessConfig,
  perBotQueueMaxLength: number
): Promise<BotWorker> {
  const store = new BotStore(spec.dbPath);
  const bskyClient = new BskyClient(spec.botId, spec.instanceUrl, store, dryRun);
  await bskyClient.login(spec.identifier, spec.appPassword);

  const feedReader = new FeedReader(
    spec.botId,
    new URL(spec.feedUrl),
    spec.fetchIntervalMinutes,
    spec.feedReaderConfig,
    store,
    sharedLimiters
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
  });
  await worker.start();
  return worker;
}

// Runs in dry-run mode by default (no real posts); set DRY_RUN=false to actually publish.
// Point FLEET_CONFIG_ROOT/FLEET_SECRETS_PATH/FLEET_DATA_ROOT at a real config tree
// (see config.example/ for the shape) before running against real bot accounts.
async function main(): Promise<void> {
  installProcessSafetyNet();

  const configRoot = process.env.FLEET_CONFIG_ROOT ?? "./config.example";
  const secretsFilePath = process.env.FLEET_SECRETS_PATH ?? "./config.example/secrets/bsky-fleet.json";
  const dataRoot = process.env.FLEET_DATA_ROOT ?? "./data/fleet";
  const dryRun = process.env.DRY_RUN !== "false";

  const { fleetConfig, bots, errors } = loadFleet(configRoot, secretsFilePath, dataRoot);

  log(`Loaded ${bots.length} bot(s), ${errors.length} config error(s)`);
  for (const e of errors) log(`[${e.botId}] Config error: ${e.error}`);

  const sharedLimiters = new SharedLimiters(fleetConfig.sharedLimiters);

  const coordinator = new AuthCoordinator({
    bots,
    staggerSeconds: fleetConfig.staggerSeconds,
    activateBot: (spec) =>
      buildWorker(
        spec,
        sharedLimiters,
        dryRun,
        fleetConfig.runIntervalSeconds,
        fleetConfig.freshness,
        fleetConfig.perBotQueueMaxLength
      ),
  });

  await coordinator.start();

  log(
    `Fleet started: ${coordinator.activeWorkers().length} active, ${coordinator.activationFailures().length} failed`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
