import { test } from "node:test";
import assert from "node:assert/strict";
import { BotWorker } from "./botWorker.ts";
import { Scheduler } from "./scheduler.ts";
import type { ParsedItem } from "./feedReader.ts";
import type { PostResult } from "./bskyClient.ts";

class FakeFeedReader {
  private handler: ((item: ParsedItem) => void) | null = null;
  onItem(handler: (item: ParsedItem) => void): void {
    this.handler = handler;
  }
  start(): void {}
  emit(item: ParsedItem): void {
    this.handler?.(item);
  }
}

class FakeBskyClient {
  public posted: string[] = [];
  private nextResult: PostResult = { ok: true, uri: "at://fake/1" };
  setNextResult(result: PostResult): void {
    this.nextResult = result;
  }
  async post(params: { content: string }): Promise<PostResult> {
    this.posted.push(params.content);
    return this.nextResult;
  }
}

class FakeBotStore {
  public cursor = "";
  writeCursor(date: Date): void {
    this.cursor = date.toISOString();
  }
}

test("an emitted item is queued, then drained on the next tick", async () => {
  const feedReader = new FakeFeedReader();
  const bskyClient = new FakeBskyClient();
  const store = new FakeBotStore();
  const scheduler = new Scheduler({ minSpacing: 0, maxSpacing: 60, spacingWindow: 600, adaptiveSpacing: false });
  const worker = new BotWorker({
    botId: "test-bot",
    feedReader: feedReader as any,
    scheduler,
    bskyClient: bskyClient as any,
    store: store as any,
    runIntervalSeconds: 60,
  });

  await worker.start();
  assert.equal(worker.queueLength(), 0);

  feedReader.emit({ title: "t", content: "hello world", languages: ["en"], itemDate: "2026-01-01T00:00:00.000Z" });
  assert.equal(worker.queueLength(), 1);

  await worker.drainOnce();
  assert.equal(worker.queueLength(), 0);
  assert.deepEqual(bskyClient.posted, ["hello world"]);
  assert.equal(store.cursor, "2026-01-01T00:00:00.000Z");

  worker.stop();
});

test("a rate-limited post is requeued, not dropped", async () => {
  const feedReader = new FakeFeedReader();
  const bskyClient = new FakeBskyClient();
  const store = new FakeBotStore();
  const scheduler = new Scheduler({ minSpacing: 0, maxSpacing: 60, spacingWindow: 600, adaptiveSpacing: false });
  const worker = new BotWorker({
    botId: "test-bot",
    feedReader: feedReader as any,
    scheduler,
    bskyClient: bskyClient as any,
    store: store as any,
    runIntervalSeconds: 60,
  });

  await worker.start();
  feedReader.emit({ title: "t", content: "will be rate limited", languages: ["en"], itemDate: "2026-01-01T00:00:00.000Z" });

  bskyClient.setNextResult({ ok: false, ratelimit: true, retryAfterSeconds: 30 });
  await worker.drainOnce();

  assert.equal(worker.queueLength(), 1, "item should return to the queue, not be lost");
  assert.equal(store.cursor, "", "cursor must not advance for an item that was not actually published");

  worker.stop();
});

test("multiple queued items drain in the order they were queued", async () => {
  const feedReader = new FakeFeedReader();
  const bskyClient = new FakeBskyClient();
  const store = new FakeBotStore();
  const scheduler = new Scheduler({ minSpacing: 0, maxSpacing: 60, spacingWindow: 600, adaptiveSpacing: false });
  const worker = new BotWorker({
    botId: "test-bot",
    feedReader: feedReader as any,
    scheduler,
    bskyClient: bskyClient as any,
    store: store as any,
    runIntervalSeconds: 60,
  });

  await worker.start();
  feedReader.emit({ title: "a", content: "first", languages: [], itemDate: "2026-01-01T00:00:00.000Z" });
  feedReader.emit({ title: "b", content: "second", languages: [], itemDate: "2026-01-02T00:00:00.000Z" });

  await worker.drainOnce();

  assert.deepEqual(bskyClient.posted, ["first", "second"]);
  worker.stop();
});

test("a crash-worthy bug in one worker's drain does not throw past drainOnce", async () => {
  const feedReader = new FakeFeedReader();
  const store = new FakeBotStore();
  const scheduler = new Scheduler({ minSpacing: 0, maxSpacing: 60, spacingWindow: 600, adaptiveSpacing: false });
  const throwingBskyClient = {
    post: async () => {
      throw new Error("unexpected network explosion");
    },
  };
  const worker = new BotWorker({
    botId: "test-bot",
    feedReader: feedReader as any,
    scheduler,
    bskyClient: throwingBskyClient as any,
    store: store as any,
    runIntervalSeconds: 60,
  });

  await worker.start();
  feedReader.emit({ title: "t", content: "boom", languages: [], itemDate: "2026-01-01T00:00:00.000Z" });

  await assert.doesNotReject(() => worker.drainOnce());
  assert.equal(worker.queueLength(), 1, "item stays queued when the post call itself throws unexpectedly");

  worker.stop();
});
