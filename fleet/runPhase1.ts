import "dotenv/config";
import { BotStore } from "./botStore.ts";
import { Scheduler } from "./scheduler.ts";
import { BskyClient } from "./bskyClient.ts";
import { FeedReader } from "./feedReader.ts";
import { BotWorker } from "./botWorker.ts";
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
  const bskyClient = new BskyClient(config.instanceUrl, store);
  await bskyClient.login(config.identifier, config.appPassword);

  const feedReader = new FeedReader(
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
    store
  );

  return new BotWorker({
    botId: config.botId,
    feedReader,
    scheduler,
    bskyClient,
    store,
    runIntervalSeconds: config.runIntervalSeconds,
  });
}

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
