import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConcurrencyLimiter, SharedLimiters} from './sharedLimiters.ts';
import {FleetLogger, type FleetLogRecord} from '../shared/logging/logger.ts';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('ConcurrencyLimiter throws when constructed with a non-positive max', () => {
  assert.throws(() => new ConcurrencyLimiter(0), /max must be >= 1/);
});

test('ConcurrencyLimiter never lets more than `max` callbacks run at once', async () => {
  const limiter = new ConcurrencyLimiter(2);
  let active = 0;
  let peak = 0;

  const task = async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(20);
    active--;
  };

  await Promise.all([
    limiter.run(task),
    limiter.run(task),
    limiter.run(task),
    limiter.run(task),
    limiter.run(task),
  ]);

  assert.equal(peak, 2);
});

test("ConcurrencyLimiter returns each call's own result", async () => {
  const limiter = new ConcurrencyLimiter(1);
  const results = await Promise.all([
    limiter.run(async () => 1),
    limiter.run(async () => 2),
    limiter.run(async () => 3),
  ]);
  assert.deepEqual(results, [1, 2, 3]);
});

test('ConcurrencyLimiter propagates a rejection without blocking later queued calls', async () => {
  const limiter = new ConcurrencyLimiter(1);
  const first = limiter.run(async () => {
    throw new Error('boom');
  });
  const second = limiter.run(async () => 'still runs');

  await assert.rejects(first, /boom/);
  assert.equal(await second, 'still runs');
});

test('SharedLimiters exposes the configured timeout and image size cap', () => {
  const limiters = new SharedLimiters({
    maxConcurrentOpenGraphFetches: 6,
    maxConcurrentImageJobs: 2,
    maxImageDownloadBytes: 10_000_000,
    httpTimeoutMs: 10_000,
  });
  assert.equal(limiters.httpTimeoutMs, 10_000);
  assert.equal(limiters.maxImageDownloadBytes, 10_000_000);
});

test('SharedLimiters.withOgLimit enforces maxConcurrentOpenGraphFetches independently of withImageLimit', async () => {
  const limiters = new SharedLimiters({
    maxConcurrentOpenGraphFetches: 1,
    maxConcurrentImageJobs: 1,
    maxImageDownloadBytes: 10_000_000,
    httpTimeoutMs: 10_000,
  });
  let ogActive = 0;
  let ogPeak = 0;
  const ogTask = () =>
    limiters.withOgLimit(async () => {
      ogActive++;
      ogPeak = Math.max(ogPeak, ogActive);
      await sleep(20);
      ogActive--;
    });

  await Promise.all([ogTask(), ogTask(), ogTask()]);
  assert.equal(ogPeak, 1);
});

test('shared limiter contention diagnostics honor per-bot debug overrides', async () => {
  const records: FleetLogRecord[] = [];
  const logger = new FleetLogger({
    defaultLevel: 'summary',
    sink: (_line, record) => records.push(record),
  });
  logger.replaceOverrides(
    new Map([['debug-bot', {level: 'debug', expiresAt: '2099-01-01T00:00:00.000Z'}]]),
  );
  const limiters = new SharedLimiters({
    maxConcurrentOpenGraphFetches: 1,
    maxConcurrentImageJobs: 1,
    maxImageDownloadBytes: 10_000_000,
    httpTimeoutMs: 10_000,
  });
  let releaseQuiet!: () => void;
  let quietEntered!: () => void;
  const quietHasEntered = new Promise<void>(resolve => {
    quietEntered = resolve;
  });
  const quietGate = new Promise<void>(resolve => {
    releaseQuiet = resolve;
  });

  const quiet = limiters.withImageLimit(
    async () => {
      quietEntered();
      await quietGate;
    },
    {logger, botId: 'quiet-bot'},
  );
  await quietHasEntered;
  const debug = limiters.withImageLimit(async () => undefined, {
    logger,
    botId: 'debug-bot',
  });

  assert.deepEqual(
    records.map(record => record.message),
    ['Image waiting for shared limiter capacity'],
  );
  releaseQuiet();
  await Promise.all([quiet, debug]);

  assert.deepEqual(
    records.map(record => record.message),
    [
      'Image waiting for shared limiter capacity',
      'Image acquired shared limiter',
      'Image released shared limiter',
    ],
  );
  assert.ok(records.every(record => record.level === 'debug' && record.botId === 'debug-bot'));
});
