import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {BotWorker, type BotWorkerOptions} from './botWorker.ts';
import {Scheduler} from './scheduler.ts';
import type {FeedReader, ParsedItem} from './feedReader.ts';
import type {BskyClient, PostResult, ResolvedEmbed} from './bskyClient.ts';
import type {BotStore, QueueItemRow} from './botStore.ts';
import {BotOperations} from './botOperations.ts';
import {FleetLogger, type FleetLogLevel, type FleetLogRecord} from './logging.ts';

class FakeFeedReader {
  private handler: ((item: ParsedItem) => void) | null = null;
  public resolvedImageUrls: string[] = [];
  onItem(handler: (item: ParsedItem) => void): void {
    this.handler = handler;
  }
  start(): void {}
  stop(): void {}
  // Most fixtures here don't care about markdown-link facets - defaulting facets to []
  // when a test doesn't supply it keeps those ~25 call sites unchanged instead of forcing
  // an irrelevant `facets: []` onto every one of them.
  emit(item: Omit<ParsedItem, 'facets'> & Partial<Pick<ParsedItem, 'facets'>>): void {
    this.handler?.({facets: [], ...item});
  }
  async resolveEmbedImage(imageUrl: string): Promise<Buffer | undefined> {
    this.resolvedImageUrls.push(imageUrl);
    return Buffer.from('fake-image');
  }
}

class FakeBskyClient {
  public posted: {content: string; rkey: string; embed?: ResolvedEmbed}[] = [];
  private nextResult: PostResult = {ok: true, uri: 'at://fake/1'};
  setNextResult(result: PostResult): void {
    this.nextResult = result;
  }
  async post(params: {content: string; rkey: string; embed?: ResolvedEmbed}): Promise<PostResult> {
    this.posted.push(params);
    return this.nextResult;
  }
}

// In-memory stand-in for BotStore's queue behavior, matching its real interface shape
// closely enough to exercise BotWorker's drain logic without touching real SQLite.
class FakeBotStore {
  public cursor = '';
  public cleanupCalls: number[] = [];
  private rows: QueueItemRow[] = [];
  private nextId = 1;

  cleanupOldSeenValues(maxAgeHours: number): void {
    this.cleanupCalls.push(maxAgeHours);
  }

  enqueue(item: {
    title: string;
    content: string;
    embedJson: string | null;
    languagesJson: string | null;
    facetsJson: string | null;
    itemDate: string;
    dedupeKey: string;
  }): number {
    // Match the real BotStore's UNIQUE(dedupe_key) contract: a repeat dedupeKey is
    // silently ignored and reported back as 0, not a real row id.
    if (this.rows.some(r => r.dedupeKey === item.dedupeKey)) return 0;
    const id = this.nextId++;
    this.rows.push({
      id,
      ...item,
      status: 'queued',
      enqueuedAt: new Date().toISOString(),
      publishedAt: null,
    });
    return id;
  }
  listQueued(): QueueItemRow[] {
    return this.rows
      .filter(r => r.status === 'queued')
      .sort((a, b) => a.itemDate.localeCompare(b.itemDate));
  }
  setQueueItemStatus(id: number, status: QueueItemRow['status']): void {
    const row = this.rows.find(r => r.id === id);
    if (row) row.status = status;
  }
  countQueued(): number {
    return this.rows.filter(r => r.status === 'queued').length;
  }
  writeCursor(date: Date): void {
    this.cursor = date.toISOString();
  }
  close(): void {}
}

function makeWorker(
  t: TestContext,
  overrides?: {
    feedReader?: FakeFeedReader;
    bskyClient?: FakeBskyClient | {post: (params: {content: string}) => Promise<PostResult>};
    store?: FakeBotStore;
    identityStore?: BotStore;
    scheduler?:
      | Scheduler
      | {
          isEligibleNow: (queueDepth: number) => boolean;
          setRateLimitDeadline: (seconds: number) => void;
          recordPost: () => void;
        };
    freshnessConfig?: {maxCatchupItems: number; maxItemAgeMinutes: number};
    logger?: FleetLogger;
    logLevel?: FleetLogLevel;
    botId?: string;
  },
) {
  const botId = overrides?.botId ?? 'test-bot';
  const feedReader = overrides?.feedReader ?? new FakeFeedReader();
  const bskyClient = overrides?.bskyClient ?? new FakeBskyClient();
  const store = overrides?.store ?? new FakeBotStore();
  const identityStore =
    overrides?.identityStore ?? ({cleanupOldSeenValues: () => undefined} as unknown as BotStore);
  const operations = new BotOperations(botId, () => new Date('2026-08-03T12:00:00.000Z'));
  const records: FleetLogRecord[] = [];
  const logger =
    overrides?.logger ??
    new FleetLogger({
      defaultLevel: overrides?.logLevel ?? 'debug',
      now: () => new Date('2026-08-03T12:00:00.000Z'),
      sink: (_line, record) => records.push(record),
    });
  const scheduler =
    overrides?.scheduler ??
    new Scheduler({minSpacing: 0, maxSpacing: 60, spacingWindow: 600, adaptiveSpacing: false});
  const worker = new BotWorker({
    botId,
    feedReader: feedReader as unknown as FeedReader,
    scheduler: scheduler as unknown as Scheduler,
    bskyClient: bskyClient as unknown as BskyClient,
    store: store as unknown as BotStore,
    identityStore,
    runIntervalSeconds: 60,
    freshnessConfig: overrides?.freshnessConfig ?? {maxCatchupItems: 5, maxItemAgeMinutes: 120},
    perBotQueueMaxLength: 500,
    operations,
    logger,
  });
  t.after(() => worker.stop());
  return {
    worker,
    feedReader,
    bskyClient: bskyClient as FakeBskyClient,
    store,
    operations,
    logger,
    records,
  };
}

test('an emitted item is durably queued via BotStore, then drained on the next tick', async t => {
  const {worker, bskyClient, store, operations} = makeWorker(t);
  await worker.start();
  assert.equal(worker.queueLength(), 0);

  const now = new Date().toISOString();

  const feedReader = (worker as unknown as {options: BotWorkerOptions}).options
    .feedReader as unknown as FakeFeedReader;
  feedReader.emit({
    title: 't',
    content: 'hello world',
    languages: ['en'],
    itemDate: now,
    dedupeKey: 'key-1',
  });
  assert.equal(worker.queueLength(), 1);

  await worker.drainOnce();
  assert.equal(worker.queueLength(), 0);
  assert.equal(bskyClient.posted.length, 1);
  assert.equal(bskyClient.posted[0]!.content, 'hello world');
  assert.equal(bskyClient.posted[0]!.rkey, 'key-1');
  assert.equal(store.cursor, now);
  assert.equal(worker.botId, 'test-bot');
  assert.deepEqual(worker.operationalSnapshot(), operations.snapshot());
  assert.equal(worker.operationalSnapshot().counters.queued, 1);
  assert.equal(worker.operationalSnapshot().counters.postSucceeded, 1);
});

test('drainOnce prunes the identity store after a completed drain pass', async t => {
  const cleanupCalls: number[] = [];
  const identityStore = {
    cleanupOldSeenValues: (maxAgeHours: number) => cleanupCalls.push(maxAgeHours),
  };
  const {worker, feedReader} = makeWorker(t, {
    identityStore: identityStore as unknown as BotStore,
  });
  await worker.start();

  feedReader.emit({
    title: 't',
    content: 'hello world',
    languages: ['en'],
    itemDate: new Date().toISOString(),
    dedupeKey: 'key-1',
  });

  await worker.drainOnce();

  assert.deepEqual(cleanupCalls, [96]);
});

test('drainOnce prunes the identity store even on an empty-queue tick', async t => {
  const cleanupCalls: number[] = [];
  const identityStore = {
    cleanupOldSeenValues: (maxAgeHours: number) => cleanupCalls.push(maxAgeHours),
  };
  const {worker} = makeWorker(t, {
    identityStore: identityStore as unknown as BotStore,
  });
  await worker.start();

  assert.equal(worker.queueLength(), 0);
  await worker.drainOnce();

  assert.deepEqual(cleanupCalls, [96]);
});

test("drainOnce prunes this bot's own per-bot store, not just the shared identity store", async t => {
  // Session task #68: BotStore.cleanupOldSeenValues existed and was tested but was never
  // called from any fleet mode production code path - the per-bot seen_items table grew
  // unboundedly. Mirrors the identityStore cleanup wiring above, at the same unconditional,
  // every-tick placement.
  const {worker, store} = makeWorker(t);
  await worker.start();

  assert.equal(worker.queueLength(), 0);
  await worker.drainOnce();

  assert.deepEqual(store.cleanupCalls, [96]);
});

test("rkey passed to BskyClient.post matches the item's dedupeKey exactly", async t => {
  const {worker, bskyClient} = makeWorker(t);
  await worker.start();
  const feedReader = (worker as unknown as {options: BotWorkerOptions}).options
    .feedReader as unknown as FakeFeedReader;
  feedReader.emit({
    title: 't',
    content: 'c',
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: 'exact-key-xyz',
  });
  await worker.drainOnce();
  assert.equal(bskyClient.posted[0]!.rkey, 'exact-key-xyz');
});

test("an embed's imageUrl is resolved via FeedReader.resolveEmbedImage before posting", async t => {
  const {worker, bskyClient, feedReader} = makeWorker(t);
  await worker.start();
  const fr = feedReader as FakeFeedReader;
  fr.emit({
    title: 't',
    content: 'c',
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: 'k',
    embed: {
      uri: 'https://example.com',
      title: 'Example',
      imageUrl: 'https://example.com/img.jpg',
      type: 'card',
    },
  });
  await worker.drainOnce();
  assert.deepEqual(fr.resolvedImageUrls, ['https://example.com/img.jpg']);
  assert.ok(bskyClient.posted[0]!.embed?.image);
  assert.equal(bskyClient.posted[0]!.embed?.image!.toString(), 'fake-image');
});

test('an embed with no imageUrl posts with embed.image undefined, no resolve call made', async t => {
  const {worker, bskyClient, feedReader} = makeWorker(t);
  await worker.start();
  const fr = feedReader as FakeFeedReader;
  fr.emit({
    title: 't',
    content: 'c',
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: 'k',
    embed: {uri: 'https://example.com', title: 'Example', type: 'card'},
  });
  await worker.drainOnce();
  assert.deepEqual(fr.resolvedImageUrls, []);
  assert.equal(bskyClient.posted[0]!.embed?.image, undefined);
});

test('a rate-limited post leaves the row queued and records one deferred outcome', async t => {
  const {worker, bskyClient, store} = makeWorker(t);
  await worker.start();
  const feedReader = (worker as unknown as {options: BotWorkerOptions}).options
    .feedReader as unknown as FakeFeedReader;
  feedReader.emit({
    title: 't',
    content: 'will be rate limited',
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: 'k',
  });
  bskyClient.setNextResult({ok: false, ratelimit: true, retryAfterSeconds: 30});
  await worker.drainOnce();

  assert.equal(worker.queueLength(), 1, 'item should remain queued, not be lost');
  assert.equal(
    store.cursor,
    '',
    'cursor must not advance for an item that was not actually published',
  );
  assert.equal(worker.operationalSnapshot().counters.postDeferred, 1);
  assert.equal(worker.operationalSnapshot().counters.postUncertain, 0);
});

test('an upload-failure deferral stays queued, pauses once, and never claims rate limiting', async t => {
  let deferredForSeconds: number | undefined;
  const scheduler = {
    isEligibleNow: () => true,
    setRateLimitDeadline: (seconds: number) => {
      deferredForSeconds = seconds;
    },
    recordPost: () => undefined,
  };
  const {worker, bskyClient, feedReader, records} = makeWorker(t, {
    scheduler,
    logLevel: 'summary',
  });
  await worker.start();
  const itemDate = new Date();
  feedReader.emit({
    title: 'first',
    content: 'upload will fail',
    languages: [],
    itemDate: itemDate.toISOString(),
    dedupeKey: 'upload-failure-1',
  });
  feedReader.emit({
    title: 'second',
    content: 'must remain queued',
    languages: [],
    itemDate: new Date(itemDate.getTime() + 1_000).toISOString(),
    dedupeKey: 'upload-failure-2',
  });
  bskyClient.setNextResult({
    ok: false,
    deferralReason: 'upload-failure',
    retryAfterSeconds: 30,
  });

  await worker.drainOnce();

  assert.equal(bskyClient.posted.length, 1);
  assert.equal(worker.queueLength(), 2);
  assert.equal(deferredForSeconds, 30);
  assert.equal(worker.operationalSnapshot().counters.postDeferred, 1);
  assert.equal(worker.operationalSnapshot().counters.postUncertain, 0);
  assert.deepEqual(
    records.filter(record => record.level === 'summary').map(record => record.message),
    ['Blob upload failed; posting deferred for 30 seconds'],
  );
  assert.doesNotMatch(records[0]!.message, /rate limit/i);
});

test('an uncertain failure skips each attempted item and records each outcome exactly once', async t => {
  const {worker, bskyClient, store} = makeWorker(t);
  await worker.start();
  const feedReader = (worker as unknown as {options: BotWorkerOptions}).options
    .feedReader as unknown as FakeFeedReader;
  const now = new Date();
  feedReader.emit({
    title: 'a',
    content: 'first, will be skipped',
    languages: [],
    itemDate: now.toISOString(),
    dedupeKey: 'k1',
  });
  feedReader.emit({
    title: 'b',
    content: 'second, should still post',
    languages: [],
    itemDate: new Date(now.getTime() + 1000).toISOString(),
    dedupeKey: 'k2',
  });

  bskyClient.setNextResult({ok: false, ratelimit: false});
  await worker.drainOnce();

  // First item: uncertain failure -> skipped, not queued anymore, not published.
  // Second item: setNextResult returns the same static error for every call, so
  // second item also fails with uncertain error. If the loop uses `continue` (correct),
  // it attempts both items and both fail; both are skipped. If it uses `break` (bug),
  // it stops after the first failure and never attempts the second item (still queued).
  assert.equal(store.cursor, '', 'cursor must not advance for a skipped, unpublished item');
  assert.equal(
    bskyClient.posted.length,
    2,
    'both items should be attempted, proving loop continued after first uncertain failure',
  );
  assert.equal(
    worker.queueLength(),
    0,
    'both items should be marked skipped, proving second item was processed',
  );
  assert.equal(worker.operationalSnapshot().counters.postUncertain, 2);
  assert.equal(worker.operationalSnapshot().counters.postDeferred, 0);
});

test('a confirmed external success is counted before a failing local published mutation', async t => {
  const store = new FakeBotStore();
  store.setQueueItemStatus = (_id, status) => {
    if (status === 'published') throw new Error('local published mutation failed');
  };
  const {worker, feedReader} = makeWorker(t, {store});
  await worker.start();
  feedReader.emit({
    title: 'confirmed',
    content: 'externally published',
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: 'confirmed-outcome',
  });

  await assert.rejects(() => worker.drainOnce(), /local published mutation failed/);

  assert.equal(worker.queueLength(), 1);
  assert.equal(worker.operationalSnapshot().counters.postSucceeded, 1);
  assert.equal(worker.operationalSnapshot().counters.postUncertain, 0);
  assert.equal(store.cursor, '');
});

test('an uncertain external outcome is counted before a failing local skipped mutation', async t => {
  const store = new FakeBotStore();
  store.setQueueItemStatus = (_id, status) => {
    if (status === 'skipped') throw new Error('local skipped mutation failed');
  };
  const {worker, feedReader, bskyClient} = makeWorker(t, {store});
  await worker.start();
  feedReader.emit({
    title: 'uncertain',
    content: 'external outcome known',
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: 'uncertain-outcome',
  });
  bskyClient.setNextResult({ok: false, ratelimit: false});

  await assert.rejects(() => worker.drainOnce(), /local skipped mutation failed/);

  assert.equal(worker.queueLength(), 1);
  assert.equal(worker.operationalSnapshot().counters.postUncertain, 1);
  assert.equal(worker.operationalSnapshot().counters.postSucceeded, 0);
  assert.equal(store.cursor, '');
});

test('freshness policy skips a stale item at selection time without calling BskyClient', async t => {
  const {worker, bskyClient} = makeWorker(t);
  await worker.start();
  const feedReader = (worker as unknown as {options: BotWorkerOptions}).options
    .feedReader as unknown as FakeFeedReader;
  const ancient = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(); // 24h ago
  feedReader.emit({
    title: 'old',
    content: 'stale',
    languages: [],
    itemDate: ancient,
    dedupeKey: 'k',
  });
  await worker.drainOnce();

  assert.equal(bskyClient.posted.length, 0, 'a stale item must never reach BskyClient.post');
  assert.equal(
    worker.queueLength(),
    0,
    'the stale item should be marked skipped, not left queued forever',
  );
  assert.equal(worker.operationalSnapshot().counters.policySkipped, 1);
});

test('freshness re-check records one policy skip when an item goes stale mid-pass', async t => {
  const freshnessConfig = {maxCatchupItems: 5, maxItemAgeMinutes: 120};
  const scheduler = {
    isEligibleNow: () => {
      freshnessConfig.maxItemAgeMinutes = -1;
      return true;
    },
    setRateLimitDeadline: () => undefined,
    recordPost: () => undefined,
  };
  const {worker, feedReader, bskyClient} = makeWorker(t, {freshnessConfig, scheduler});
  await worker.start();
  feedReader.emit({
    title: 'becomes-stale',
    content: 'not posted',
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: 'mid-pass-stale',
  });
  await worker.drainOnce();

  assert.equal(bskyClient.posted.length, 0);
  assert.equal(worker.queueLength(), 0);
  assert.equal(worker.operationalSnapshot().counters.policySkipped, 1);
});

test('multiple queued items drain in item_date order', async t => {
  const {worker, bskyClient} = makeWorker(t);
  await worker.start();
  const feedReader = (worker as unknown as {options: BotWorkerOptions}).options
    .feedReader as unknown as FakeFeedReader;
  const now = Date.now();
  feedReader.emit({
    title: 'b',
    content: 'second',
    languages: [],
    itemDate: new Date(now + 1000).toISOString(),
    dedupeKey: 'k2',
  });
  feedReader.emit({
    title: 'a',
    content: 'first',
    languages: [],
    itemDate: new Date(now).toISOString(),
    dedupeKey: 'k1',
  });
  await worker.drainOnce();
  assert.deepEqual(
    bskyClient.posted.map((p: {content: string}) => p.content),
    ['first', 'second'],
  );
});

test('a thrown post exception stays queued, records once, and keeps raw detail debug-only for its bot', async t => {
  const records: FleetLogRecord[] = [];
  const logger = new FleetLogger({
    defaultLevel: 'summary',
    sink: (_line, record) => records.push(record),
  });
  logger.replaceOverrides(
    new Map([['test-bot', {level: 'debug', expiresAt: '2099-01-01T00:00:00.000Z'}]]),
  );
  const thrown = new Error('unexpected network explosion');
  thrown.stack = 'Error: unexpected network explosion\n    at only-this-bot.ts:7:9';
  const {worker} = makeWorker(t, {
    logger,
    bskyClient: {
      post: async () => {
        throw thrown;
      },
    },
  });
  await worker.start();
  const feedReader = (worker as unknown as {options: BotWorkerOptions}).options
    .feedReader as unknown as FakeFeedReader;
  feedReader.emit({
    title: 't',
    content: 'boom',
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: 'k',
  });

  await assert.doesNotReject(() => worker.drainOnce());
  assert.equal(worker.queueLength(), 1);
  assert.equal(worker.operationalSnapshot().counters.postException, 1);

  const other = makeWorker(t, {
    botId: 'other-bot',
    logger,
    bskyClient: {
      post: async () => {
        throw new Error('other private failure');
      },
    },
  });
  await other.worker.start();
  other.feedReader.emit({
    title: 'other',
    content: 'other private content',
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: 'other-key',
  });
  await other.worker.drainOnce();

  const summary = records.filter(record => record.level === 'summary');
  assert.equal(summary.length, 2);
  assert.ok(
    summary.every(
      record =>
        !/boom|unexpected network explosion|only-this-bot|other private/.test(record.message),
    ),
  );
  const debug = records.filter(record => record.level === 'debug');
  assert.equal(debug.length, 1);
  assert.equal(debug[0]!.botId, 'test-bot');
  assert.match(debug[0]!.message, /only-this-bot\.ts:7:9/);
});

test('duplicate and capacity-drop enqueue paths do not increment the queued counter', async t => {
  const {worker, feedReader} = makeWorker(t, {store: new FakeBotStore()});
  (worker as unknown as {options: BotWorkerOptions}).options.perBotQueueMaxLength = 2;
  await worker.start();
  const item = {
    title: 'first',
    content: 'one',
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: 'k1',
  };
  feedReader.emit(item);
  feedReader.emit(item);
  feedReader.emit({...item, title: 'second', content: 'two', dedupeKey: 'k2'});
  feedReader.emit({...item, title: 'dropped', content: 'three', dedupeKey: 'k3'});

  assert.equal(worker.queueLength(), 2);
  assert.equal(worker.operationalSnapshot().counters.queued, 2);
});

test('per-item queue and successful-post context is verbose and absent at summary', async t => {
  const summaryRuntime = makeWorker(t, {logLevel: 'summary', botId: 'summary-bot'});
  await summaryRuntime.worker.start();
  summaryRuntime.feedReader.emit({
    title: 'private title',
    content: 'private post content',
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: 'summary-key',
  });
  await summaryRuntime.worker.drainOnce();
  assert.equal(summaryRuntime.records.length, 0);

  const verboseRuntime = makeWorker(t, {logLevel: 'verbose', botId: 'verbose-bot'});
  await verboseRuntime.worker.start();
  verboseRuntime.feedReader.emit({
    title: 'private title',
    content: 'private post content',
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: 'verbose-key',
  });
  await verboseRuntime.worker.drainOnce();
  assert.ok(
    verboseRuntime.records.some(
      record => record.level === 'verbose' && record.message.includes('private title'),
    ),
  );
  assert.ok(
    verboseRuntime.records.some(
      record => record.level === 'verbose' && record.message.includes('private post content'),
    ),
  );
});

test('uncertain and rate-limit summaries omit item content and raw error detail', async t => {
  for (const [botId, result] of [
    ['uncertain-bot', {ok: false, ratelimit: false}],
    ['rate-limit-bot', {ok: false, ratelimit: true, retryAfterSeconds: 17}],
  ] as const) {
    const runtime = makeWorker(t, {logLevel: 'summary', botId});
    await runtime.worker.start();
    runtime.feedReader.emit({
      title: 'private title',
      content: 'private item content',
      languages: [],
      itemDate: new Date().toISOString(),
      dedupeKey: `${botId}-key`,
    });
    runtime.bskyClient.setNextResult(result);
    await runtime.worker.drainOnce();
    assert.equal(runtime.records.length, 1);
    assert.doesNotMatch(
      runtime.records[0]!.message,
      /private title|private item content|raw failure/,
    );
  }
});

test('enqueue drops a new item once the queue is at perBotQueueMaxLength, keeping the existing items', async t => {
  const store = new FakeBotStore();
  const feedReader = new FakeFeedReader();
  const bskyClient = new FakeBskyClient();
  const scheduler = new Scheduler({
    minSpacing: 0,
    maxSpacing: 60,
    spacingWindow: 600,
    adaptiveSpacing: false,
  });
  const worker = new BotWorker({
    botId: 'test-bot',
    feedReader: feedReader as unknown as FeedReader,
    scheduler: scheduler as unknown as Scheduler,
    bskyClient: bskyClient as unknown as BskyClient,
    store: store as unknown as BotStore,
    identityStore: {cleanupOldSeenValues: () => undefined} as unknown as BotStore,
    runIntervalSeconds: 60,
    freshnessConfig: {maxCatchupItems: 5, maxItemAgeMinutes: 120},
    perBotQueueMaxLength: 2,
    operations: new BotOperations('test-bot'),
    logger: new FleetLogger({defaultLevel: 'debug', sink: () => undefined}),
  });
  t.after(() => worker.stop());
  await worker.start();

  feedReader.emit({
    title: 'a',
    content: 'a',
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: 'k1',
  });
  feedReader.emit({
    title: 'b',
    content: 'b',
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: 'k2',
  });
  feedReader.emit({
    title: 'c',
    content: 'c',
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: 'k3',
  });

  assert.equal(worker.queueLength(), 2, 'the third item should be dropped, queue stays at the cap');
});

test('shutdown stops the FeedReader immediately, waits for an in-flight drain, then closes the store', async () => {
  let resolvePost: () => void;
  const slowPostPromise = new Promise<void>(resolve => {
    resolvePost = resolve;
  });
  const bskyClient = {
    posted: [] as {content: string}[],
    async post(params: {content: string}) {
      await slowPostPromise;
      this.posted.push(params);
      return {ok: true, uri: 'at://fake/1'};
    },
  };

  let storeClosed = false;
  const store = new FakeBotStore();
  store.close = () => {
    storeClosed = true;
  };

  let feedReaderStopped = false;
  const feedReader = new FakeFeedReader();
  feedReader.stop = () => {
    feedReaderStopped = true;
  };

  const scheduler = new Scheduler({
    minSpacing: 0,
    maxSpacing: 60,
    spacingWindow: 600,
    adaptiveSpacing: false,
  });
  const worker = new BotWorker({
    botId: 'test-bot',
    feedReader: feedReader as unknown as FeedReader,
    scheduler: scheduler as unknown as Scheduler,
    bskyClient: bskyClient as unknown as BskyClient,
    store: store as unknown as BotStore,
    identityStore: {cleanupOldSeenValues: () => undefined} as unknown as BotStore,
    runIntervalSeconds: 60,
    freshnessConfig: {maxCatchupItems: 5, maxItemAgeMinutes: 120},
    perBotQueueMaxLength: 500,
    operations: new BotOperations('test-bot'),
    logger: new FleetLogger({defaultLevel: 'debug', sink: () => undefined}),
  });
  await worker.start();
  feedReader.emit({
    title: 't',
    content: 'c',
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: 'k',
  });

  const drainPromise = worker.drainOnce();
  const shutdownPromise = worker.shutdown(5000);

  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(
    feedReaderStopped,
    true,
    'feedReader.stop() must be called immediately, not after the drain',
  );
  assert.equal(storeClosed, false, 'store must not close while a drain is still in flight');

  resolvePost!();
  await drainPromise;
  await shutdownPromise;
  assert.equal(storeClosed, true, 'store must close once the in-flight drain finishes');
});

test('shutdown does not wait past its timeout even if the in-flight drain never finishes', async () => {
  const bskyClient = {post: () => new Promise<never>(() => {})}; // never resolves
  const store = new FakeBotStore();
  const feedReader = new FakeFeedReader();
  feedReader.stop = () => {};

  const scheduler = new Scheduler({
    minSpacing: 0,
    maxSpacing: 60,
    spacingWindow: 600,
    adaptiveSpacing: false,
  });
  const worker = new BotWorker({
    botId: 'test-bot',
    feedReader: feedReader as unknown as FeedReader,
    scheduler: scheduler as unknown as Scheduler,
    bskyClient: bskyClient as unknown as BskyClient,
    store: store as unknown as BotStore,
    identityStore: {cleanupOldSeenValues: () => undefined} as unknown as BotStore,
    runIntervalSeconds: 60,
    freshnessConfig: {maxCatchupItems: 5, maxItemAgeMinutes: 120},
    perBotQueueMaxLength: 500,
    operations: new BotOperations('test-bot'),
    logger: new FleetLogger({defaultLevel: 'debug', sink: () => undefined}),
  });
  await worker.start();
  feedReader.emit({
    title: 't',
    content: 'c',
    languages: [],
    itemDate: new Date().toISOString(),
    dedupeKey: 'k',
  });

  void worker.drainOnce(); // fire and forget - will hang forever on the never-resolving post()
  const start = Date.now();
  await worker.shutdown(200);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `shutdown must not wait past its timeout, took ${elapsed}ms`);
});
