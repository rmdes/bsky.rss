import assert from 'node:assert/strict';
import {test} from 'node:test';
import {emptyBotCounters, type BotCounters, type BotOperationalSnapshot} from './botOperations.ts';
import {formatFleetIntervalSummary, subtractBotCounters, sumBotCounters} from './fleetSummary.ts';

function state(botId: string, counters: Partial<BotCounters>): BotOperationalSnapshot {
  return {
    botId,
    feedState: 'starting',
    lastFeedSuccessAt: null,
    lastFeedFailureAt: null,
    consecutiveFeedFailures: 0,
    lastFeedFailureCategory: null,
    lastPostSuccessAt: null,
    counters: {...emptyBotCounters(), ...counters},
  };
}

test('sumBotCounters totals every operational counter across bots', () => {
  const totals = sumBotCounters([
    state('bot-a', {
      feedPollSucceeded: 5,
      feedPollFailed: 1,
      openGraphAttempted: 4,
      openGraphSucceeded: 3,
      openGraphFallback: 1,
      queued: 3,
      policySkipped: 2,
      postSucceeded: 2,
      postUncertain: 1,
      postDeferred: 1,
      postException: 0,
    }),
    state('bot-b', {
      feedPollSucceeded: 7,
      feedPollFailed: 2,
      openGraphAttempted: 5,
      openGraphSucceeded: 4,
      openGraphFallback: 1,
      queued: 6,
      policySkipped: 3,
      postSucceeded: 4,
      postUncertain: 2,
      postDeferred: 0,
      postException: 1,
    }),
  ]);

  assert.deepEqual(totals, {
    feedPollSucceeded: 12,
    feedPollFailed: 3,
    openGraphAttempted: 9,
    openGraphSucceeded: 7,
    openGraphFallback: 2,
    queued: 9,
    policySkipped: 5,
    postSucceeded: 6,
    postUncertain: 3,
    postDeferred: 1,
    postException: 1,
  });
});

test('subtractBotCounters returns exact per-counter interval deltas', () => {
  const previous: BotCounters = {
    feedPollSucceeded: 100,
    feedPollFailed: 5,
    openGraphAttempted: 40,
    openGraphSucceeded: 30,
    openGraphFallback: 10,
    queued: 20,
    policySkipped: 3,
    postSucceeded: 15,
    postUncertain: 2,
    postDeferred: 1,
    postException: 1,
  };
  const current: BotCounters = {
    feedPollSucceeded: 112,
    feedPollFailed: 8,
    openGraphAttempted: 49,
    openGraphSucceeded: 37,
    openGraphFallback: 12,
    queued: 29,
    policySkipped: 8,
    postSucceeded: 21,
    postUncertain: 5,
    postDeferred: 2,
    postException: 2,
  };

  assert.deepEqual(subtractBotCounters(current, previous), {
    feedPollSucceeded: 12,
    feedPollFailed: 3,
    openGraphAttempted: 9,
    openGraphSucceeded: 7,
    openGraphFallback: 2,
    queued: 9,
    policySkipped: 5,
    postSucceeded: 6,
    postUncertain: 3,
    postDeferred: 1,
    postException: 1,
  });
});

test('formatFleetIntervalSummary uses approved compact denominators and optional post outcomes', () => {
  assert.equal(
    formatFleetIntervalSummary({
      delta: {
        feedPollSucceeded: 1059,
        feedPollFailed: 3,
        openGraphAttempted: 114,
        openGraphSucceeded: 80,
        openGraphFallback: 34,
        queued: 100,
        policySkipped: 10,
        postSucceeded: 95,
        postUncertain: 0,
        postDeferred: 2,
        postException: 1,
      },
      queueDepth: 14,
      feedsFailing: 1,
      rssBytes: 241 * 1024 * 1024,
      ogQueueDepth: 0,
      imageQueueDepth: 0,
    }),
    '5m: feeds 1059/1062 ok · OG 80/114 ok, 34 fallbacks · posts 95/95 ok, 2 deferred, 1 exception · 10 policy-skipped · queue 14 · 1 feed failing · RSS 241.0MB',
  );
});

test('formatFleetIntervalSummary reports n/a for zero attempts and omits zero optional post outcomes', () => {
  assert.equal(
    formatFleetIntervalSummary({
      delta: emptyBotCounters(),
      queueDepth: 0,
      feedsFailing: 0,
      rssBytes: 0,
      ogQueueDepth: 0,
      imageQueueDepth: 0,
    }),
    '5m: feeds n/a · OG n/a, 0 fallbacks · posts n/a · 0 policy-skipped · queue 0 · 0 feeds failing · RSS 0.0MB',
  );
});

test('formatFleetIntervalSummary includes shared-limiter queue depths only when non-zero', () => {
  assert.equal(
    formatFleetIntervalSummary({
      delta: emptyBotCounters(),
      queueDepth: 0,
      feedsFailing: 0,
      rssBytes: 0,
      ogQueueDepth: 5,
      imageQueueDepth: 2,
    }),
    '5m: feeds n/a · OG n/a, 0 fallbacks · posts n/a · 0 policy-skipped · queue 0 · 5 OG queued · 2 image queued · 0 feeds failing · RSS 0.0MB',
  );

  assert.equal(
    formatFleetIntervalSummary({
      delta: emptyBotCounters(),
      queueDepth: 0,
      feedsFailing: 0,
      rssBytes: 0,
      ogQueueDepth: 5,
      imageQueueDepth: 0,
    }),
    '5m: feeds n/a · OG n/a, 0 fallbacks · posts n/a · 0 policy-skipped · queue 0 · 5 OG queued · 0 feeds failing · RSS 0.0MB',
  );
});
