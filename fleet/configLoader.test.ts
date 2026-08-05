import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadFleet} from './configLoader.ts';

const FLEET_JSON = {
  staggerSeconds: 30,
  runIntervalSeconds: 60,
  freshness: {maxCatchupItems: 5, maxItemAgeMinutes: 120},
  sharedLimiters: {
    maxConcurrentOpenGraphFetches: 6,
    maxConcurrentImageJobs: 2,
    maxImageDownloadBytes: 10_000_000,
    httpTimeoutMs: 10_000,
  },
  perBotQueueMaxLength: 500,
};

function writeBot(
  configRoot: string,
  botId: string,
  bot: Record<string, unknown>,
  config: Record<string, unknown>,
): void {
  const botDir = join(configRoot, 'bots', botId);
  mkdirSync(botDir, {recursive: true});
  writeFileSync(join(botDir, 'bot.json'), JSON.stringify(bot));
  writeFileSync(join(botDir, 'config.json'), JSON.stringify(config));
}

function setupFleet(): {
  configRoot: string;
  secretsFilePath: string;
  dataRoot: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'fleet-config-test-'));
  const configRoot = join(root, 'config');
  const dataRoot = join(root, 'data');
  const secretsFilePath = join(root, 'secrets', 'bsky-fleet.json');
  mkdirSync(configRoot, {recursive: true});
  mkdirSync(join(root, 'secrets'), {recursive: true});
  writeFileSync(join(configRoot, 'fleet.json'), JSON.stringify(FLEET_JSON));
  return {
    configRoot,
    secretsFilePath,
    dataRoot,
    cleanup: () => rmSync(root, {recursive: true, force: true}),
  };
}

test('loadFleet loads fleet-level config and a single well-formed bot', t => {
  const {configRoot, secretsFilePath, dataRoot, cleanup} = setupFleet();
  t.after(cleanup);

  writeBot(
    configRoot,
    'bot-a',
    {
      id: 'bot-a',
      enabled: true,
      identifier: 'bot-a.bsky.social',
      instanceUrl: 'https://bsky.social',
      feedUrl: 'https://example.com/a.xml',
      secretKey: 'bot-a',
      fetchIntervalMinutes: 5,
    },
    {string: '$title - $link', publishEmbed: true, languages: ['en']},
  );
  writeFileSync(secretsFilePath, JSON.stringify({'bot-a': 'app-password-a'}));

  const result = loadFleet(configRoot, secretsFilePath, dataRoot);

  assert.equal(result.errors.length, 0);
  assert.equal(result.bots.length, 1);
  const bot = result.bots[0]!;
  assert.equal(bot.botId, 'bot-a');
  assert.equal(bot.identifier, 'bot-a.bsky.social');
  assert.equal(bot.appPassword, 'app-password-a');
  assert.equal(bot.instanceUrl, 'https://bsky.social');
  assert.equal(bot.feedUrl, 'https://example.com/a.xml');
  assert.equal(bot.fetchIntervalMinutes, 5);
  assert.equal(bot.dbPath, join(dataRoot, 'bots', 'bot-a', 'state.sqlite'));
  assert.equal(bot.feedReaderConfig.string, '$title - $link');
  assert.equal(bot.feedReaderConfig.publishEmbed, true);
  assert.deepEqual(bot.feedReaderConfig.languages, ['en']);
  assert.equal(result.fleetConfig.staggerSeconds, 30);
  assert.equal(result.fleetConfig.perBotQueueMaxLength, 500);
});

test('loadFleet maps adaptiveSpacing/spacingWindow/minSpacing/maxSpacing into schedulerConfig, not feedReaderConfig', t => {
  const {configRoot, secretsFilePath, dataRoot, cleanup} = setupFleet();
  t.after(cleanup);

  writeBot(
    configRoot,
    'bot-a',
    {
      id: 'bot-a',
      enabled: true,
      identifier: 'bot-a.bsky.social',
      instanceUrl: 'https://bsky.social',
      feedUrl: 'https://example.com/a.xml',
      secretKey: 'bot-a',
      fetchIntervalMinutes: 5,
    },
    {
      string: '$title',
      languages: ['en'],
      adaptiveSpacing: true,
      spacingWindow: 600,
      minSpacing: 1,
      maxSpacing: 60,
    },
  );
  writeFileSync(secretsFilePath, JSON.stringify({'bot-a': 'pw'}));

  const {bots} = loadFleet(configRoot, secretsFilePath, dataRoot);
  const bot = bots[0]!;
  assert.deepEqual(bot.schedulerConfig, {
    adaptiveSpacing: true,
    spacingWindow: 600,
    minSpacing: 1,
    maxSpacing: 60,
  });
  assert.equal((bot.feedReaderConfig as any).adaptiveSpacing, undefined);
});

test('loadFleet skips a bot with enabled: false', t => {
  const {configRoot, secretsFilePath, dataRoot, cleanup} = setupFleet();
  t.after(cleanup);

  writeBot(
    configRoot,
    'bot-disabled',
    {
      id: 'bot-disabled',
      enabled: false,
      identifier: 'x.bsky.social',
      instanceUrl: 'https://bsky.social',
      feedUrl: 'https://example.com/x.xml',
      secretKey: 'bot-disabled',
      fetchIntervalMinutes: 5,
    },
    {string: '$title', languages: ['en']},
  );
  writeFileSync(secretsFilePath, JSON.stringify({'bot-disabled': 'pw'}));

  const {bots, errors} = loadFleet(configRoot, secretsFilePath, dataRoot);
  assert.equal(bots.length, 0);
  assert.equal(errors.length, 0, 'a deliberately disabled bot is not an error');
});

test('loadFleet reports one bad bot directory as an error without dropping the other bots', t => {
  const {configRoot, secretsFilePath, dataRoot, cleanup} = setupFleet();
  t.after(cleanup);

  writeBot(
    configRoot,
    'bot-good',
    {
      id: 'bot-good',
      enabled: true,
      identifier: 'good.bsky.social',
      instanceUrl: 'https://bsky.social',
      feedUrl: 'https://example.com/good.xml',
      secretKey: 'bot-good',
      fetchIntervalMinutes: 5,
    },
    {string: '$title', languages: ['en']},
  );
  mkdirSync(join(configRoot, 'bots', 'bot-bad'), {recursive: true});
  writeFileSync(join(configRoot, 'bots', 'bot-bad', 'bot.json'), '{ not valid json');
  writeFileSync(
    join(configRoot, 'bots', 'bot-bad', 'config.json'),
    JSON.stringify({string: '$title'}),
  );
  writeFileSync(secretsFilePath, JSON.stringify({'bot-good': 'pw'}));

  const {bots, errors} = loadFleet(configRoot, secretsFilePath, dataRoot);
  assert.equal(bots.length, 1);
  assert.equal(bots[0]!.botId, 'bot-good');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.botId, 'bot-bad');
});

test("loadFleet reports a bot.json id that doesn't match its directory name as an error", t => {
  const {configRoot, secretsFilePath, dataRoot, cleanup} = setupFleet();
  t.after(cleanup);

  writeBot(
    configRoot,
    'bot-a',
    {
      id: 'bot-different',
      enabled: true,
      identifier: 'bot-a.bsky.social',
      instanceUrl: 'https://bsky.social',
      feedUrl: 'https://example.com/a.xml',
      secretKey: 'bot-a',
      fetchIntervalMinutes: 5,
    },
    {string: '$title', languages: ['en']},
  );
  writeFileSync(secretsFilePath, JSON.stringify({'bot-a': 'pw'}));

  const {bots, errors} = loadFleet(configRoot, secretsFilePath, dataRoot);
  assert.equal(bots.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.botId, 'bot-a');
  assert.match(errors[0]!.error, /does not match directory name/);
});

test('loadFleet reports a bot whose secretKey has no entry in the secrets file as an error', t => {
  const {configRoot, secretsFilePath, dataRoot, cleanup} = setupFleet();
  t.after(cleanup);

  writeBot(
    configRoot,
    'bot-a',
    {
      id: 'bot-a',
      enabled: true,
      identifier: 'bot-a.bsky.social',
      instanceUrl: 'https://bsky.social',
      feedUrl: 'https://example.com/a.xml',
      secretKey: 'missing-key',
      fetchIntervalMinutes: 5,
    },
    {string: '$title', languages: ['en']},
  );
  writeFileSync(secretsFilePath, JSON.stringify({}));

  const {bots, errors} = loadFleet(configRoot, secretsFilePath, dataRoot);
  assert.equal(bots.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.botId, 'bot-a');
});
