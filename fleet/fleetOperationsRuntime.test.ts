import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {BotOperations} from './botOperations.ts';
import type {BotWorker} from './botWorker.ts';
import {
  FleetOperationsRuntime,
  type FleetOperationsRuntimeTimers,
} from './fleetOperationsRuntime.ts';
import {FleetLogger, type FleetLogRecord} from '../shared/logging/logger.ts';
import {writeOverrides} from './logOverrides.ts';
import type {FleetStatusSnapshot} from './statusSnapshot.ts';
import type {SharedLimiters} from './sharedLimiters.ts';

class FakeTimers implements FleetOperationsRuntimeTimers {
  private nextHandle = 1;
  private intervals = new Map<number, {callback: () => void; intervalMs: number}>();
  readonly cleared: number[] = [];

  setInterval(callback: () => void, intervalMs: number): number {
    const handle = this.nextHandle++;
    this.intervals.set(handle, {callback, intervalMs});
    return handle;
  }

  clearInterval(handle: unknown): void {
    if (typeof handle !== 'number') throw new TypeError('fake timer handle must be numeric');
    this.cleared.push(handle);
    this.intervals.delete(handle);
  }

  fire(intervalMs: number): void {
    const matching = [...this.intervals.values()].filter(
      interval => interval.intervalMs === intervalMs,
    );
    assert.equal(matching.length, 1, `expected one active ${intervalMs}ms timer`);
    matching[0]!.callback();
  }

  delays(): number[] {
    return [...this.intervals.values()].map(interval => interval.intervalMs).sort((a, b) => a - b);
  }

  activeCount(): number {
    return this.intervals.size;
  }
}

function tempDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'fleet-operations-runtime-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return directory;
}

function readSnapshot(path: string): FleetStatusSnapshot {
  return JSON.parse(readFileSync(path, 'utf8')) as FleetStatusSnapshot;
}

function fakeWorker(botId: string, queueDepth: number): BotWorker {
  return {botId, queueLength: () => queueDepth} as BotWorker;
}

function fakeSharedLimiters(ogQueue = 0, imageQueue = 0): SharedLimiters {
  return {getQueueDepths: () => ({ogQueue, imageQueue})} as SharedLimiters;
}

test('start writes all 59 starting bots before activation finishes and markRunning publishes the transition', async t => {
  const directory = tempDirectory(t);
  const statusFilePath = join(directory, 'status.json');
  const operations = new Map<string, BotOperations>();
  for (let index = 0; index < 59; index++) {
    const botId = `bot-${String(index).padStart(2, '0')}`;
    operations.set(botId, new BotOperations(botId));
  }
  const timers = new FakeTimers();
  const now = new Date('2026-08-03T12:00:00.000Z');
  const runtime = new FleetOperationsRuntime({
    timers,
    now: () => now,
    memoryUsage: () => ({rss: 241, heapUsed: 80}),
    paths: {status: statusFilePath, overrides: join(directory, 'log-overrides.json')},
    logger: new FleetLogger({defaultLevel: 'summary', now: () => now, sink: () => undefined}),
    operations,
    coordinator: {
      activeWorkers: () => [],
      activationFailures: () => [],
    },
    configInvalidCount: 3,
    sharedLimiters: fakeSharedLimiters(),
  });

  let finishActivation!: () => void;
  const activation = new Promise<void>(resolve => {
    finishActivation = resolve;
  });
  const activationLifecycle = activation.then(() => runtime.markRunning());

  runtime.start();

  const starting = readSnapshot(statusFilePath);
  assert.equal(starting.phase, 'starting');
  assert.deepEqual(starting.bots, {
    configured: 59,
    active: 0,
    activationFailed: 0,
    configInvalid: 3,
    feedsStarting: 59,
    feedsOk: 0,
    feedsFailing: 0,
  });

  finishActivation();
  await activationLifecycle;
  assert.equal(readSnapshot(statusFilePath).phase, 'running');
  runtime.stop();
});

test('the 5-second, 60-second, and 5-minute timers perform only their own actions and summaries reset their baseline', t => {
  const directory = tempDirectory(t);
  const statusFilePath = join(directory, 'status.json');
  const overridesFilePath = join(directory, 'log-overrides.json');
  let now = new Date('2026-08-03T12:00:00.000Z');
  const timers = new FakeTimers();
  const records: FleetLogRecord[] = [];
  const logger = new FleetLogger({
    defaultLevel: 'summary',
    now: () => now,
    sink: (_line, record) => records.push(record),
  });
  const operation = new BotOperations('bot-a', () => now);
  const runtime = new FleetOperationsRuntime({
    timers,
    now: () => now,
    memoryUsage: () => ({rss: 241 * 1024 * 1024, heapUsed: 80 * 1024 * 1024}),
    paths: {status: statusFilePath, overrides: overridesFilePath},
    logger,
    operations: new Map([['bot-a', operation]]),
    coordinator: {
      activeWorkers: () => [fakeWorker('bot-a', 14)],
      activationFailures: () => [],
    },
    configInvalidCount: 0,
    sharedLimiters: fakeSharedLimiters(2, 1),
  });

  runtime.start();
  assert.deepEqual(timers.delays(), [5_000, 60_000, 300_000]);
  const startupHeartbeat = readSnapshot(statusFilePath).heartbeatAt;

  operation.recordFeedSuccess();
  operation.recordOpenGraphFallback();
  operation.recordPolicySkip();
  operation.recordPostSuccess();
  writeOverrides(
    overridesFilePath,
    new Map([['bot-a', {level: 'debug', expiresAt: '2026-08-03T13:00:00.000Z'}]]),
  );
  now = new Date('2026-08-03T12:00:05.000Z');
  timers.fire(5_000);

  assert.equal(logger.effectiveLevel('bot-a'), 'debug');
  assert.equal(readSnapshot(statusFilePath).heartbeatAt, startupHeartbeat);
  assert.equal(records.filter(record => record.scope === 'FLEET').length, 0);

  now = new Date('2026-08-03T12:01:00.000Z');
  timers.fire(60_000);
  const minuteHeartbeat = readSnapshot(statusFilePath).heartbeatAt;
  assert.equal(minuteHeartbeat, '2026-08-03T12:01:00.000Z');
  assert.equal(records.filter(record => record.scope === 'FLEET').length, 0);

  writeOverrides(overridesFilePath, new Map());
  now = new Date('2026-08-03T12:05:00.000Z');
  timers.fire(300_000);
  assert.equal(logger.effectiveLevel('bot-a'), 'debug');
  assert.equal(readSnapshot(statusFilePath).heartbeatAt, minuteHeartbeat);
  assert.equal(
    records.find(record => record.scope === 'FLEET')?.message,
    '5m: feeds 1/1 ok · OG 0/1 ok, 1 fallback · posts 1/1 ok · 1 policy-skipped · queue 14 · 2 OG queued · 1 image queued · 0 feeds failing · RSS 241.0MB',
  );

  operation.recordFeedFailure('timeout');
  operation.recordPostDeferred();
  records.length = 0;
  now = new Date('2026-08-03T12:10:00.000Z');
  timers.fire(300_000);
  assert.equal(
    records.find(record => record.scope === 'FLEET')?.message,
    '5m: feeds 0/1 ok · OG n/a, 0 fallbacks · posts n/a, 1 deferred · 0 policy-skipped · queue 14 · 2 OG queued · 1 image queued · 1 feed failing · RSS 241.0MB',
  );

  runtime.stop();
  assert.equal(timers.activeCount(), 0);
  assert.deepEqual(
    timers.cleared.sort((a, b) => a - b),
    [1, 2, 3],
  );
});

test('a failed queue or memory observation retains every delta for the next summary', async t => {
  for (const failurePoint of ['queue', 'memory'] as const) {
    await t.test(failurePoint, t => {
      const directory = tempDirectory(t);
      const timers = new FakeTimers();
      const records: FleetLogRecord[] = [];
      const operation = new BotOperations('bot-a');
      let failNextObservation = false;
      const worker = {
        botId: 'bot-a',
        queueLength: () => {
          if (failurePoint === 'queue' && failNextObservation) {
            failNextObservation = false;
            throw new Error('private queue observation detail');
          }
          return 7;
        },
      } as BotWorker;
      const runtime = new FleetOperationsRuntime({
        timers,
        now: () => new Date('2026-08-03T12:00:00.000Z'),
        memoryUsage: () => {
          if (failurePoint === 'memory' && failNextObservation) {
            failNextObservation = false;
            throw new Error('private memory observation detail');
          }
          return {rss: 241 * 1024 * 1024, heapUsed: 80 * 1024 * 1024};
        },
        paths: {
          status: join(directory, 'status.json'),
          overrides: join(directory, 'log-overrides.json'),
        },
        logger: new FleetLogger({
          defaultLevel: 'debug',
          sink: (_line, record) => records.push(record),
        }),
        operations: new Map([['bot-a', operation]]),
        coordinator: {
          activeWorkers: () => [worker],
          activationFailures: () => [],
        },
        configInvalidCount: 0,
        sharedLimiters: fakeSharedLimiters(),
      });
      runtime.start();
      operation.recordPostSuccess();
      failNextObservation = true;

      assert.doesNotThrow(() => timers.fire(300_000));
      assert.ok(
        records.some(
          record =>
            record.level === 'summary' &&
            record.message === 'Interval summary failed; fleet execution continues',
        ),
      );
      assert.ok(
        records.some(
          record =>
            record.level === 'debug' &&
            record.message.includes(`${failurePoint} observation detail`),
        ),
      );

      operation.recordPostSuccess();
      records.length = 0;
      timers.fire(300_000);
      assert.match(
        records.find(record => record.message.startsWith('5m:'))?.message ?? '',
        /posts 2\/2 ok/,
      );
      runtime.stop();
    });
  }
});

test('a failed summary emission retains every delta for the next successful emission', t => {
  const directory = tempDirectory(t);
  const timers = new FakeTimers();
  const records: FleetLogRecord[] = [];
  const operation = new BotOperations('bot-a');
  let failNextEmission = false;
  const logger = new FleetLogger({
    defaultLevel: 'debug',
    sink: (_line, record) => {
      if (failNextEmission && record.scope === 'FLEET' && record.message.startsWith('5m:')) {
        failNextEmission = false;
        throw new Error('private summary sink detail');
      }
      records.push(record);
    },
  });
  const runtime = new FleetOperationsRuntime({
    timers,
    now: () => new Date('2026-08-03T12:00:00.000Z'),
    memoryUsage: () => ({rss: 241 * 1024 * 1024, heapUsed: 80 * 1024 * 1024}),
    paths: {
      status: join(directory, 'status.json'),
      overrides: join(directory, 'log-overrides.json'),
    },
    logger,
    operations: new Map([['bot-a', operation]]),
    coordinator: {
      activeWorkers: () => [fakeWorker('bot-a', 7)],
      activationFailures: () => [],
    },
    configInvalidCount: 0,
    sharedLimiters: fakeSharedLimiters(),
  });
  runtime.start();
  operation.recordPostSuccess();
  failNextEmission = true;

  assert.doesNotThrow(() => timers.fire(300_000));
  assert.ok(
    records.some(
      record =>
        record.level === 'summary' &&
        record.message === 'Interval summary failed; fleet execution continues',
    ),
  );
  assert.ok(
    records.some(
      record => record.level === 'debug' && record.message.includes('summary sink detail'),
    ),
  );

  operation.recordPostSuccess();
  records.length = 0;
  timers.fire(300_000);
  assert.match(
    records.find(record => record.message.startsWith('5m:'))?.message ?? '',
    /posts 2\/2 ok/,
  );
  runtime.stop();
});

test('markStopping writes stopping before worker shutdown resolves', async t => {
  const directory = tempDirectory(t);
  const statusFilePath = join(directory, 'status.json');
  const timers = new FakeTimers();
  const operation = new BotOperations('bot-a');
  const runtime = new FleetOperationsRuntime({
    timers,
    now: () => new Date('2026-08-03T12:00:00.000Z'),
    memoryUsage: () => ({rss: 1, heapUsed: 2}),
    paths: {status: statusFilePath, overrides: join(directory, 'log-overrides.json')},
    logger: new FleetLogger({defaultLevel: 'summary', sink: () => undefined}),
    operations: new Map([['bot-a', operation]]),
    coordinator: {
      activeWorkers: () => [fakeWorker('bot-a', 0)],
      activationFailures: () => [],
    },
    configInvalidCount: 0,
    sharedLimiters: fakeSharedLimiters(),
  });
  runtime.start();
  runtime.markRunning();

  let finishShutdown!: () => void;
  let shutdownFinished = false;
  const shutdownAll = () =>
    new Promise<void>(resolve => {
      finishShutdown = () => {
        shutdownFinished = true;
        resolve();
      };
    });

  runtime.markStopping();
  const shutdown = shutdownAll();
  assert.equal(shutdownFinished, false);
  assert.equal(readSnapshot(statusFilePath).phase, 'stopping');

  finishShutdown();
  await shutdown;
  runtime.stop();
});

test('snapshot observer failures produce a safe warning and debug detail without escaping start', t => {
  const directory = tempDirectory(t);
  const blockedParent = join(directory, 'not-a-directory');
  writeFileSync(blockedParent, 'block parent directory creation');
  const records: FleetLogRecord[] = [];
  const runtime = new FleetOperationsRuntime({
    timers: new FakeTimers(),
    now: () => new Date('2026-08-03T12:00:00.000Z'),
    memoryUsage: () => ({rss: 1, heapUsed: 2}),
    paths: {
      status: join(blockedParent, 'status.json'),
      overrides: join(directory, 'log-overrides.json'),
    },
    logger: new FleetLogger({
      defaultLevel: 'debug',
      sink: (_line, record) => records.push(record),
    }),
    operations: new Map(),
    coordinator: {
      activeWorkers: () => [],
      activationFailures: () => [],
    },
    configInvalidCount: 0,
    sharedLimiters: fakeSharedLimiters(),
  });

  assert.doesNotThrow(() => runtime.start());
  assert.deepEqual(
    records.filter(record => record.level === 'summary').map(record => record.message),
    ['Status snapshot write failed; fleet execution continues'],
  );
  assert.ok(
    records.some(
      record => record.level === 'debug' && /EEXIST|file already exists/i.test(record.message),
    ),
  );
  assert.ok(
    records
      .filter(record => record.level === 'summary')
      .every(record => !record.message.includes(blockedParent)),
  );
  runtime.stop();
});

test('a persistent snapshot write failure warns once, and a later failure re-warns after a successful write', t => {
  const directory = tempDirectory(t);
  const blockedParent = join(directory, 'not-a-directory');
  const statusFilePath = join(blockedParent, 'status.json');
  writeFileSync(blockedParent, 'block parent directory creation');
  const timers = new FakeTimers();
  const records: FleetLogRecord[] = [];
  const runtime = new FleetOperationsRuntime({
    timers,
    now: () => new Date('2026-08-03T12:00:00.000Z'),
    memoryUsage: () => ({rss: 1, heapUsed: 2}),
    paths: {status: statusFilePath, overrides: join(directory, 'log-overrides.json')},
    logger: new FleetLogger({
      defaultLevel: 'debug',
      sink: (_line, record) => records.push(record),
    }),
    operations: new Map(),
    coordinator: {
      activeWorkers: () => [],
      activationFailures: () => [],
    },
    configInvalidCount: 0,
    sharedLimiters: fakeSharedLimiters(),
  });
  const warnings = () =>
    records.filter(
      record =>
        record.level === 'summary' &&
        record.message === 'Status snapshot write failed; fleet execution continues',
    ).length;

  runtime.start();
  assert.equal(warnings(), 1, "start()'s initial write fires the first warning");

  timers.fire(60_000);
  timers.fire(60_000);
  assert.equal(warnings(), 1, 'sustained failure across further intervals must not re-warn');

  rmSync(blockedParent, {force: true});
  timers.fire(60_000);
  assert.equal(warnings(), 1, 'a successful write must not itself warn');
  assert.equal(readSnapshot(statusFilePath).phase, 'starting');

  rmSync(blockedParent, {recursive: true, force: true});
  writeFileSync(blockedParent, 'block parent directory creation again');
  timers.fire(60_000);
  assert.equal(warnings(), 2, 'failure after a successful write must warn again (latch reset)');

  timers.fire(60_000);
  assert.equal(warnings(), 2, 'the renewed failure must still only warn once while it persists');

  runtime.stop();
});

test('override observer failures produce a safe warning and debug detail without escaping the timer', t => {
  const directory = tempDirectory(t);
  const overridesFilePath = join(directory, 'log-overrides.json');
  const timers = new FakeTimers();
  const records: FleetLogRecord[] = [];
  const logger = new FleetLogger({
    defaultLevel: 'debug',
    sink: (_line, record) => records.push(record),
  });
  const runtime = new FleetOperationsRuntime({
    timers,
    now: () => new Date('2026-08-03T12:00:00.000Z'),
    memoryUsage: () => ({rss: 1, heapUsed: 2}),
    paths: {status: join(directory, 'status.json'), overrides: overridesFilePath},
    logger,
    operations: new Map([['bot-a', new BotOperations('bot-a')]]),
    coordinator: {
      activeWorkers: () => [],
      activationFailures: () => [],
    },
    configInvalidCount: 0,
    sharedLimiters: fakeSharedLimiters(),
  });
  runtime.start();
  records.length = 0;
  writeOverrides(
    overridesFilePath,
    new Map([['bot-a', {level: 'verbose', expiresAt: '2026-08-03T13:00:00.000Z'}]]),
  );
  logger.replaceOverrides = () => {
    throw new Error('private override observer detail');
  };

  assert.doesNotThrow(() => timers.fire(5_000));
  assert.deepEqual(
    records.filter(record => record.level === 'summary').map(record => record.message),
    ['Log override observation failed; fleet execution continues'],
  );
  assert.ok(
    records.some(
      record =>
        record.level === 'debug' && record.message.includes('private override observer detail'),
    ),
  );
  assert.ok(
    records
      .filter(record => record.level === 'summary')
      .every(record => !record.message.includes('private')),
  );
  runtime.stop();
});

test("override filesystem read failures reach the runtime's safe observer warning", t => {
  const directory = tempDirectory(t);
  const records: FleetLogRecord[] = [];
  const runtime = new FleetOperationsRuntime({
    timers: new FakeTimers(),
    now: () => new Date('2026-08-03T12:00:00.000Z'),
    memoryUsage: () => ({rss: 1, heapUsed: 2}),
    paths: {
      status: join(directory, 'status.json'),
      overrides: directory,
    },
    logger: new FleetLogger({
      defaultLevel: 'debug',
      sink: (_line, record) => records.push(record),
    }),
    operations: new Map([['bot-a', new BotOperations('bot-a')]]),
    coordinator: {
      activeWorkers: () => [],
      activationFailures: () => [],
    },
    configInvalidCount: 0,
    sharedLimiters: fakeSharedLimiters(),
  });

  assert.doesNotThrow(() => runtime.start());
  assert.deepEqual(
    records.filter(record => record.level === 'summary').map(record => record.message),
    ['Log override observation failed; fleet execution continues'],
  );
  assert.ok(
    records.some(record => record.level === 'debug' && /EISDIR|EACCES/.test(record.message)),
  );
  runtime.stop();
});
