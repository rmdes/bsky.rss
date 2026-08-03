import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthCoordinator } from "./authCoordinator.ts";
import type { BotSpec } from "./configLoader.ts";
import type { BotWorker } from "./botWorker.ts";
import { FleetLogger, type FleetLogRecord } from "./logging.ts";

function quietLogger(): FleetLogger {
  return new FleetLogger({ defaultLevel: "summary", sink: () => undefined });
}

function makeSpec(botId: string): BotSpec {
  return {
    botId,
    identifier: `${botId}.bsky.social`,
    appPassword: "pw",
    instanceUrl: "https://bsky.social",
    feedUrl: "https://example.com/feed.xml",
    fetchIntervalMinutes: 5,
    dbPath: `/tmp/${botId}.sqlite`,
    feedReaderConfig: { string: "$title", languages: ["en"] },
    schedulerConfig: { adaptiveSpacing: false, spacingWindow: 600, minSpacing: 1, maxSpacing: 60 },
  };
}

function fakeWorker(botId: string): BotWorker {
  return { botId } as unknown as BotWorker;
}

test("activates every bot in order via the injected factory", async () => {
  const specs = [makeSpec("bot-1"), makeSpec("bot-2"), makeSpec("bot-3")];
  const activatedOrder: string[] = [];

  const coordinator = new AuthCoordinator({
    logger: quietLogger(),
    bots: specs,
    staggerSeconds: 0,
    activateBot: async (spec) => {
      activatedOrder.push(spec.botId);
      return fakeWorker(spec.botId);
    },
  });

  await coordinator.start();

  assert.deepEqual(activatedOrder, ["bot-1", "bot-2", "bot-3"]);
  assert.equal(coordinator.activeWorkers().length, 3);
  assert.equal(coordinator.activationFailures().length, 0);
});

test("one bot's activation failure is isolated: the rest still activate", async () => {
  const specs = [makeSpec("bot-1"), makeSpec("bot-2"), makeSpec("bot-3")];

  const coordinator = new AuthCoordinator({
    logger: quietLogger(),
    bots: specs,
    staggerSeconds: 0,
    activateBot: async (spec) => {
      if (spec.botId === "bot-2") throw new Error("login failed");
      return fakeWorker(spec.botId);
    },
  });

  await coordinator.start();

  assert.equal(coordinator.activeWorkers().length, 2);
  assert.deepEqual(
    coordinator.activeWorkers().map((w: any) => w.botId),
    ["bot-1", "bot-3"]
  );
  assert.equal(coordinator.activationFailures().length, 1);
  assert.equal(coordinator.activationFailures()[0]!.botId, "bot-2");
  assert.match(coordinator.activationFailures()[0]!.error, /login failed/);
});

test("waits at least staggerSeconds between activations", async () => {
  const specs = [makeSpec("bot-1"), makeSpec("bot-2")];
  const staggerSeconds = 0.05;

  const coordinator = new AuthCoordinator({
    logger: quietLogger(),
    bots: specs,
    staggerSeconds,
    activateBot: async (spec) => fakeWorker(spec.botId),
  });

  const start = Date.now();
  await coordinator.start();
  const elapsedMs = Date.now() - start;

  assert.ok(elapsedMs >= staggerSeconds * 1000, `expected at least ${staggerSeconds * 1000}ms, got ${elapsedMs}ms`);
});

test("does not wait after the last bot", async () => {
  const specs = [makeSpec("bot-1")];
  const staggerSeconds = 5;

  const coordinator = new AuthCoordinator({
    logger: quietLogger(),
    bots: specs,
    staggerSeconds,
    activateBot: async (spec) => fakeWorker(spec.botId),
  });

  const start = Date.now();
  await coordinator.start();
  const elapsedMs = Date.now() - start;

  assert.ok(elapsedMs < staggerSeconds * 1000, "a single bot must not incur a trailing stagger wait");
});

test("abortActivation stops the loop before activating any not-yet-activated bot", async () => {
  const specs = [makeSpec("bot-1"), makeSpec("bot-2"), makeSpec("bot-3")];
  const coordinator = new AuthCoordinator({
    logger: quietLogger(),
    bots: specs,
    staggerSeconds: 0.05,
    activateBot: async (spec) => fakeWorker(spec.botId),
  });

  const startPromise = coordinator.start();
  await new Promise((resolve) => setTimeout(resolve, 20)); // after bot-1 activates, mid-stagger
  coordinator.abortActivation();
  await startPromise;

  assert.ok(coordinator.activeWorkers().length < 3, "abort must prevent at least one remaining bot from activating");
});

test("abortActivation interrupts an in-progress stagger wait immediately rather than after the full delay", async () => {
  const specs = [makeSpec("bot-1"), makeSpec("bot-2")];
  const coordinator = new AuthCoordinator({
    logger: quietLogger(),
    bots: specs,
    staggerSeconds: 5, // long enough that a real remaining wait would fail this test's timing
    activateBot: async (spec) => fakeWorker(spec.botId),
  });

  const start = Date.now();
  const startPromise = coordinator.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  coordinator.abortActivation();
  await startPromise;
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 1000, `abort should interrupt the stagger wait immediately, took ${elapsed}ms`);
});

test("shutdownAll calls shutdown on every active worker in parallel with the given timeout", async () => {
  const specs = [makeSpec("bot-1"), makeSpec("bot-2")];
  const shutdownCalls: { botId: string; timeoutMs: number }[] = [];
  const coordinator = new AuthCoordinator({
    logger: quietLogger(),
    bots: specs,
    staggerSeconds: 0,
    activateBot: async (spec) =>
      ({
        botId: spec.botId,
        shutdown: async (timeoutMs: number) => {
          shutdownCalls.push({ botId: spec.botId, timeoutMs });
        },
      } as unknown as BotWorker),
  });

  await coordinator.start();
  await coordinator.shutdownAll(1234);

  assert.equal(shutdownCalls.length, 2);
  assert.ok(shutdownCalls.every((c) => c.timeoutMs === 1234));
});

test("activation summaries are privacy-safe while debug retains failure detail and stored status is unchanged", async () => {
  const records: FleetLogRecord[] = [];
  const logger = new FleetLogger({
    defaultLevel: "debug",
    sink: (_line, record) => records.push(record),
  });
  const coordinator = new AuthCoordinator({
    logger,
    bots: [makeSpec("good-bot"), makeSpec("failed-bot")],
    staggerSeconds: 0,
    activateBot: async (spec) => {
      if (spec.botId === "failed-bot") throw new Error("private raw login failure");
      return fakeWorker(spec.botId);
    },
  });

  await coordinator.start();

  const summaries = records.filter((record) => record.level === "summary");
  assert.deepEqual(
    summaries.map((record) => ({ botId: record.botId, message: record.message })),
    [
      { botId: "good-bot", message: "Activated" },
      { botId: "failed-bot", message: "Failed to activate, skipping" },
    ]
  );
  assert.ok(records.some((record) => record.level === "debug" && record.botId === "failed-bot" && record.message.includes("private raw login failure")));
  assert.equal(coordinator.activationFailures()[0]!.error, "Error: private raw login failure");
});
