import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FleetLogger,
  formatDebugError,
  parseFleetLogLevel,
} from "./logging.ts";

test("parseFleetLogLevel defaults an unset value to summary", () => {
  assert.equal(parseFleetLogLevel(undefined), "summary");
});

test("parseFleetLogLevel accepts each supported level and rejects other values", () => {
  assert.equal(parseFleetLogLevel("summary"), "summary");
  assert.equal(parseFleetLogLevel("verbose"), "verbose");
  assert.equal(parseFleetLogLevel("debug"), "debug");
  assert.throws(
    () => parseFleetLogLevel("trace"),
    /summary, verbose, debug/,
  );
});

test("a summary logger emits only summary records", () => {
  const records: string[] = [];
  const logger = new FleetLogger({
    defaultLevel: "summary",
    sink: (_line, record) => records.push(record.level),
  });

  logger.summary("worker", "started");
  logger.verbose("worker", "details");
  logger.debug("worker", "diagnostics");

  assert.deepEqual(records, ["summary"]);
});

test("a verbose logger emits summary and verbose records", () => {
  const records: string[] = [];
  const logger = new FleetLogger({
    defaultLevel: "verbose",
    sink: (_line, record) => records.push(record.level),
  });

  logger.summary("worker", "started");
  logger.verbose("worker", "details");
  logger.debug("worker", "diagnostics");

  assert.deepEqual(records, ["summary", "verbose"]);
});

test("a debug logger emits every record level", () => {
  const records: string[] = [];
  const logger = new FleetLogger({
    defaultLevel: "debug",
    sink: (_line, record) => records.push(record.level),
  });

  logger.summary("worker", "started");
  logger.verbose("worker", "details");
  logger.debug("worker", "diagnostics");

  assert.deepEqual(records, ["summary", "verbose", "debug"]);
});

test("a temporary debug override affects only its bot", () => {
  const records: Array<{ level: string; botId?: string }> = [];
  const logger = new FleetLogger({
    defaultLevel: "summary",
    now: () => new Date("2026-08-03T12:00:00.000Z"),
    sink: (_line, record) => records.push(record),
  });
  logger.replaceOverrides(new Map([
    ["bot-a", { level: "debug", expiresAt: "2026-08-03T12:05:00.000Z" }],
  ]));

  logger.debug("worker", "diagnostics", "bot-a");
  logger.debug("worker", "diagnostics", "bot-b");

  assert.deepEqual(records, [{
    level: "debug",
    scope: "worker",
    botId: "bot-a",
    message: "diagnostics",
  }]);
});

test("an expired override is ignored using the injected clock", () => {
  const logger = new FleetLogger({
    defaultLevel: "summary",
    now: () => new Date("2026-08-03T12:00:00.000Z"),
  });
  logger.replaceOverrides(new Map([
    ["bot-a", { level: "debug", expiresAt: "2026-08-03T11:59:59.999Z" }],
  ]));

  assert.equal(logger.overrideFor("bot-a"), undefined);
  assert.equal(logger.effectiveLevel("bot-a"), "summary");
});

test("formatDebugError exposes only Error name message and stack", () => {
  const error = new Error("request failed");
  error.name = "RequestError";
  error.stack = "RequestError: request failed\n    at test";
  Object.assign(error, {
    config: { secret: "config-secret" },
    headers: { authorization: "header-secret" },
    session: "session-secret",
    password: "password-secret",
  });

  const formatted = formatDebugError(error);

  assert.match(formatted, /RequestError/);
  assert.match(formatted, /request failed/);
  assert.match(formatted, /at test/);
  assert.doesNotMatch(formatted, /config-secret|header-secret|session-secret|password-secret/);
});
