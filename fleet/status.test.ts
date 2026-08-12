import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {classifyFeedFailure} from './botOperations.ts';
import type {FleetStatusSnapshot} from './statusSnapshot.ts';
import {formatFleetStatus, readFleetStatus, statusPath} from './status.ts';

const now = new Date('2026-08-03T12:00:00.000Z');

function tempDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'fleet-status-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return directory;
}

function statusFixture(overrides: Partial<FleetStatusSnapshot> = {}): FleetStatusSnapshot {
  return {
    schemaVersion: 1,
    phase: 'running',
    startedAt: '2026-07-30T08:41:00.000Z',
    heartbeatAt: '2026-08-03T11:59:42.000Z',
    bots: {
      configured: 59,
      active: 59,
      activationFailed: 0,
      configInvalid: 0,
      feedsStarting: 0,
      feedsOk: 58,
      feedsFailing: 1,
    },
    totals: {
      feedPollSucceeded: 10_630,
      feedPollFailed: 188,
      openGraphAttempted: 990,
      openGraphSucceeded: 737,
      openGraphFallback: 253,
      queued: 1_234,
      policySkipped: 111,
      postSucceeded: 867,
      postUncertain: 1,
      postDeferred: 2,
      postException: 3,
      queueDepth: 14,
    },
    memory: {rssBytes: 241 * 1024 * 1024, heapUsedBytes: 80 * 1024 * 1024},
    limiters: {ogQueueDepth: 3, imageQueueDepth: 2},
    botStates: [
      {
        botId: 'bot-safe',
        activationState: 'active',
        feedState: 'failing',
        lastFeedSuccessAt: '2026-08-03T11:54:00.000Z',
        lastFeedFailureAt: '2026-08-03T11:59:00.000Z',
        consecutiveFeedFailures: 3,
        lastFeedFailureCategory: 'http-500',
        lastPostSuccessAt: '2026-08-03T11:45:00.000Z',
        counters: {
          feedPollSucceeded: 10,
          feedPollFailed: 3,
          openGraphAttempted: 2,
          openGraphSucceeded: 1,
          openGraphFallback: 1,
          queued: 5,
          policySkipped: 1,
          postSucceeded: 4,
          postUncertain: 1,
          postDeferred: 2,
          postException: 3,
        },
        queueDepth: 4,
        effectiveLogLevel: 'debug',
        logOverrideExpiresAt: '2026-08-03T12:15:00.000Z',
      },
    ],
    ...overrides,
  };
}

test('statusPath places status.json directly under the data root', () => {
  assert.equal(statusPath('/srv/fleet-data'), '/srv/fleet-data/status.json');
});

test('readFleetStatus reports a missing snapshot without creating it', t => {
  const path = join(tempDirectory(t), 'status.json');

  assert.throws(() => readFleetStatus(path), /Fleet status not found/);
  assert.equal(existsSync(path), false);
});

test('readFleetStatus rejects malformed JSON', t => {
  const path = join(tempDirectory(t), 'status.json');
  writeFileSync(path, '{not-json');

  assert.throws(() => readFleetStatus(path), /malformed JSON/);
});

test('readFleetStatus rejects structurally malformed snapshots', t => {
  const path = join(tempDirectory(t), 'status.json');
  writeFileSync(path, JSON.stringify({schemaVersion: 1, phase: 'running'}));

  assert.throws(() => readFleetStatus(path), /malformed snapshot/);
});

test('readFleetStatus rejects unsupported schema versions', t => {
  const path = join(tempDirectory(t), 'status.json');
  writeFileSync(path, JSON.stringify({schemaVersion: 2}));

  assert.throws(() => readFleetStatus(path), /schemaVersion 2.*expected 1/);
});

test('readFleetStatus returns a current schema snapshot', t => {
  const path = join(tempDirectory(t), 'status.json');
  const expected = statusFixture();
  writeFileSync(path, JSON.stringify(expected));

  assert.deepEqual(readFleetStatus(path), expected);
});

test('a feed failure classified from a non-integer or negative HTTP status still round-trips through the snapshot validator', t => {
  const path = join(tempDirectory(t), 'status.json');

  for (const status of [-1, 200.5]) {
    const category = classifyFeedFailure({status});
    assert.equal(category, 'other');

    const fixture = statusFixture();
    const snapshot = statusFixture({
      botStates: [{...fixture.botStates[0]!, lastFeedFailureCategory: category}],
    });
    writeFileSync(path, JSON.stringify(snapshot));

    assert.deepEqual(readFleetStatus(path), snapshot);
  }
});

test('formats the approved aggregate current-status output without bot rows', () => {
  const output = formatFleetStatus(statusFixture(), {showBots: false, now});

  assert.equal(
    output,
    [
      'Fleet running 4d 3h · heartbeat 18s ago',
      'Bots       59 active · 58 feeds ok · 1 feed failing',
      'Feed polls 10,630 / 10,818 successful (98.26%)',
      'OpenGraph  737 / 990 successful (74.44%) · 253 RSS fallbacks',
      'Posts      867 / 868 terminal outcomes successful (99.88%) · 1 uncertain · 2 deferred · 3 exceptions',
      'Queue      14 waiting · 111 policy-skipped',
      'Memory     241 MB RSS',
      'Limiters   3 waiting for OG capacity · 2 waiting for image capacity',
    ].join('\n'),
  );
  assert.doesNotMatch(output, /bot-safe/);
});

test('renders zero shared-limiter queue depths without noise', () => {
  const output = formatFleetStatus(
    statusFixture({limiters: {ogQueueDepth: 0, imageQueueDepth: 0}}),
    {showBots: false, now},
  );

  assert.match(output, /^Limiters {3}0 waiting for OG capacity · 0 waiting for image capacity$/m);
});

test('marks a heartbeat older than 150 seconds stale while 150 seconds remains current', () => {
  const exactlyCurrent = formatFleetStatus(
    statusFixture({
      heartbeatAt: '2026-08-03T11:57:30.000Z',
    }),
    {showBots: false, now},
  );
  const stale = formatFleetStatus(
    statusFixture({
      heartbeatAt: '2026-08-03T11:57:29.000Z',
    }),
    {showBots: false, now},
  );

  assert.match(exactlyCurrent, /^Fleet running /);
  assert.match(stale, /^Fleet stale \(last reported running\) /);
  assert.match(stale, /heartbeat 2m 31s ago/);
});

test('a current stopping snapshot preserves stopping and caps final uptime at its heartbeat', () => {
  const output = formatFleetStatus(
    statusFixture({
      phase: 'stopping',
      startedAt: '2026-08-03T11:00:00.000Z',
      heartbeatAt: '2026-08-03T11:59:42.000Z',
    }),
    {
      showBots: false,
      now,
    },
  );

  assert.match(output, /^Fleet stopping 59m 42s · heartbeat 18s ago/);
  assert.doesNotMatch(output, /^Fleet stale/);
});

test('a stale stopping snapshot reports stale while preserving its last stopping phase', () => {
  const output = formatFleetStatus(
    statusFixture({
      phase: 'stopping',
      startedAt: '2026-08-03T11:00:00.000Z',
      heartbeatAt: '2026-08-03T11:57:29.000Z',
    }),
    {
      showBots: false,
      now,
    },
  );

  assert.match(output, /^Fleet stale \(last reported stopping\) 57m 29s · heartbeat 2m 31s ago/);
});

test("a stale snapshot's uptime remains fixed at its last heartbeat", () => {
  const snapshot = statusFixture({
    startedAt: '2026-08-03T11:00:00.000Z',
    heartbeatAt: '2026-08-03T11:57:29.000Z',
  });

  const first = formatFleetStatus(snapshot, {showBots: false, now});
  const later = formatFleetStatus(snapshot, {
    showBots: false,
    now: new Date('2026-08-03T13:00:00.000Z'),
  });

  assert.match(first, /^Fleet stale \(last reported running\) 57m 29s /);
  assert.match(later, /^Fleet stale \(last reported running\) 57m 29s /);
});

test('zero denominators render n/a without NaN or Infinity', () => {
  const snapshot = statusFixture();
  snapshot.totals.feedPollSucceeded = 0;
  snapshot.totals.feedPollFailed = 0;
  snapshot.totals.openGraphAttempted = 0;
  snapshot.totals.openGraphSucceeded = 0;
  snapshot.totals.openGraphFallback = 0;
  snapshot.totals.postSucceeded = 0;
  snapshot.totals.postUncertain = 0;
  const output = formatFleetStatus(snapshot, {showBots: false, now});

  assert.match(output, /Feed polls 0 \/ 0 successful \(n\/a\)/);
  assert.match(output, /OpenGraph {2}0 \/ 0 successful \(n\/a\)/);
  assert.match(output, /Posts {6}0 \/ 0 terminal outcomes successful \(n\/a\)/);
  assert.doesNotMatch(output, /NaN|Infinity/);
});

test('bot rows render the exact approved operational-field allowlist', () => {
  const snapshot = statusFixture();
  Object.assign(snapshot.botStates[0]!, {
    feedUrl: 'https://private.example/feed.xml',
    identifier: 'private.handle',
    title: 'private title',
    content: 'private content',
    activationError: 'private raw login failure',
    token: 'private-token',
  });

  const output = formatFleetStatus(snapshot, {showBots: true, now});

  const botLine = output.split('\n').find(line => line.startsWith('Bot bot-safe'));
  assert.equal(
    botLine,
    [
      'Bot bot-safe',
      'feed=failing',
      'lastFeedSuccess=2026-08-03T11:54:00.000Z',
      'consecutiveFailures=3',
      'failureCategory=http-500',
      'lastPostSuccess=2026-08-03T11:45:00.000Z',
      'queueDepth=4',
      'feedPollSucceeded=10',
      'feedPollFailed=3',
      'openGraphAttempted=2',
      'openGraphSucceeded=1',
      'openGraphFallback=1',
      'queued=5',
      'policySkipped=1',
      'postSucceeded=4',
      'postUncertain=1',
      'postDeferred=2',
      'postException=3',
      'effectiveLogLevel=debug',
      'logOverrideExpiresAt=2026-08-03T12:15:00.000Z',
    ].join(' · '),
  );
  assert.doesNotMatch(output, /activation=|lastFeedFailure=/);
  assert.doesNotMatch(
    output,
    /private\.example|private\.handle|private title|private content|private raw login failure|private-token/,
  );
});

test('the executable rejects unknown or repeated flags with usage', t => {
  const dataRoot = tempDirectory(t);
  const cli = join(process.cwd(), 'fleet', 'status.ts');
  const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const environment = {...process.env, FLEET_DATA_ROOT: dataRoot, TMPDIR: '/tmp'};

  for (const args of [['--unknown'], ['--bots', '--bots']]) {
    const result = spawnSync(process.execPath, [tsx, cli, ...args], {
      cwd: process.cwd(),
      env: environment,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage:.*status\.ts \[--bots\]/);
  }
});
