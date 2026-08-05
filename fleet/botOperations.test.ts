import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BotOperations, classifyFeedFailure, emptyBotCounters} from './botOperations.ts';

function clock(...timestamps: string[]): () => Date {
  let index = 0;
  return () => new Date(timestamps[index++]!);
}

test('records each operational outcome in independent counters', () => {
  const operations = new BotOperations(
    'bot-a',
    clock('2026-08-03T10:00:00.000Z', '2026-08-03T10:01:00.000Z'),
  );

  operations.recordFeedSuccess();
  operations.recordOpenGraphSuccess();
  operations.recordOpenGraphFallback();
  operations.recordQueued();
  operations.recordPolicySkip();
  operations.recordPostSuccess();
  operations.recordPostUncertain();
  operations.recordPostDeferred();
  operations.recordPostException();

  assert.deepEqual(operations.snapshot().counters, {
    feedPollSucceeded: 1,
    feedPollFailed: 0,
    openGraphAttempted: 2,
    openGraphSucceeded: 1,
    openGraphFallback: 1,
    queued: 1,
    policySkipped: 1,
    postSucceeded: 1,
    postUncertain: 1,
    postDeferred: 1,
    postException: 1,
  });
});

test('reports feed failure transitions and recovers after consecutive failures', () => {
  const operations = new BotOperations(
    'bot-a',
    clock(
      '2026-08-03T10:00:00.000Z',
      '2026-08-03T10:01:00.000Z',
      '2026-08-03T10:02:00.000Z',
      '2026-08-03T10:03:00.000Z',
    ),
  );

  assert.deepEqual(operations.recordFeedFailure('timeout'), {
    becameFailing: true,
    consecutiveFailures: 1,
  });
  assert.deepEqual(operations.recordFeedFailure('dns'), {
    becameFailing: false,
    consecutiveFailures: 2,
  });
  assert.deepEqual(operations.recordFeedFailure('parse'), {
    becameFailing: false,
    consecutiveFailures: 3,
  });

  assert.deepEqual(operations.recordFeedSuccess(), {recoveredFailures: 3});
  assert.deepEqual(operations.snapshot(), {
    botId: 'bot-a',
    feedState: 'ok',
    lastFeedSuccessAt: '2026-08-03T10:03:00.000Z',
    lastFeedFailureAt: '2026-08-03T10:02:00.000Z',
    consecutiveFeedFailures: 0,
    lastFeedFailureCategory: 'parse',
    lastPostSuccessAt: null,
    counters: {
      feedPollSucceeded: 1,
      feedPollFailed: 3,
      openGraphAttempted: 0,
      openGraphSucceeded: 0,
      openGraphFallback: 0,
      queued: 0,
      policySkipped: 0,
      postSucceeded: 0,
      postUncertain: 0,
      postDeferred: 0,
      postException: 0,
    },
  });
});

test('treats every successful feed poll identically and timestamps only confirmed posts', () => {
  const operations = new BotOperations(
    'bot-a',
    clock('2026-08-03T10:00:00.000Z', '2026-08-03T10:01:00.000Z', '2026-08-03T10:02:00.000Z'),
  );

  assert.deepEqual(operations.recordFeedSuccess(), {recoveredFailures: 0});
  operations.recordPostUncertain();
  operations.recordPostDeferred();
  operations.recordPostException();
  assert.equal(operations.snapshot().lastPostSuccessAt, null);

  assert.deepEqual(operations.recordFeedSuccess(), {recoveredFailures: 0});
  operations.recordPostSuccess();

  assert.equal(operations.snapshot().feedState, 'ok');
  assert.equal(operations.snapshot().counters.feedPollSucceeded, 2);
  assert.equal(operations.snapshot().lastPostSuccessAt, '2026-08-03T10:02:00.000Z');
});

test('returns defensive snapshot and counter copies', () => {
  const operations = new BotOperations('bot-a', clock('2026-08-03T10:00:00.000Z'));
  operations.recordQueued();
  const snapshot = operations.snapshot();
  snapshot.botId = 'tampered';
  snapshot.counters.queued = 99;

  assert.deepEqual(operations.snapshot(), {
    botId: 'bot-a',
    feedState: 'starting',
    lastFeedSuccessAt: null,
    lastFeedFailureAt: null,
    consecutiveFeedFailures: 0,
    lastFeedFailureCategory: null,
    lastPostSuccessAt: null,
    counters: {...emptyBotCounters(), queued: 1},
  });
});

test('classifies expected feed failure shapes without retaining error details', () => {
  const cases: Array<[unknown, string]> = [
    [{status: 404, url: 'https://private.example/feed.xml'}, 'http-404'],
    [{statusCode: 503, responseUrl: 'https://private.example/feed.xml'}, 'http-503'],
    [{code: 'ETIMEDOUT'}, 'timeout'],
    [{code: 'ENOTFOUND'}, 'dns'],
    [{code: 'CERT_HAS_EXPIRED'}, 'tls'],
    [{code: 'ECONNRESET'}, 'connection'],
    [new Error('XML parser error: mismatched tag'), 'parse'],
    [{message: 'request timed out'}, 'timeout'],
    [{message: 'getaddrinfo ENOTFOUND feeds.example'}, 'dns'],
    [{message: 'self signed certificate'}, 'tls'],
    [{message: 'socket hang up'}, 'connection'],
    [{message: 'Unexpected close tag at line 3'}, 'parse'],
    [{unexpected: 'shape'}, 'other'],
    [{status: -1}, 'other'],
    [{status: 200.5}, 'other'],
  ];

  for (const [error, expected] of cases) {
    assert.equal(classifyFeedFailure(error), expected);
  }

  const operations = new BotOperations('bot-a', clock('2026-08-03T10:00:00.000Z'));
  operations.recordFeedFailure(
    classifyFeedFailure({status: 500, url: 'https://secret.example/feed.xml'}),
  );
  const snapshot = operations.snapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'botId',
    'consecutiveFeedFailures',
    'counters',
    'feedState',
    'lastFeedFailureAt',
    'lastFeedFailureCategory',
    'lastFeedSuccessAt',
    'lastPostSuccessAt',
  ]);
  assert.equal(snapshot.lastFeedFailureCategory, 'http-500');
  assert.equal(JSON.stringify(snapshot).includes('secret.example'), false);
});
