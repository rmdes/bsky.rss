import "dotenv/config";
import { BotStore } from "./botStore.ts";
import { Scheduler } from "./scheduler.ts";
import { BskyClient } from "./bskyClient.ts";
import { FeedReader } from "./feedReader.ts";
import { BotWorker } from "./botWorker.ts";
import { SharedLimiters } from "./sharedLimiters.ts";
import type { BotWorkerConfig } from "./types.ts";

function loadBotConfig(prefix: string): BotWorkerConfig {
  const env = (name: string): string => {
    const value = process.env[`${prefix}_${name}`];
    if (!value) throw new Error(`Missing env var ${prefix}_${name}`);
    return value;
  };
  return {
    botId: env("IDENTIFIER"),
    identifier: env("IDENTIFIER"),
    appPassword: env("APP_PASSWORD"),
    instanceUrl: env("INSTANCE_URL"),
    feedUrl: env("FETCH_URL"),
    fetchIntervalMinutes: 5,
    dbPath: `./data/fleet-phase1-${prefix.toLowerCase()}.sqlite`,
    postString: "$title - $link",
    publishEmbed: true,
    embedType: "card",
    languages: ["en"],
    truncate: true,
    runIntervalSeconds: 60,
    removeDuplicate: true,
    titleClearHTML: true,
    descriptionClearHTML: true,
  };
}

async function buildWorker(config: BotWorkerConfig): Promise<BotWorker> {
  const store = new BotStore(config.dbPath);
  const scheduler = new Scheduler({
    minSpacing: 1,
    maxSpacing: 60,
    spacingWindow: 600,
    adaptiveSpacing: true,
  });
  // Dry-run is the default so this never publishes for real until you opt in
  // with DRY_RUN=false in the environment.
  const bskyClient = new BskyClient(config.botId, config.instanceUrl, store, process.env.DRY_RUN !== "false");
  await bskyClient.login(config.identifier, config.appPassword);

  const sharedLimiters = new SharedLimiters({
    maxConcurrentOpenGraphFetches: 6,
    maxConcurrentImageJobs: 2,
    maxImageDownloadBytes: 10_000_000,
    httpTimeoutMs: 10_000,
  });

  const feedReader = new FeedReader(
    config.botId,
    new URL(config.feedUrl),
    config.fetchIntervalMinutes,
    {
      string: config.postString,
      publishEmbed: config.publishEmbed,
      embedType: config.embedType,
      languages: config.languages,
      truncate: config.truncate,
      removeDuplicate: config.removeDuplicate,
      titleClearHTML: config.titleClearHTML,
      descriptionClearHTML: config.descriptionClearHTML,
    },
    store,
    sharedLimiters
  );

  return new BotWorker({
    botId: config.botId,
    feedReader,
    scheduler,
    bskyClient,
    store,
    runIntervalSeconds: config.runIntervalSeconds,
    freshnessConfig: { maxCatchupItems: 5, maxItemAgeMinutes: 120 },
    perBotQueueMaxLength: 500,
  });
}

// Runs in dry-run mode by default (no real posts); set DRY_RUN=false to actually publish.
// Do not point BOT1_/BOT2_ env vars at a bot account whose existing single-bot container
// (the app/ entrypoint) is still running against the same account - both would post
// independently and you'd get duplicate posts.
async function main(): Promise<void> {
  const bot1Config = loadBotConfig("BOT1");
  const bot2Config = loadBotConfig("BOT2");

  console.log(`[${new Date().toUTCString()}] - [bsky.rss APP] Starting fleet-phase1 with 2 bots`);

  const worker1 = await buildWorker(bot1Config);
  await worker1.start();
  console.log(`[${new Date().toUTCString()}] - [bsky.rss APP] [${bot1Config.botId}] started`);

  const worker2 = await buildWorker(bot2Config);
  await worker2.start();
  console.log(`[${new Date().toUTCString()}] - [bsky.rss APP] [${bot2Config.botId}] started`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
