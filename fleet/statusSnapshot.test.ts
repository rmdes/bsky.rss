import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BotOperations} from './botOperations.ts';
import type {BotWorker} from './botWorker.ts';
import {Logger} from '../shared/logging/logger.ts';
import {buildFleetStatusSnapshot} from './statusSnapshot.ts';
import type {SharedLimiters} from './sharedLimiters.ts';

const currentTime = new Date('2026-08-03T12:00:00.000Z');

function fakeWorker(botId: string, queueDepth: number): BotWorker {
  return {botId, queueLength: () => queueDepth} as BotWorker;
}

function fakeSharedLimiters(ogQueue: number, imageQueue: number): SharedLimiters {
  return {getQueueDepths: () => ({ogQueue, imageQueue})} as SharedLimiters;
}

test('aggregates a 59-bot startup snapshot without starting workers or waiting', () => {
  const operations = new Map<string, BotOperations>();
  for (let index = 58; index >= 0; index--) {
    const botId = `bot-${String(index).padStart(2, '0')}`;
    operations.set(botId, new BotOperations(botId, () => currentTime));
  }

  for (let index = 0; index < 30; index++) {
    operations.get(`bot-${String(index).padStart(2, '0')}`)!.recordFeedSuccess();
  }
  for (let index = 30; index < 37; index++) {
    operations.get(`bot-${String(index).padStart(2, '0')}`)!.recordFeedFailure('http-500');
  }
  operations.get('bot-00')!.recordOpenGraphSuccess();
  operations.get('bot-01')!.recordOpenGraphFallback();
  operations.get('bot-02')!.recordQueued();
  operations.get('bot-03')!.recordPolicySkip();
  operations.get('bot-04')!.recordPostSuccess();
  operations.get('bot-05')!.recordPostUncertain();
  operations.get('bot-06')!.recordPostDeferred();
  operations.get('bot-07')!.recordPostException();

  const activeWorkers = new Map<string, BotWorker>();
  for (let index = 0; index < 40; index++) {
    const botId = `bot-${String(index).padStart(2, '0')}`;
    activeWorkers.set(botId, fakeWorker(botId, index + 1));
  }
  const activationFailureIds = new Set(['bot-40', 'bot-41', 'bot-42', 'bot-43', 'bot-44']);
  const logger = new Logger({defaultLevel: 'summary', now: () => currentTime});
  logger.replaceOverrides(
    new Map([
      ['bot-00', {level: 'debug', expiresAt: '2026-08-03T13:00:00.000Z'}],
      ['bot-01', {level: 'verbose', expiresAt: '2026-08-03T11:00:00.000Z'}],
    ]),
  );

  const snapshot = buildFleetStatusSnapshot({
    phase: 'starting',
    startedAt: new Date('2026-08-03T11:30:00.000Z'),
    now: currentTime,
    operations,
    activeWorkers,
    activationFailureIds,
    configErrorCount: 3,
    logger,
    memoryUsage: {rss: 241 * 1024 * 1024, heapUsed: 80 * 1024 * 1024},
    sharedLimiters: fakeSharedLimiters(9, 4),
  });

  assert.deepEqual(snapshot.bots, {
    configured: 59,
    active: 40,
    activationFailed: 5,
    configInvalid: 3,
    feedsStarting: 22,
    feedsOk: 30,
    feedsFailing: 7,
  });
  assert.deepEqual(
    snapshot.botStates.reduce<Record<string, number>>((counts, state) => {
      counts[state.activationState] = (counts[state.activationState] ?? 0) + 1;
      return counts;
    }, {}),
    {active: 40, failed: 5, pending: 14},
  );
  assert.deepEqual(snapshot.totals, {
    feedPollSucceeded: 30,
    feedPollFailed: 7,
    openGraphAttempted: 2,
    openGraphSucceeded: 1,
    openGraphFallback: 1,
    queued: 1,
    policySkipped: 1,
    postSucceeded: 1,
    postUncertain: 1,
    postDeferred: 1,
    postException: 1,
    queueDepth: 820,
  });
  assert.deepEqual(snapshot.memory, {
    rssBytes: 241 * 1024 * 1024,
    heapUsedBytes: 80 * 1024 * 1024,
  });
  assert.deepEqual(snapshot.limiters, {ogQueueDepth: 9, imageQueueDepth: 4});
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.phase, 'starting');
  assert.equal(snapshot.startedAt, '2026-08-03T11:30:00.000Z');
  assert.equal(snapshot.heartbeatAt, '2026-08-03T12:00:00.000Z');
  assert.deepEqual(
    snapshot.botStates.map(state => state.botId),
    Array.from({length: 59}, (_, index) => `bot-${String(index).padStart(2, '0')}`),
  );
  assert.equal(snapshot.botStates[0]!.queueDepth, 1);
  assert.equal(snapshot.botStates[40]!.queueDepth, null);
  assert.equal(snapshot.botStates[0]!.effectiveLogLevel, 'debug');
  assert.equal(snapshot.botStates[0]!.logOverrideExpiresAt, '2026-08-03T13:00:00.000Z');
  assert.equal(snapshot.botStates[1]!.effectiveLogLevel, 'summary');
  assert.equal(snapshot.botStates[1]!.logOverrideExpiresAt, null);
});

test('snapshot results do not alias operational counters or expose activation errors', () => {
  const operation = new BotOperations('safe-bot', () => currentTime);
  operation.recordPostSuccess();
  const input = {
    phase: 'running' as const,
    startedAt: currentTime,
    now: currentTime,
    operations: new Map([['safe-bot', operation]]),
    activeWorkers: new Map<string, BotWorker>(),
    activationFailureIds: new Set(['safe-bot']),
    configErrorCount: 0,
    logger: new Logger({defaultLevel: 'summary', now: () => currentTime}),
    memoryUsage: {rss: 1, heapUsed: 2},
    sharedLimiters: fakeSharedLimiters(0, 0),
  };

  const first = buildFleetStatusSnapshot(input);
  first.botStates[0]!.counters.postSucceeded = 999;
  const second = buildFleetStatusSnapshot(input);

  assert.equal(first.totals.postSucceeded, 1);
  assert.equal(second.botStates[0]!.counters.postSucceeded, 1);
  assert.equal(second.totals.postSucceeded, 1);
  assert.equal(second.botStates[0]!.activationState, 'failed');
  assert.doesNotMatch(JSON.stringify(second), /login failed|activationError|https?:\/\//i);
});
