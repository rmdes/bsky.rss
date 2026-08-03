import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test, type TestContext} from "node:test";
import type {FleetStatusSnapshot} from "./statusSnapshot.ts";
import {runLogControl} from "./logControl.ts";
import {overridesPath, writeOverrides} from "./logOverrides.ts";
import {statusPath} from "./status.ts";

const fixedNow = new Date("2026-08-03T12:00:00.000Z");

function tempDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "fleet-log-control-"));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return directory;
}

function statusFixture(): FleetStatusSnapshot {
  const counters = {
    feedPollSucceeded: 0,
    feedPollFailed: 0,
    openGraphAttempted: 0,
    openGraphSucceeded: 0,
    openGraphFallback: 0,
    queued: 0,
    policySkipped: 0,
    postSucceeded: 0,
    postUncertain: 0,
    postDeferred: 0,
    postException: 0,
  };
  return {
    schemaVersion: 1,
    phase: "running",
    startedAt: "2026-08-03T11:00:00.000Z",
    heartbeatAt: "2026-08-03T12:00:00.000Z",
    bots: {
      configured: 2,
      active: 2,
      activationFailed: 0,
      configInvalid: 0,
      feedsStarting: 2,
      feedsOk: 0,
      feedsFailing: 0,
    },
    totals: {...counters, queueDepth: 0},
    memory: {rssBytes: 1, heapUsedBytes: 1},
    botStates: ["bot-a", "bot-b"].map((botId) => ({
      botId,
      activationState: "active" as const,
      feedState: "starting" as const,
      lastFeedSuccessAt: null,
      lastFeedFailureAt: null,
      consecutiveFeedFailures: 0,
      lastFeedFailureCategory: null,
      lastPostSuccessAt: null,
      counters: {...counters},
      queueDepth: 0,
      effectiveLogLevel: "summary" as const,
      logOverrideExpiresAt: null,
    })),
  };
}

function writeStatus(dataRoot: string): void {
  writeFileSync(statusPath(dataRoot), JSON.stringify(statusFixture()));
}

test("set accepts every log level, computes expiry, and writes mode 0600", (t) => {
  const dataRoot = tempDirectory(t);
  writeStatus(dataRoot);

  for (const level of ["summary", "verbose", "debug"]) {
    const output = runLogControl(
      ["set", "bot-a", level, "--for", "15m"],
      {dataRoot, now: () => fixedNow}
    );
    const document = JSON.parse(readFileSync(overridesPath(dataRoot), "utf8"));
    assert.deepEqual(document, {
      "bot-a": {level, expiresAt: "2026-08-03T12:15:00.000Z"},
    });
    assert.match(output, new RegExp(`bot-a.*${level}.*2026-08-03T12:15:00.000Z`, "i"));
  }

  assert.equal(statSync(overridesPath(dataRoot)).mode & 0o777, 0o600);
});

test("list prints active bot ID, level, expiry, and remaining duration without rewriting", (t) => {
  const dataRoot = tempDirectory(t);
  const path = overridesPath(dataRoot);
  writeOverrides(path, new Map([
    ["bot-b", {level: "verbose", expiresAt: "2026-08-03T12:01:30.000Z"}],
    ["bot-a", {level: "debug", expiresAt: "2026-08-03T12:15:00.000Z"}],
  ]));
  const inode = statSync(path).ino;

  const output = runLogControl(["list"], {dataRoot, now: () => fixedNow});

  assert.match(output, /bot-a.*debug.*2026-08-03T12:15:00.000Z.*15m/i);
  assert.match(output, /bot-b.*verbose.*2026-08-03T12:01:30.000Z.*1m 30s/i);
  assert.ok(output.indexOf("bot-a") < output.indexOf("bot-b"));
  assert.equal(statSync(path).ino, inode);
});

test("list filters an override expiring exactly now and does not mutate the file", (t) => {
  const dataRoot = tempDirectory(t);
  const path = overridesPath(dataRoot);
  writeOverrides(path, new Map([
    ["bot-a", {level: "debug", expiresAt: fixedNow.toISOString()}],
  ]));
  const before = readFileSync(path, "utf8");
  const inode = statSync(path).ino;

  assert.equal(runLogControl(["list"], {dataRoot, now: () => fixedNow}), "No active log overrides.");
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(statSync(path).ino, inode);
});

test("clear removes the selected override while retaining other active entries", (t) => {
  const dataRoot = tempDirectory(t);
  writeStatus(dataRoot);
  const path = overridesPath(dataRoot);
  writeOverrides(path, new Map([
    ["bot-a", {level: "debug", expiresAt: "2026-08-03T12:15:00.000Z"}],
    ["bot-b", {level: "verbose", expiresAt: "2026-08-03T12:10:00.000Z"}],
  ]));

  const output = runLogControl(["clear", "bot-a"], {dataRoot, now: () => fixedNow});

  assert.match(output, /cleared.*bot-a/i);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    "bot-b": {level: "verbose", expiresAt: "2026-08-03T12:10:00.000Z"},
  });
});

test("set and clear prune expired entries during every successful mutation", (t) => {
  const dataRoot = tempDirectory(t);
  writeStatus(dataRoot);
  const path = overridesPath(dataRoot);
  writeOverrides(path, new Map([
    ["bot-a", {level: "debug", expiresAt: fixedNow.toISOString()}],
  ]));

  runLogControl(["set", "bot-b", "verbose", "--for", "30s"], {
    dataRoot,
    now: () => fixedNow,
  });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    "bot-b": {level: "verbose", expiresAt: "2026-08-03T12:00:30.000Z"},
  });

  runLogControl(["clear", "bot-a"], {dataRoot, now: () => fixedNow});
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    "bot-b": {level: "verbose", expiresAt: "2026-08-03T12:00:30.000Z"},
  });
});

test("rejected syntax, levels, durations, and bot IDs never mutate overrides", (t) => {
  const dataRoot = tempDirectory(t);
  writeStatus(dataRoot);
  const path = overridesPath(dataRoot);
  writeOverrides(path, new Map([
    ["bot-b", {level: "verbose", expiresAt: "2026-08-03T12:10:00.000Z"}],
  ]));
  const original = readFileSync(path, "utf8");
  const originalInode = statSync(path).ino;
  const rejected = [
    [],
    ["list", "extra"],
    ["set", "bot-a", "trace", "--for", "15m"],
    ["set", "bot-a", "debug", "--for", "0s"],
    ["set", "bot-a", "debug", "--for", "1.5m"],
    ["set", "unknown", "debug", "--for", "15m"],
    ["clear"],
    ["clear", "unknown"],
  ];

  for (const args of rejected) {
    assert.throws(() => runLogControl(args, {dataRoot, now: () => fixedNow}));
    assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(statSync(path).ino, originalInode);
  }
});

test("missing or malformed status rejects set and clear without creating or replacing overrides", (t) => {
  const dataRoot = tempDirectory(t);
  const path = overridesPath(dataRoot);

  for (const args of [
    ["set", "bot-a", "debug", "--for", "15m"],
    ["clear", "bot-a"],
  ]) {
    assert.throws(() => runLogControl(args, {dataRoot, now: () => fixedNow}), /status/i);
    assert.equal(existsSync(path), false);
  }

  writeFileSync(statusPath(dataRoot), "{not-json");
  writeOverrides(path, new Map([
    ["bot-b", {level: "verbose", expiresAt: "2026-08-03T12:10:00.000Z"}],
  ]));
  const original = readFileSync(path, "utf8");
  const originalInode = statSync(path).ino;
  for (const args of [
    ["set", "bot-a", "debug", "--for", "15m"],
    ["clear", "bot-a"],
  ]) {
    assert.throws(() => runLogControl(args, {dataRoot, now: () => fixedNow}), /status/i);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(statSync(path).ino, originalInode);
  }
});
