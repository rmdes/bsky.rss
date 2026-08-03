import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetStatusSnapshot } from "./statusSnapshot.ts";
import { formatFleetStatus, readFleetStatus, statusPath } from "./status.ts";

const now = new Date("2026-08-03T12:00:00.000Z");

function tempDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "fleet-status-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function statusFixture(overrides: Partial<FleetStatusSnapshot> = {}): FleetStatusSnapshot {
  return {
    schemaVersion: 1,
    phase: "running",
    startedAt: "2026-07-30T08:41:00.000Z",
    heartbeatAt: "2026-08-03T11:59:42.000Z",
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
    memory: { rssBytes: 241 * 1024 * 1024, heapUsedBytes: 80 * 1024 * 1024 },
    botStates: [{
      botId: "bot-safe",
      activationState: "active",
      feedState: "failing",
      lastFeedSuccessAt: "2026-08-03T11:54:00.000Z",
      lastFeedFailureAt: "2026-08-03T11:59:00.000Z",
      consecutiveFeedFailures: 3,
      lastFeedFailureCategory: "http-500",
      lastPostSuccessAt: "2026-08-03T11:45:00.000Z",
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
      effectiveLogLevel: "debug",
      logOverrideExpiresAt: "2026-08-03T12:15:00.000Z",
    }],
    ...overrides,
  };
}

test("statusPath places status.json directly under the data root", () => {
  assert.equal(statusPath("/srv/fleet-data"), "/srv/fleet-data/status.json");
});

test("readFleetStatus reports a missing snapshot without creating it", (t) => {
  const path = join(tempDirectory(t), "status.json");

  assert.throws(() => readFleetStatus(path), /Fleet status not found/);
  assert.equal(existsSync(path), false);
});

test("readFleetStatus rejects malformed JSON", (t) => {
  const path = join(tempDirectory(t), "status.json");
  writeFileSync(path, "{not-json");

  assert.throws(() => readFleetStatus(path), /malformed JSON/);
});

test("readFleetStatus rejects structurally malformed snapshots", (t) => {
  const path = join(tempDirectory(t), "status.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, phase: "running" }));

  assert.throws(() => readFleetStatus(path), /malformed snapshot/);
});

test("readFleetStatus rejects unsupported schema versions", (t) => {
  const path = join(tempDirectory(t), "status.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 2 }));

  assert.throws(() => readFleetStatus(path), /schemaVersion 2.*expected 1/);
});

test("readFleetStatus returns a current schema snapshot", (t) => {
  const path = join(tempDirectory(t), "status.json");
  const expected = statusFixture();
  writeFileSync(path, JSON.stringify(expected));

  assert.deepEqual(readFleetStatus(path), expected);
});

test("formats the approved aggregate current-status output without bot rows", () => {
  const output = formatFleetStatus(statusFixture(), { showBots: false, now });

  assert.equal(output, [
    "Fleet running 4d 3h · heartbeat 18s ago",
    "Bots       59 active · 58 feeds ok · 1 feed failing",
    "Feed polls 10,630 / 10,818 successful (98.26%)",
    "OpenGraph  737 / 990 successful (74.44%) · 253 RSS fallbacks",
    "Posts      867 / 868 terminal outcomes successful (99.88%) · 1 uncertain · 2 deferred · 3 exceptions",
    "Queue      14 waiting · 111 policy-skipped",
    "Memory     241 MB RSS",
  ].join("\n"));
  assert.doesNotMatch(output, /bot-safe/);
});

test("marks a heartbeat older than 150 seconds stale while 150 seconds remains current", () => {
  const exactlyCurrent = formatFleetStatus(statusFixture({
    heartbeatAt: "2026-08-03T11:57:30.000Z",
  }), { showBots: false, now });
  const stale = formatFleetStatus(statusFixture({
    heartbeatAt: "2026-08-03T11:57:29.000Z",
  }), { showBots: false, now });

  assert.match(exactlyCurrent, /^Fleet running /);
  assert.match(stale, /^Fleet stale \(last reported running\) /);
  assert.match(stale, /heartbeat 2m 31s ago/);
});

test("renders a stopping snapshot explicitly", () => {
  const output = formatFleetStatus(statusFixture({ phase: "stopping" }), {
    showBots: false,
    now,
  });

  assert.match(output, /^Fleet stopping /);
  assert.doesNotMatch(output, /^Fleet stale/);
});

test("zero denominators render n/a without NaN or Infinity", () => {
  const snapshot = statusFixture();
  snapshot.totals.feedPollSucceeded = 0;
  snapshot.totals.feedPollFailed = 0;
  snapshot.totals.openGraphAttempted = 0;
  snapshot.totals.openGraphSucceeded = 0;
  snapshot.totals.openGraphFallback = 0;
  snapshot.totals.postSucceeded = 0;
  snapshot.totals.postUncertain = 0;
  const output = formatFleetStatus(snapshot, { showBots: false, now });

  assert.match(output, /Feed polls 0 \/ 0 successful \(n\/a\)/);
  assert.match(output, /OpenGraph  0 \/ 0 successful \(n\/a\)/);
  assert.match(output, /Posts      0 \/ 0 terminal outcomes successful \(n\/a\)/);
  assert.doesNotMatch(output, /NaN|Infinity/);
});

test("bot rows render only approved operational fields", () => {
  const snapshot = statusFixture();
  Object.assign(snapshot.botStates[0]!, {
    feedUrl: "https://private.example/feed.xml",
    identifier: "private.handle",
    title: "private title",
    content: "private content",
    activationError: "private raw login failure",
    token: "private-token",
  });

  const output = formatFleetStatus(snapshot, { showBots: true, now });

  assert.match(output, /Bot bot-safe/);
  assert.match(output, /activation=active/);
  assert.match(output, /feed=failing/);
  assert.match(output, /lastFeedSuccess=2026-08-03T11:54:00.000Z/);
  assert.match(output, /consecutiveFailures=3/);
  assert.match(output, /failureCategory=http-500/);
  assert.match(output, /lastPostSuccess=2026-08-03T11:45:00.000Z/);
  assert.match(output, /queueDepth=4/);
  assert.match(output, /feedPollSucceeded=10/);
  assert.match(output, /feedPollFailed=3/);
  assert.match(output, /openGraphAttempted=2/);
  assert.match(output, /openGraphSucceeded=1/);
  assert.match(output, /openGraphFallback=1/);
  assert.match(output, /queued=5/);
  assert.match(output, /policySkipped=1/);
  assert.match(output, /postSucceeded=4/);
  assert.match(output, /postUncertain=1/);
  assert.match(output, /postDeferred=2/);
  assert.match(output, /postException=3/);
  assert.match(output, /effectiveLogLevel=debug/);
  assert.match(output, /logOverrideExpiresAt=2026-08-03T12:15:00.000Z/);
  assert.doesNotMatch(
    output,
    /private\.example|private\.handle|private title|private content|private raw login failure|private-token/
  );
});

test("the executable rejects unknown or repeated flags with usage", (t) => {
  const dataRoot = tempDirectory(t);
  const cli = join(process.cwd(), "fleet", "status.ts");
  const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const environment = { ...process.env, FLEET_DATA_ROOT: dataRoot, TMPDIR: "/tmp" };

  for (const args of [["--unknown"], ["--bots", "--bots"]]) {
    const result = spawnSync(process.execPath, [tsx, cli, ...args], {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage:.*status\.ts \[--bots\]/);
  }
});
