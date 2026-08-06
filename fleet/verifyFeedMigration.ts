import 'dotenv/config';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import axios from 'axios';
import FeedSub from 'feedsub';
import {parseRawFeed} from '../shared/feedSource/parse.ts';
import {normalizeFeed} from '../shared/feedSource/normalize.ts';

interface BotConfig {
  feedUrl: string;
  imageField?: string;
}

function loadBotConfigs(configRoot: string): Map<string, BotConfig> {
  const botsDir = join(configRoot, 'bots');
  const configs = new Map<string, BotConfig>();
  for (const botId of readdirSync(botsDir)) {
    const botJsonPath = join(botsDir, botId, 'bot.json');
    const configJsonPath = join(botsDir, botId, 'config.json');
    try {
      const bot = JSON.parse(readFileSync(botJsonPath, 'utf-8')) as {feedUrl: string};
      const config = JSON.parse(readFileSync(configJsonPath, 'utf-8')) as {imageField?: string};
      configs.set(botId, {feedUrl: bot.feedUrl, imageField: config.imageField});
    } catch (error) {
      console.log(`Skipping ${botId}: could not read config (${String(error)})`);
    }
  }
  return configs;
}

// FeedSub has no way to hand it an already-fetched body - .read(callback) always does
// its own internal fetch (via miniget) against the URL passed to its constructor, and
// with emitOnStart:true a fresh (no-history) instance's first read treats every item
// as new. This exercises feedsub's real end-to-end fetch+parse behavior, the same as
// what runs in production today - confirmed against the installed feedsub source
// (node_modules/feedsub/dist/feedsub.js), not guessed.
function parseWithFeedsub(feedUrl: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const sub = new FeedSub(feedUrl, {interval: 60, emitOnStart: true});
    sub.read((err: Error | null, items?: Array<Record<string, unknown>>) => {
      if (err) reject(err);
      else resolve(items || []);
    });
  });
}

function textOf(v: unknown): string | undefined {
  const text = v && typeof v === 'object' ? (v as {text?: string}).text : (v as string | undefined);
  return text || undefined;
}

async function compareBot(botId: string, config: BotConfig): Promise<void> {
  console.log(`\n=== ${botId} (${config.feedUrl}) ===`);

  let oldItems: Array<Record<string, unknown>>;
  try {
    oldItems = await parseWithFeedsub(config.feedUrl);
  } catch (error) {
    console.log(`  OLD PARSER (feedsub) FAILED: ${String(error)}`);
    return;
  }

  // feedsmith only parses an already-fetched string, so this is a second, separate
  // fetch of the same URL - a divergence below could in principle stem from the two
  // HTTP clients (miniget vs axios) handling something differently, not just the
  // parsers, and is worth reporting either way.
  let rawBody: string;
  try {
    const response = await axios.get<string>(config.feedUrl, {
      responseType: 'text',
      timeout: 10_000,
    });
    rawBody = response.data;
  } catch (error) {
    console.log(`  NEW PATH FETCH FAILED: ${String(error)}`);
    return;
  }

  let newItems: ReturnType<typeof normalizeFeed>;
  try {
    newItems = normalizeFeed(parseRawFeed(rawBody), {imageField: config.imageField});
  } catch (error) {
    console.log(`  NEW PARSER (feedsmith) FAILED: ${String(error)}`);
    return;
  }

  console.log(`  old: ${oldItems.length} item(s), new: ${newItems.length} item(s)`);
  if (oldItems.length !== newItems.length) {
    console.log('  DIVERGENCE: item count differs');
  }

  const count = Math.min(oldItems.length, newItems.length);
  for (let i = 0; i < count; i++) {
    const oldItem = oldItems[i];
    const newItem = newItems[i];
    const oldTitle = textOf(oldItem?.title);
    const oldLink = textOf(oldItem?.link);
    if (oldTitle !== newItem?.title) {
      console.log(
        `  DIVERGENCE item ${i} title: old=${JSON.stringify(oldTitle)} new=${JSON.stringify(newItem?.title)}`,
      );
    }
    if (oldLink !== newItem?.link) {
      console.log(
        `  DIVERGENCE item ${i} link: old=${JSON.stringify(oldLink)} new=${JSON.stringify(newItem?.link)}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const configRoot = process.env.FLEET_CONFIG_ROOT;
  if (!configRoot) throw new Error('Missing env var FLEET_CONFIG_ROOT');

  console.log(
    '=== Feed migration shadow-run: feedsub vs feedsmith ===\n' +
      "Fetches each configured bot feed and diffs the old and new parsers' output.\n" +
      'Run this against the live VPS config before cutting over production.\n',
  );

  const configs = loadBotConfigs(configRoot);
  console.log(`Found ${configs.size} bot config(s).\n`);

  for (const [botId, config] of configs) {
    await compareBot(botId, config);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
