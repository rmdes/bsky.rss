import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {Logger, type LogRecord} from '../shared/logging/logger.ts';
import {
  LogOverrideWatcher,
  overridesPath,
  parseDuration,
  readValidOverrides,
  writeOverrides,
} from './logOverrides.ts';

function tempDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'fleet-log-overrides-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return directory;
}

test('overridesPath places log-overrides.json directly under the data root', () => {
  assert.equal(overridesPath('/srv/fleet-data'), '/srv/fleet-data/log-overrides.json');
});

test('parseDuration converts positive whole seconds, minutes, and hours', () => {
  assert.equal(parseDuration('15s'), 15_000);
  assert.equal(parseDuration('12m'), 720_000);
  assert.equal(parseDuration('3h'), 10_800_000);
});

test('parseDuration rejects non-positive, fractional, unitless, overflowing, and unknown durations', () => {
  for (const value of ['0s', '-1m', '1.5h', '20', '999999999999999999999h', '1d']) {
    assert.throws(() => parseDuration(value), /positive duration/i, value);
  }
});

test('readValidOverrides returns active overrides and treats absence as an empty document', t => {
  const path = join(tempDirectory(t), 'log-overrides.json');
  const knownBotIds = new Set(['bot-a', 'bot-b']);

  assert.deepEqual([...readValidOverrides(path, knownBotIds, new Date(0))], []);

  writeFileSync(
    path,
    JSON.stringify({
      'bot-a': {level: 'verbose', expiresAt: '2026-08-03T12:00:00.001Z'},
      'bot-b': {level: 'debug', expiresAt: '2026-08-03T12:00:00.000Z'},
    }),
  );

  assert.deepEqual(
    [...readValidOverrides(path, knownBotIds, new Date('2026-08-03T12:00:00.000Z'))],
    [['bot-a', {level: 'verbose', expiresAt: '2026-08-03T12:00:00.001Z'}]],
  );
});

test('readValidOverrides prunes a structurally valid expired override before bot authority checks', t => {
  const path = join(tempDirectory(t), 'log-overrides.json');
  writeFileSync(
    path,
    JSON.stringify({
      'removed-bot': {level: 'debug', expiresAt: '2026-08-03T11:59:59.999Z'},
      'bot-a': {level: 'verbose', expiresAt: '2026-08-03T12:05:00.000Z'},
    }),
  );

  assert.deepEqual(
    [...readValidOverrides(path, new Set(['bot-a']), new Date('2026-08-03T12:00:00.000Z'))],
    [['bot-a', {level: 'verbose', expiresAt: '2026-08-03T12:05:00.000Z'}]],
  );
});

test('readValidOverrides rejects an entire document when any entry is invalid', t => {
  const path = join(tempDirectory(t), 'log-overrides.json');
  const knownBotIds = new Set(['bot-a', 'bot-b']);
  const valid = {level: 'verbose', expiresAt: '2026-08-03T12:05:00.000Z'};
  const invalidDocuments: unknown[] = [
    {'bot-a': valid, 'unknown-bot': valid},
    {'bot-a': valid, 'bot-b': {level: 'trace', expiresAt: valid.expiresAt}},
    {
      'bot-a': valid,
      'bot-b': {
        level: 'trace',
        expiresAt: '2026-08-03T11:59:59.999Z',
      },
    },
    {
      'bot-a': valid,
      'removed-bot': {
        level: 'trace',
        expiresAt: '2026-08-03T11:59:59.999Z',
      },
    },
    {'bot-a': valid, 'bot-b': {level: 'debug', expiresAt: 'not-a-date'}},
    {'bot-a': valid, 'bot-b': null},
    [valid],
  ];

  for (const document of invalidDocuments) {
    writeFileSync(path, JSON.stringify(document));
    assert.throws(
      () => readValidOverrides(path, knownBotIds, new Date('2026-08-03T12:00:00.000Z')),
      /invalid log override/i,
    );
  }
});

test('writeOverrides privately and atomically replaces the complete document', t => {
  const path = join(tempDirectory(t), 'nested', 'log-overrides.json');
  writeOverrides(
    path,
    new Map([['bot-a', {level: 'summary', expiresAt: '2026-08-03T12:05:00.000Z'}]]),
  );
  chmodSync(path, 0o644);
  writeOverrides(
    path,
    new Map([['bot-b', {level: 'debug', expiresAt: '2026-08-03T12:10:00.000Z'}]]),
  );

  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    'bot-b': {level: 'debug', expiresAt: '2026-08-03T12:10:00.000Z'},
  });
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('watcher applies one bot override, expires it, and does not repeat administrative lines', t => {
  const path = join(tempDirectory(t), 'log-overrides.json');
  const records: LogRecord[] = [];
  let now = new Date('2026-08-03T12:00:00.000Z');
  const logger = new Logger({
    defaultLevel: 'summary',
    now: () => now,
    sink: (_line, record) => records.push(record),
  });
  const watcher = new LogOverrideWatcher({
    path,
    knownBotIds: new Set(['bot-a', 'bot-b']),
    logger,
    now: () => now,
  });

  watcher.poll();
  writeOverrides(
    path,
    new Map([['bot-a', {level: 'debug', expiresAt: '2026-08-03T12:05:00.000Z'}]]),
  );
  watcher.poll();
  watcher.poll();

  assert.equal(logger.effectiveLevel('bot-a'), 'debug');
  assert.equal(logger.effectiveLevel('bot-b'), 'summary');
  assert.equal(records.filter(record => /override set/i.test(record.message)).length, 1);
  assert.equal(
    records.filter(record => /private feed URLs, titles, and post text/i.test(record.message))
      .length,
    1,
  );

  now = new Date('2026-08-03T12:05:00.000Z');
  watcher.poll();
  watcher.poll();

  assert.equal(logger.effectiveLevel('bot-a'), 'summary');
  assert.equal(records.filter(record => /override expired/i.test(record.message)).length, 1);
});

test('watcher warns only when an active override transitions into debug', t => {
  const path = join(tempDirectory(t), 'log-overrides.json');
  const records: LogRecord[] = [];
  const now = new Date('2026-08-03T12:00:00.000Z');
  const logger = new Logger({
    defaultLevel: 'summary',
    now: () => now,
    sink: (_line, record) => records.push(record),
  });
  const watcher = new LogOverrideWatcher({
    path,
    knownBotIds: new Set(['bot-a']),
    logger,
    now: () => now,
  });

  writeOverrides(
    path,
    new Map([['bot-a', {level: 'verbose', expiresAt: '2026-08-03T12:05:00.000Z'}]]),
  );
  watcher.poll();
  writeOverrides(
    path,
    new Map([['bot-a', {level: 'debug', expiresAt: '2026-08-03T12:10:00.000Z'}]]),
  );
  watcher.poll();
  writeOverrides(
    path,
    new Map([['bot-a', {level: 'debug', expiresAt: '2026-08-03T12:15:00.000Z'}]]),
  );
  watcher.poll();

  assert.deepEqual(logger.overrideFor('bot-a'), {
    level: 'debug',
    expiresAt: '2026-08-03T12:15:00.000Z',
  });
  assert.equal(records.filter(record => /override set/i.test(record.message)).length, 3);
  assert.equal(
    records.filter(record => /private feed URLs, titles, and post text/i.test(record.message))
      .length,
    1,
  );
});

test('watcher logs a valid clear once, including when deletion supplies the empty document', t => {
  const path = join(tempDirectory(t), 'log-overrides.json');
  const records: LogRecord[] = [];
  const now = new Date('2026-08-03T12:00:00.000Z');
  const logger = new Logger({
    defaultLevel: 'debug',
    now: () => now,
    sink: (_line, record) => records.push(record),
  });
  const watcher = new LogOverrideWatcher({
    path,
    knownBotIds: new Set(['bot-a']),
    logger,
    now: () => now,
  });

  writeOverrides(
    path,
    new Map([['bot-a', {level: 'summary', expiresAt: '2026-08-03T12:05:00.000Z'}]]),
  );
  watcher.poll();
  unlinkSync(path);
  watcher.poll();
  watcher.poll();

  assert.equal(logger.effectiveLevel('bot-a'), 'debug');
  assert.equal(records.filter(record => /override cleared/i.test(record.message)).length, 1);
});

test('watcher warns once for malformed rewrites, retains state, and still expires it', t => {
  const path = join(tempDirectory(t), 'log-overrides.json');
  const records: LogRecord[] = [];
  let now = new Date('2026-08-03T12:00:00.000Z');
  const logger = new Logger({
    defaultLevel: 'summary',
    now: () => now,
    sink: (_line, record) => records.push(record),
  });
  const watcher = new LogOverrideWatcher({
    path,
    knownBotIds: new Set(['bot-a']),
    logger,
    now: () => now,
  });

  writeOverrides(
    path,
    new Map([['bot-a', {level: 'verbose', expiresAt: '2026-08-03T12:02:00.000Z'}]]),
  );
  watcher.poll();
  writeFileSync(path, '{"bot-a":');
  watcher.poll();
  watcher.poll();

  assert.equal(logger.effectiveLevel('bot-a'), 'verbose');
  assert.equal(records.filter(record => /malformed.*ignored/i.test(record.message)).length, 1);

  now = new Date('2026-08-03T12:02:00.000Z');
  watcher.poll();
  watcher.poll();

  assert.equal(logger.effectiveLevel('bot-a'), 'summary');
  assert.equal(records.filter(record => /override expired/i.test(record.message)).length, 1);
  assert.equal(records.filter(record => /malformed.*ignored/i.test(record.message)).length, 1);

  writeOverrides(path, new Map());
  watcher.poll();
  writeFileSync(path, '{not-json');
  watcher.poll();
  assert.equal(records.filter(record => /malformed.*ignored/i.test(record.message)).length, 2);
});

test('watcher rethrows operational filesystem read failures instead of calling them malformed', t => {
  const path = tempDirectory(t);
  const records: LogRecord[] = [];
  const watcher = new LogOverrideWatcher({
    path,
    knownBotIds: new Set(['bot-a']),
    logger: new Logger({
      defaultLevel: 'debug',
      sink: (_line, record) => records.push(record),
    }),
  });

  assert.throws(
    () => watcher.poll(),
    (error: unknown) =>
      (error as NodeJS.ErrnoException)?.code === 'EISDIR' ||
      (error as NodeJS.ErrnoException)?.code === 'EACCES',
  );
  assert.equal(
    records.some(record => /malformed/i.test(record.message)),
    false,
  );
});
