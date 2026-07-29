import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthCoordinator } from "./authCoordinator.ts";
import type { BotSpec } from "./configLoader.ts";
import type { BotWorker } from "./botWorker.ts";

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
    bots: specs,
    staggerSeconds,
    activateBot: async (spec) => fakeWorker(spec.botId),
  });

  const start = Date.now();
  await coordinator.start();
  const elapsedMs = Date.now() - start;

  assert.ok(elapsedMs < staggerSeconds * 1000, "a single bot must not incur a trailing stagger wait");
});

test("stopAll stops every active worker", async () => {
  const specs = [makeSpec("bot-1"), makeSpec("bot-2")];
  const stopped: string[] = [];
  const coordinator = new AuthCoordinator({
    bots: specs,
    staggerSeconds: 0,
    activateBot: async (spec) =>
      ({ botId: spec.botId, stop: () => stopped.push(spec.botId) } as unknown as BotWorker),
  });

  await coordinator.start();
  coordinator.stopAll();

  assert.deepEqual(stopped.sort(), ["bot-1", "bot-2"]);
});
