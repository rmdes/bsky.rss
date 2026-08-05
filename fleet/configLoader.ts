import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import type {FeedReaderConfig} from './feedReader.ts';
import type {SchedulerConfig} from './scheduler.ts';
import type {FreshnessConfig} from './freshnessPolicy.ts';
import type {SharedLimitersConfig} from './sharedLimiters.ts';

export interface FleetConfig {
  staggerSeconds: number;
  runIntervalSeconds: number;
  freshness: FreshnessConfig;
  sharedLimiters: SharedLimitersConfig;
  perBotQueueMaxLength: number;
}

export interface BotSpec {
  botId: string;
  identifier: string;
  appPassword: string;
  instanceUrl: string;
  feedUrl: string;
  fetchIntervalMinutes: number;
  dbPath: string;
  feedReaderConfig: FeedReaderConfig;
  schedulerConfig: SchedulerConfig;
}

export interface LoadedFleet {
  fleetConfig: FleetConfig;
  bots: BotSpec[];
  errors: {botId: string; error: string}[];
}

interface BotJson {
  id: string;
  enabled: boolean;
  identifier: string;
  instanceUrl: string;
  feedUrl: string;
  secretKey: string;
  fetchIntervalMinutes: number;
}

const SCHEDULER_FIELDS = ['adaptiveSpacing', 'spacingWindow', 'minSpacing', 'maxSpacing'] as const;

function splitConfigJson(configJson: Record<string, unknown>): {
  feedReaderConfig: FeedReaderConfig;
  schedulerConfig: SchedulerConfig;
} {
  const feedReaderConfig = {...configJson} as Record<string, unknown>;
  for (const field of SCHEDULER_FIELDS) delete feedReaderConfig[field];

  return {
    feedReaderConfig: feedReaderConfig as unknown as FeedReaderConfig,
    schedulerConfig: {
      adaptiveSpacing: Boolean(configJson.adaptiveSpacing),
      spacingWindow: Number(configJson.spacingWindow ?? 600),
      minSpacing: Number(configJson.minSpacing ?? 1),
      maxSpacing: Number(configJson.maxSpacing ?? 60),
    },
  };
}

function loadOneBot(
  configRoot: string,
  dataRoot: string,
  secrets: Record<string, string>,
  botId: string,
): BotSpec {
  const botDir = join(configRoot, 'bots', botId);
  const bot = JSON.parse(readFileSync(join(botDir, 'bot.json'), 'utf-8')) as BotJson;
  if (bot.id !== botId) {
    throw new Error(`bot.json id "${bot.id}" does not match directory name "${botId}"`);
  }
  const configJson = JSON.parse(readFileSync(join(botDir, 'config.json'), 'utf-8')) as Record<
    string,
    unknown
  >;

  const appPassword = secrets[bot.secretKey];
  if (!appPassword) throw new Error(`No secret found for secretKey "${bot.secretKey}"`);

  const {feedReaderConfig, schedulerConfig} = splitConfigJson(configJson);

  return {
    botId: bot.id,
    identifier: bot.identifier,
    appPassword,
    instanceUrl: bot.instanceUrl,
    feedUrl: bot.feedUrl,
    fetchIntervalMinutes: bot.fetchIntervalMinutes,
    dbPath: join(dataRoot, 'bots', bot.id, 'state.sqlite'),
    feedReaderConfig,
    schedulerConfig,
  };
}

export function loadFleet(
  configRoot: string,
  secretsFilePath: string,
  dataRoot: string,
): LoadedFleet {
  const fleetConfig = JSON.parse(
    readFileSync(join(configRoot, 'fleet.json'), 'utf-8'),
  ) as FleetConfig;
  const secrets = JSON.parse(readFileSync(secretsFilePath, 'utf-8')) as Record<string, string>;

  const botsDir = join(configRoot, 'bots');
  const botIds = readdirSync(botsDir, {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

  const bots: BotSpec[] = [];
  const errors: {botId: string; error: string}[] = [];

  for (const botId of botIds) {
    let enabled: boolean;
    try {
      const bot = JSON.parse(readFileSync(join(botsDir, botId, 'bot.json'), 'utf-8')) as BotJson;
      enabled = bot.enabled;
    } catch (err) {
      errors.push({botId, error: String(err)});
      continue;
    }
    if (!enabled) continue;

    try {
      bots.push(loadOneBot(configRoot, dataRoot, secrets, botId));
    } catch (err) {
      errors.push({botId, error: String(err)});
    }
  }

  return {fleetConfig, bots, errors};
}
