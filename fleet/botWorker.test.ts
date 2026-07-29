import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { BotWorker } from "./botWorker.ts";
import { Scheduler } from "./scheduler.ts";
import type { ParsedItem } from "./feedReader.ts";
import type { PostResult, ResolvedEmbed } from "./bskyClient.ts";
import type { QueueItemRow } from "./botStore.ts";

class FakeFeedReader {
  private handler: ((item: ParsedItem) => void) | null = null;
  public resolvedImageUrls: string[] = [];
  onItem(handler: (item: ParsedItem) => void): void {
    this.handler = handler;
  }
  start(): void {}
  emit(item: ParsedItem): void {
    this.handler?.(item);
  }
  async resolveEmbedImage(imageUrl: string): Promise<Buffer | undefined> {
    this.resolvedImageUrls.push(imageUrl);
    return Buffer.from("fake-image");
  }
}

class FakeBskyClient {
  public posted: { content: string; rkey: string; embed?: ResolvedEmbed }[] = [];
  private nextResult: PostResult = { ok: true, uri: "at://fake/1" };
  setNextResult(result: PostResult): void {
    this.nextResult = result;
  }
  async post(params: { content: string; rkey: string; embed?: ResolvedEmbed }): Promise<PostResult> {
    this.posted.push(params);
    return this.nextResult;
  }
}

// In-memory stand-in for BotStore's queue behavior, matching its real interface shape
// closely enough to exercise BotWorker's drain logic without touching real SQLite.
class FakeBotStore {
  public cursor = "";
  private rows: QueueItemRow[] = [];
  private nextId = 1;

  enqueue(item: {
    title: string;
    content: string;
    embedJson: string | null;
    languagesJson: string | null;
    itemDate: string;
    dedupeKey: string;
  }): number {
    // Match the real BotStore's UNIQUE(dedupe_key) contract: a repeat dedupeKey is
    // silently ignored and reported back as 0, not a real row id.
    if (this.rows.some((r) => r.dedupeKey === item.dedupeKey)) return 0;
    const id = this.nextId++;
    this.rows.push({
      id,
      ...item,
      status: "queued",
      enqueuedAt: new Date().toISOString(),
      publishedAt: null,
    });
    return id;
  }
  listQueued(): QueueItemRow[] {
    return this.rows.filter((r) => r.status === "queued").sort((a, b) => a.itemDate.localeCompare(b.itemDate));
  }
  setQueueItemStatus(id: number, status: QueueItemRow["status"]): void {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.status = status;
  }
  countQueued(): number {
    return this.rows.filter((r) => r.status === "queued").length;
  }
  writeCursor(date: Date): void {
    this.cursor = date.toISOString();
  }
  close(): void {}
}

function makeWorker(t: TestContext, overrides?: { feedReader?: any; bskyClient?: any; store?: any }) {
  const feedReader = overrides?.feedReader ?? new FakeFeedReader();
  const bskyClient = overrides?.bskyClient ?? new FakeBskyClient();
  const store = overrides?.store ?? new FakeBotStore();
  const scheduler = new Scheduler({ minSpacing: 0, maxSpacing: 60, spacingWindow: 600, adaptiveSpacing: false });
  const worker = new BotWorker({
    botId: "test-bot",
    feedReader: feedReader as any,
    scheduler,
    bskyClient: bskyClient as any,
    store: store as any,
    runIntervalSeconds: 60,
    freshnessConfig: { maxCatchupItems: 5, maxItemAgeMinutes: 120 },
    perBotQueueMaxLength: 500,
  });
  t.after(() => worker.stop());
  return { worker, feedReader, bskyClient, store };
}

test("an emitted item is durably queued via BotStore, then drained on the next tick", async (t) => {
  const { worker, bskyClient, store } = makeWorker(t);
  await worker.start();
  assert.equal(worker.queueLength(), 0);

  const now = new Date().toISOString();

  const feedReader = (worker as any).options.feedReader as FakeFeedReader;
  feedReader.emit({ title: "t", content: "hello world", languages: ["en"], itemDate: now, dedupeKey: "key-1" });
  assert.equal(worker.queueLength(), 1);

  await worker.drainOnce();
  assert.equal(worker.queueLength(), 0);
  assert.equal(bskyClient.posted.length, 1);
  assert.equal(bskyClient.posted[0]!.content, "hello world");
  assert.equal(bskyClient.posted[0]!.rkey, "key-1");
  assert.equal(store.cursor, now);
});

test("rkey passed to BskyClient.post matches the item's dedupeKey exactly", async (t) => {
  const { worker, bskyClient } = makeWorker(t);
  await worker.start();
  const feedReader = (worker as any).options.feedReader as FakeFeedReader;
  feedReader.emit({
    title: "t",
    content: "c",
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: "exact-key-xyz",
  });
  await worker.drainOnce();
  assert.equal(bskyClient.posted[0]!.rkey, "exact-key-xyz");
});

test("an embed's imageUrl is resolved via FeedReader.resolveEmbedImage before posting", async (t) => {
  const { worker, bskyClient, feedReader } = makeWorker(t);
  await worker.start();
  const fr = feedReader as FakeFeedReader;
  fr.emit({
    title: "t",
    content: "c",
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: "k",
    embed: { uri: "https://example.com", title: "Example", imageUrl: "https://example.com/img.jpg", type: "card" },
  });
  await worker.drainOnce();
  assert.deepEqual(fr.resolvedImageUrls, ["https://example.com/img.jpg"]);
  assert.ok(bskyClient.posted[0]!.embed?.image);
  assert.equal(bskyClient.posted[0]!.embed?.image!.toString(), "fake-image");
});

test("an embed with no imageUrl posts with embed.image undefined, no resolve call made", async (t) => {
  const { worker, bskyClient, feedReader } = makeWorker(t);
  await worker.start();
  const fr = feedReader as FakeFeedReader;
  fr.emit({
    title: "t",
    content: "c",
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: "k",
    embed: { uri: "https://example.com", title: "Example", type: "card" },
  });
  await worker.drainOnce();
  assert.deepEqual(fr.resolvedImageUrls, []);
  assert.equal(bskyClient.posted[0]!.embed?.image, undefined);
});

test("a rate-limited post leaves the row 'queued', cursor untouched", async (t) => {
  const { worker, bskyClient, store } = makeWorker(t);
  await worker.start();
  const feedReader = (worker as any).options.feedReader as FakeFeedReader;
  feedReader.emit({
    title: "t",
    content: "will be rate limited",
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: "k",
  });
  bskyClient.setNextResult({ ok: false, ratelimit: true, retryAfterSeconds: 30 });
  await worker.drainOnce();

  assert.equal(worker.queueLength(), 1, "item should remain queued, not be lost");
  assert.equal(store.cursor, "", "cursor must not advance for an item that was not actually published");
});

test("an uncertain (non-rate-limit) failure marks the item skipped and continues to the next item", async (t) => {
  const { worker, bskyClient, store } = makeWorker(t);
  await worker.start();
  const feedReader = (worker as any).options.feedReader as FakeFeedReader;
  const now = new Date();
  feedReader.emit({
    title: "a",
    content: "first, will be skipped",
    languages: [],
    itemDate: now.toISOString(),
    dedupeKey: "k1",
  });
  feedReader.emit({
    title: "b",
    content: "second, should still post",
    languages: [],
    itemDate: new Date(now.getTime() + 1000).toISOString(),
    dedupeKey: "k2",
  });

  bskyClient.setNextResult({ ok: false, ratelimit: false });
  await worker.drainOnce();

  // First item: uncertain failure -> skipped, not queued anymore, not published.
  // Second item: setNextResult returns the same static error for every call, so
  // second item also fails with uncertain error. If the loop uses `continue` (correct),
  // it attempts both items and both fail; both are skipped. If it uses `break` (bug),
  // it stops after the first failure and never attempts the second item (still queued).
  assert.equal(store.cursor, "", "cursor must not advance for a skipped, unpublished item");
  assert.equal(bskyClient.posted.length, 2, "both items should be attempted, proving loop continued after first uncertain failure");
  assert.equal(worker.queueLength(), 0, "both items should be marked skipped, proving second item was processed");
});

test("freshness policy skips a stale item at selection time without calling BskyClient", async (t) => {
  const { worker, bskyClient } = makeWorker(t);
  await worker.start();
  const feedReader = (worker as any).options.feedReader as FakeFeedReader;
  const ancient = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(); // 24h ago
  feedReader.emit({ title: "old", content: "stale", languages: [], itemDate: ancient, dedupeKey: "k" });
  await worker.drainOnce();

  assert.equal(bskyClient.posted.length, 0, "a stale item must never reach BskyClient.post");
  assert.equal(worker.queueLength(), 0, "the stale item should be marked skipped, not left queued forever");
});

test("multiple queued items drain in item_date order", async (t) => {
  const { worker, bskyClient } = makeWorker(t);
  await worker.start();
  const feedReader = (worker as any).options.feedReader as FakeFeedReader;
  const now = Date.now();
  feedReader.emit({
    title: "b",
    content: "second",
    languages: [],
    itemDate: new Date(now + 1000).toISOString(),
    dedupeKey: "k2",
  });
  feedReader.emit({
    title: "a",
    content: "first",
    languages: [],
    itemDate: new Date(now).toISOString(),
    dedupeKey: "k1",
  });
  await worker.drainOnce();
  assert.deepEqual(
    bskyClient.posted.map((p) => p.content),
    ["first", "second"]
  );
});

test("a thrown exception from BskyClient.post does not crash drainOnce, item stays queued", async (t) => {
  const { worker } = makeWorker(t, {
    bskyClient: {
      post: async () => {
        throw new Error("unexpected network explosion");
      },
    },
  });
  await worker.start();
  const feedReader = (worker as any).options.feedReader as FakeFeedReader;
  feedReader.emit({ title: "t", content: "boom", languages: [], itemDate: new Date().toISOString(), dedupeKey: "k" });

  await assert.doesNotReject(() => worker.drainOnce());
  assert.equal(worker.queueLength(), 1);
});

test("enqueue drops a new item once the queue is at perBotQueueMaxLength, keeping the existing items", async (t) => {
  const store = new FakeBotStore();
  const feedReader = new FakeFeedReader();
  const bskyClient = new FakeBskyClient();
  const scheduler = new Scheduler({ minSpacing: 0, maxSpacing: 60, spacingWindow: 600, adaptiveSpacing: false });
  const worker = new BotWorker({
    botId: "test-bot",
    feedReader: feedReader as any,
    scheduler,
    bskyClient: bskyClient as any,
    store: store as any,
    runIntervalSeconds: 60,
    freshnessConfig: { maxCatchupItems: 5, maxItemAgeMinutes: 120 },
    perBotQueueMaxLength: 2,
  });
  t.after(() => worker.stop());
  await worker.start();

  feedReader.emit({ title: "a", content: "a", languages: [], itemDate: new Date().toISOString(), dedupeKey: "k1" });
  feedReader.emit({ title: "b", content: "b", languages: [], itemDate: new Date().toISOString(), dedupeKey: "k2" });
  feedReader.emit({ title: "c", content: "c", languages: [], itemDate: new Date().toISOString(), dedupeKey: "k3" });

  assert.equal(worker.queueLength(), 2, "the third item should be dropped, queue stays at the cap");
});

test("shutdown stops the FeedReader immediately, waits for an in-flight drain, then closes the store", async () => {
  let resolvePost: () => void;
  const slowPostPromise = new Promise<void>((resolve) => {
    resolvePost = resolve;
  });
  const bskyClient = {
    posted: [] as { content: string }[],
    async post(params: { content: string }) {
      await slowPostPromise;
      this.posted.push(params);
      return { ok: true, uri: "at://fake/1" };
    },
  };

  let storeClosed = false;
  const store = new FakeBotStore();
  (store as any).close = () => {
    storeClosed = true;
  };

  let feedReaderStopped = false;
  const feedReader = new FakeFeedReader();
  (feedReader as any).stop = () => {
    feedReaderStopped = true;
  };

  const scheduler = new Scheduler({ minSpacing: 0, maxSpacing: 60, spacingWindow: 600, adaptiveSpacing: false });
  const worker = new BotWorker({
    botId: "test-bot",
    feedReader: feedReader as any,
    scheduler,
    bskyClient: bskyClient as any,
    store: store as any,
    runIntervalSeconds: 60,
    freshnessConfig: { maxCatchupItems: 5, maxItemAgeMinutes: 120 },
    perBotQueueMaxLength: 500,
  });
  await worker.start();
  feedReader.emit({ title: "t", content: "c", languages: [], itemDate: new Date().toISOString(), dedupeKey: "k" });

  const drainPromise = worker.drainOnce();
  const shutdownPromise = worker.shutdown(5000);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(feedReaderStopped, true, "feedReader.stop() must be called immediately, not after the drain");
  assert.equal(storeClosed, false, "store must not close while a drain is still in flight");

  resolvePost!();
  await drainPromise;
  await shutdownPromise;
  assert.equal(storeClosed, true, "store must close once the in-flight drain finishes");
});

test("shutdown does not wait past its timeout even if the in-flight drain never finishes", async () => {
  const bskyClient = { post: () => new Promise<never>(() => {}) }; // never resolves
  const store = new FakeBotStore();
  const feedReader = new FakeFeedReader();
  (feedReader as any).stop = () => {};

  const scheduler = new Scheduler({ minSpacing: 0, maxSpacing: 60, spacingWindow: 600, adaptiveSpacing: false });
  const worker = new BotWorker({
    botId: "test-bot",
    feedReader: feedReader as any,
    scheduler,
    bskyClient: bskyClient as any,
    store: store as any,
    runIntervalSeconds: 60,
    freshnessConfig: { maxCatchupItems: 5, maxItemAgeMinutes: 120 },
    perBotQueueMaxLength: 500,
  });
  await worker.start();
  feedReader.emit({ title: "t", content: "c", languages: [], itemDate: new Date().toISOString(), dedupeKey: "k" });

  worker.drainOnce(); // fire and forget - will hang forever on the never-resolving post()
  const start = Date.now();
  await worker.shutdown(200);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `shutdown must not wait past its timeout, took ${elapsed}ms`);
});
