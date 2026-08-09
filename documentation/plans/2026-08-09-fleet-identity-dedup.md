# Fleet Identity-Scoped Duplicate Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop fleet mode from posting the same story twice when multiple bot configs share one Bluesky identity, by adding an explicit, early, identity-scoped duplicate check before any OG/image work happens.

**Architecture:** Reuse `fleet/botStore.ts`'s existing `BotStore` class as a second, per-identity instance (one per distinct Bluesky `identifier`, not per bot config), built once at fleet startup and shared by every `FeedReader`/`BotWorker` publishing to that identity. `FeedReader.handleItem()` gets one new unconditional check using `BotStore`'s existing `seenValueExists`/`writeSeenValue`, and `BotWorker.drainOnce()` calls the identity instance's existing `cleanupOldSeenValues(96)` once per drain pass.

**Tech Stack:** TypeScript, `node:sqlite` (already used by `BotStore`), `node:test`.

## Global Constraints

- No new class or schema — the per-identity store is a second `BotStore` instance, using only `seenValueExists(value)`/`writeSeenValue(value)`/`cleanupOldSeenValues(maxAgeHours)`/`close()`.
- Storage path: `data/fleet/identities/<identifier>.sqlite` — flat, no subdirectory.
- The new duplicate check runs unconditionally in `handleItem()`, before the `publishEmbed` block, regardless of a bot's own `publishEmbed`/`removeDuplicate` config.
- The new check reuses `fleet/dedupeKey.ts`'s existing `computeDedupeKey(identifier, url)` — no new key format.
- No backfill/migration script — every identity's store starts empty.
- `cleanupOldSeenValues` uses the existing 96-hour convention (`dbHandler.cleanupOldValues()`, `BotStore.cleanupOldSeenValues()`).
- No new store-level tests — `seenValueExists`/`writeSeenValue`/`cleanupOldSeenValues` are already covered by `fleet/botStore.test.ts`.
- Design reference: `documentation/specs/2026-08-09-fleet-identity-dedup-design.md` (approved, ponytail-reviewed twice, committed at `e44b0d2`).

---

### Task 1: Thread a per-identity BotStore into FeedReader

**Files:**
- Modify: `fleet/feedReader.ts:185-205` (constructor), `fleet/feedReader.ts:282-309` (`handleItem`)
- Modify: `fleet/feedReader.test.ts` (`createInstrumentedReader` helper + 7 raw `new FeedReader(...)` call sites + 2 new regression tests)
- Modify: `fleet/runFleet.ts` (imports, `buildWorker`, `main`, `shutdown`)
- Modify: `fleet/benchmarkHarness.ts:124-149`
- Modify: `fleet/botWorker.ts:11-22` (`BotWorkerOptions` field only — Task 2 adds the behavior that uses it)
- Modify: `fleet/botWorker.test.ts:91-137` (`makeWorker` helper only — Task 2 adds the new test that uses the override)

**Interfaces:**
- Consumes: `BotStore` (`fleet/botStore.ts`) — `seenValueExists(value: string): boolean`, `writeSeenValue(value: string): void`, `close(): void`. `computeDedupeKey(identifier: string, itemUrl: string): string` (`fleet/dedupeKey.ts`, unchanged).
- Produces: `FeedReader`'s constructor gains a required `identityStore: BotStore` parameter, positioned immediately after `store`. `BotWorkerOptions` also gains a required `identityStore: BotStore` field in this task (Step 5b) so `buildWorker`'s `new BotWorker({..., identityStore, ...})` call typechecks immediately — Task 2 only adds the actual `cleanupOldSeenValues` call using that field, so both tasks stay independently green.

- [ ] **Step 1: Add the identity-scoped check to `FeedReader`**

In `fleet/feedReader.ts`, update the constructor (currently lines 185-198):

```ts
  constructor(
    private botId: string,
    // The Bluesky handle this bot config publishes to - deliberately separate from botId.
    // Multiple bot configs (different feeds) can share one identifier, and dedupeKey must
    // be scoped to that shared publishing identity, not to whichever bot config happened
    // to discover an item first - see dedupeKey.ts.
    private identifier: string,
    feedUrl: URL,
    fetchIntervalMinutes: number,
    private config: FeedReaderConfig,
    private store: BotStore,
    // A second BotStore instance, shared by every FeedReader/BotWorker publishing to the
    // same `identifier` (built once per identity in runFleet.ts, not per bot config) - see
    // documentation/specs/2026-08-09-fleet-identity-dedup-design.md. Distinct from `store`,
    // which is this bot config's own private per-bot state.
    private identityStore: BotStore,
    private sharedLimiters: SharedLimiters,
    private runtime: FeedReaderRuntime,
  ) {
```

Then update `handleItem` (currently lines 282-309) to add the new check immediately after the existing `dedupeKey` computation and before `const lastCursor = this.store.readCursor();`:

```ts
    // Link first, then NormalizedItem.id (which is guid-first) - this is the
    // pre-migration precedence. dedupe_key is a persisted UNIQUE column in queue_items
    // and the AT-Proto record key, so flipping to guid-first would recompute a new key
    // for every already-queued item on any feed where guid !== link (e.g. WordPress's
    // <guid isPermaLink="false">), letting it enqueue and post a second time at cutover.
    const dedupeKey = computeDedupeKey(this.identifier, item.link || item.id);

    // Identity-scoped cross-bot duplicate check - runs unconditionally (regardless of
    // this bot's own publishEmbed/removeDuplicate settings), before any OG/image work,
    // so two bot configs sharing one Bluesky identity (different feeds, same account)
    // never both post the same story. See documentation/specs/2026-08-09-fleet-identity-
    // dedup-design.md. The existing per-bot removeDuplicate/staleness logic below is
    // unchanged - this is a second, earlier gate in front of it.
    if (this.identityStore.seenValueExists(dedupeKey)) {
      this.runtime.logger.verbose(
        'FEED',
        `Skipping cross-bot duplicate: ${item.title ?? '(untitled)'} (${itemUrl ?? item.id})`,
        this.botId,
      );
      return;
    }
    this.identityStore.writeSeenValue(dedupeKey);

    const lastCursor = this.store.readCursor();
    let embed: ParsedEmbed | undefined;

    if (this.config.publishEmbed) {
```

(Everything from `if (this.config.publishEmbed) {` onward is unchanged.)

- [ ] **Step 2: Update `createInstrumentedReader` in `fleet/feedReader.test.ts`**

Replace the current helper (lines 71-103):

```ts
function createInstrumentedReader(
  t: {after(callback: () => void): void},
  options: {
    botId?: string;
    identifier?: string;
    identityStore?: BotStore;
    config?: Record<string, unknown>;
    fetchOpenGraph?: (url: string, userAgent: string, timeoutMs: number) => Promise<unknown>;
  } = {},
) {
  const botId = options.botId ?? 'test-bot';
  const identifier = options.identifier ?? botId;
  const dir = mkdtempSync(join(tmpdir(), 'feedreader-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const store = new BotStore(join(dir, 'state.sqlite'));
  t.after(() => store.close());
  const identityStore = options.identityStore ?? new BotStore(join(dir, 'identity.sqlite'));
  if (!options.identityStore) t.after(() => identityStore.close());
  const runtime = createRuntime(botId, options.fetchOpenGraph);
  const reader = new FeedReader(
    botId,
    identifier,
    new URL('http://127.0.0.1:1/feed.xml'),
    5,
    {string: '$title', ...options.config},
    store,
    identityStore,
    new SharedLimiters({
      maxConcurrentOpenGraphFetches: 1,
      maxConcurrentImageJobs: 1,
      maxImageDownloadBytes: 10_000_000,
      httpTimeoutMs: 5000,
    }),
    runtime,
  );
  return {reader, runtime};
}
```

(Only when the caller does NOT pass its own `identityStore` do we register `t.after` to close the one created here — a caller-supplied instance is closed by whoever created it, since it's likely shared across more than one `createInstrumentedReader` call.)

- [ ] **Step 3: Update the 7 raw inline `new FeedReader(...)` call sites in `fleet/feedReader.test.ts`**

Each of these currently constructs a `store` via `mkdtempSync`/`new BotStore(join(dir, 'state.sqlite'))` immediately before the `new FeedReader(...)` call, and passes `'test-bot', 'test-bot', ...` as the first two constructor args. For each, insert an `identityStore` construction right after the existing `store` construction, and add `identityStore,` to the constructor call right after the existing `store,` argument.

Site 1 — `test('a poll with items records a successful feed poll', ...)` (currently around line 534-554):

```ts
  const dir = mkdtempSync(join(tmpdir(), 'feedreader-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const store = new BotStore(join(dir, 'state.sqlite'));
  t.after(() => store.close());
  const identityStore = new BotStore(join(dir, 'identity.sqlite'));
  t.after(() => identityStore.close());
  const runtime = createRuntime();

  const reader = new FeedReader(
    'test-bot',
    'test-bot',
    new URL(`http://127.0.0.1:${port}/feed.xml`),
    60,
    {string: '$title'},
    store,
    identityStore,
    new SharedLimiters({
      maxConcurrentOpenGraphFetches: 1,
      maxConcurrentImageJobs: 1,
      maxImageDownloadBytes: 10_000_000,
      httpTimeoutMs: 5000,
    }),
    runtime,
  );
```

Site 2 — `test('a single bad item is logged but does not affect feed health state', ...)` (currently around line 585-605): identical pattern — add `const identityStore = new BotStore(join(dir, 'identity.sqlite')); t.after(() => identityStore.close());` after the `store` block, add `identityStore,` after `store,` in the constructor call.

Site 3 — `test('an empty feed still records a successful feed poll', ...)` (currently around line 633-653): same pattern.

Site 4 — `test('a feed-fetch failure is recorded and logged per-bot, not an uncaught exception', ...)` (currently around line 671-691): same pattern.

Site 5 — `test('feed failures are summarized once and a later poll records the exact recovery count', ...)` (currently around line 741-762): same pattern.

Site 6 — `test('resolveEmbedImage returns undefined when the response exceeds maxImageDownloadBytes', ...)` (currently around line 953-975): same pattern — note this site's `store` block ends with `t.after(() => store.close());` but has no `runtime` construction directly above the `reader` (runtime is constructed separately below); add the `identityStore` lines right after `t.after(() => store.close());`, and add `identityStore,` after `store,` in the constructor call.

Site 7 — `test('resolveEmbedImage succeeds when the response is within maxImageDownloadBytes', ...)` (currently around line 1002-1023): same pattern as Site 6.

- [ ] **Step 4: Write the two new failing regression tests**

Add these two tests to `fleet/feedReader.test.ts`, immediately after the existing `test('two bot configs with different identifiers compute different dedupeKeys for the same item', ...)` test (which currently ends around line 503, right before `function startFeedResponseServer`):

```ts
test('a duplicate item posted through one FeedReader is skipped by a second FeedReader sharing its identity', async t => {
  // The actual production bug this feature fixes: two bot configs (different feeds,
  // different botIds) sharing one Bluesky identifier must recognize a story the OTHER
  // bot already saw as a duplicate, before either one calls itemHandler for it - not
  // just compute a matching dedupeKey (that's the a435f52 backstop, already covered
  // by the tests above).
  const dir = mkdtempSync(join(tmpdir(), 'feedreader-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const identityStore = new BotStore(join(dir, 'identity.sqlite'));
  t.after(() => identityStore.close());

  const {reader: readerA} = createInstrumentedReader(t, {
    botId: 'trumpwatch-en',
    identifier: 'trumpwatch.skyfleet.blue',
    identityStore,
  });
  const {reader: readerB} = createInstrumentedReader(t, {
    botId: 'trumpnews-en',
    identifier: 'trumpwatch.skyfleet.blue',
    identityStore,
  });
  const emittedA: ParsedItem[] = [];
  const emittedB: ParsedItem[] = [];
  readerA.onItem(item => emittedA.push(item));
  readerB.onItem(item => emittedB.push(item));

  const item = normalizedItem({
    id: 'https://example.test/shared-story',
    link: 'https://example.test/shared-story',
    date: '2026-08-03T12:01:00.000Z',
  });

  await handleItem(readerA, item);
  await handleItem(readerB, item);

  assert.equal(emittedA.length, 1);
  assert.equal(emittedB.length, 0);
});

test('two FeedReaders with different identities sharing one identity store do not cross-block a shared URL', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'feedreader-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const identityStore = new BotStore(join(dir, 'identity.sqlite'));
  t.after(() => identityStore.close());

  const {reader: readerA} = createInstrumentedReader(t, {
    identifier: 'accountA.example',
    identityStore,
  });
  const {reader: readerB} = createInstrumentedReader(t, {
    identifier: 'accountB.example',
    identityStore,
  });
  const emittedA: ParsedItem[] = [];
  const emittedB: ParsedItem[] = [];
  readerA.onItem(item => emittedA.push(item));
  readerB.onItem(item => emittedB.push(item));

  const item = normalizedItem({link: 'https://example.test/same-story'});

  await handleItem(readerA, item);
  await handleItem(readerB, item);

  assert.equal(emittedA.length, 1);
  assert.equal(emittedB.length, 1);
});
```

- [ ] **Step 5: Update `fleet/runFleet.ts`**

Add `join` to the `node:path` import (currently no `node:path` import exists — add a new import line right after `import 'dotenv/config';`):

```ts
import 'dotenv/config';
import {join} from 'node:path';
import {BotStore} from './botStore.ts';
```

Update `buildWorker` (currently lines 22-66) to accept and thread `identityStore`:

```ts
async function buildWorker(
  spec: BotSpec,
  sharedLimiters: SharedLimiters,
  operations: BotOperations,
  logger: FleetLogger,
  dryRun: boolean,
  runIntervalSeconds: number,
  freshnessConfig: FreshnessConfig,
  perBotQueueMaxLength: number,
  identityStore: BotStore,
): Promise<BotWorker> {
  const store = new BotStore(spec.dbPath);
  try {
    const bskyClient = new BskyClient(spec.botId, spec.instanceUrl, store, logger, dryRun);
    await bskyClient.login(spec.identifier, spec.appPassword);

    const feedReader = new FeedReader(
      spec.botId,
      spec.identifier,
      new URL(spec.feedUrl),
      spec.fetchIntervalMinutes,
      spec.feedReaderConfig,
      store,
      identityStore,
      sharedLimiters,
      {operations, logger},
    );

    const worker = new BotWorker({
      botId: spec.botId,
      feedReader,
      scheduler: new Scheduler(spec.schedulerConfig),
      bskyClient,
      store,
      identityStore,
      runIntervalSeconds,
      freshnessConfig,
      perBotQueueMaxLength,
      operations,
      logger,
    });
    await worker.start();
    return worker;
  } catch (err) {
    store.close();
    throw err;
  }
}
```

(`identityStore: BotStore` is added to the object literal passed to `new BotWorker({...})` here. Step 5b below adds the matching field to `BotWorkerOptions` in the same task, so this typechecks cleanly without waiting for Task 2.)

- [ ] **Step 5b: Add `identityStore` to `BotWorkerOptions` (type-only for this task)**

Task 2 is the task that actually *uses* this field (to call `cleanupOldSeenValues`), but the field itself must exist now so Step 5's `new BotWorker({..., identityStore, ...})` call typechecks. In `fleet/botWorker.ts`, update `BotWorkerOptions` (currently lines 11-22):

```ts
export interface BotWorkerOptions {
  botId: string;
  feedReader: FeedReader;
  scheduler: Scheduler;
  bskyClient: BskyClient;
  store: BotStore;
  identityStore: BotStore;
  runIntervalSeconds: number;
  freshnessConfig: FreshnessConfig;
  perBotQueueMaxLength: number;
  operations: BotOperations;
  logger: FleetLogger;
}
```

This makes `identityStore` a required field wherever `BotWorker` is constructed, including `fleet/botWorker.test.ts`'s `makeWorker` helper (used by every existing test in that file). Update `makeWorker` (currently lines 91-137) to accept an optional override and default to a no-op stub, so every existing test keeps passing unchanged:

```ts
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
```

Run: `yarn typecheck && yarn test:fleet`

Expected: both succeed — `botWorker.test.ts`'s existing tests are unaffected by the new stub default.

In `main()`, after the existing bot-loading block (currently lines 104-110: `const {fleetConfig, bots, errors} = loadFleet(...)` through the `for (const error of errors)` loop), add the identity store map and a lazy getter:

```ts
  const identityStores = new Map<string, BotStore>();
  function getIdentityStore(identifier: string): BotStore {
    let store = identityStores.get(identifier);
    if (!store) {
      store = new BotStore(join(dataRoot, 'identities', `${identifier}.sqlite`));
      identityStores.set(identifier, store);
    }
    return store;
  }
```

Update the `activateBot` callback inside `new AuthCoordinator({...})` (currently lines 119-132) to pass the identity store:

```ts
    activateBot: spec => {
      const botOperations = operations.get(spec.botId);
      if (!botOperations) throw new Error(`Missing operational state for ${spec.botId}`);
      return buildWorker(
        spec,
        sharedLimiters,
        botOperations,
        logger,
        dryRun,
        fleetConfig.runIntervalSeconds,
        fleetConfig.freshness,
        fleetConfig.perBotQueueMaxLength,
        getIdentityStore(spec.identifier),
      );
    },
```

Update `shutdown()` (currently lines 154-170) to close every identity store after workers have shut down:

```ts
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.summary('FLEET', `Received ${signal}, shutting down gracefully`);
    clearInterval(healthHeartbeatHandle);
    coordinator.abortActivation();
    operationsRuntime.markStopping();
    operationsRuntime.stop();
    await Promise.race([
      coordinator.shutdownAll(shutdownPerBotTimeoutMs),
      new Promise(resolve => setTimeout(resolve, shutdownOverallTimeoutMs)),
    ]);
    for (const identityStore of identityStores.values()) identityStore.close();
    releaseLock(lockFilePath);
    logger.summary('FLEET', 'Shutdown complete');
    process.exit(0);
  }
```

- [ ] **Step 6: Update `fleet/benchmarkHarness.ts`**

In the `runBenchmark` loop (currently lines 124-149), each synthetic bot gets its own identity (per the existing comment `// synthetic benchmark bots each have their own independent identity`), so give each its own throwaway identity store too, closed via the same existing `stores` array/cleanup loop:

```ts
  for (let i = 0; i < options.botCount; i++) {
    const botId = `bench-bot-${i}`;
    const store = new BotStore(join(tmpDir, `${botId}.sqlite`));
    stores.push(store);
    const identityStore = new BotStore(join(tmpDir, `${botId}-identity.sqlite`));
    stores.push(identityStore);
    const operations = new BotOperations(botId);
    const bskyClient = new BskyClient(botId, 'https://bsky.social', store, logger, true);
    const feedReader = new FeedReader(
      botId,
      botId, // synthetic benchmark bots each have their own independent identity
      new URL(`http://127.0.0.1:${port}/feed`),
      options.fetchIntervalMinutes,
      {
        string: '$title',
        publishEmbed: true,
        embedType: 'card',
        languages: ['en'],
        truncate: true,
        removeDuplicate: true,
        titleClearHTML: false,
        descriptionClearHTML: false,
      },
      store,
      identityStore,
      sharedLimiters,
      {operations, logger},
    );
```

(Pushing `identityStore` onto the existing `stores: BotStore[]` array means it's closed automatically by the existing `for (const store of stores) store.close();` cleanup loop later in the function — no new array or cleanup code needed.)

- [ ] **Step 7: Run the full test suite and typecheck**

Run: `yarn typecheck && yarn test:fleet`

Expected: both commands succeed. `feedReader.test.ts` now has 2 more passing tests than before this task.

- [ ] **Step 8: Commit**

```bash
git add fleet/feedReader.ts fleet/feedReader.test.ts fleet/runFleet.ts fleet/benchmarkHarness.ts fleet/botWorker.ts fleet/botWorker.test.ts
git commit -m "feat(fleet): add identity-scoped duplicate check to FeedReader

Two bot configs sharing one Bluesky identity (different feeds, one
account - e.g. multiple FreshRSS category exports) now share a second
BotStore instance keyed by identifier, checked before any OG/image work.
A cross-bot duplicate is skipped at fetch time instead of being caught
only after a wasted post attempt via the a435f52 rkey-collision backstop,
which stays in place as defense-in-depth."
```

---

### Task 2: Wire identity-store cleanup into BotWorker's drain cycle

**Files:**
- Modify: `fleet/botWorker.ts:230-232` (`drainOnce`'s `finally` block only)
- Modify: `fleet/botWorker.test.ts` (one new test)

**Interfaces:**
- Consumes: `BotStore.cleanupOldSeenValues(maxAgeHours: number): void` (`fleet/botStore.ts`, unchanged). `BotWorkerOptions.identityStore: BotStore` and `makeWorker`'s `identityStore` override (both added by Task 1, Step 5b) — this task only adds the behavior that uses them, no interface changes.

- [ ] **Step 1: Write the failing test**

Add this test to `fleet/botWorker.test.ts`, after the existing `test('an emitted item is durably queued via BotStore, then drained on the next tick', ...)` test — `makeWorker`'s `identityStore` override already exists from Task 1, Step 5b:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:fleet -- --test-name-pattern "drainOnce prunes the identity store"`

Expected: FAIL — nothing in `drainOnce` calls `cleanupOldSeenValues` yet, so `cleanupCalls` stays `[]`, not `[96]`.

- [ ] **Step 3: Implement — call cleanup in `drainOnce`'s `finally` block**

In `fleet/botWorker.ts`, update the `finally` block at the very end of `drainOnce` (currently lines 230-232):

```ts
    } finally {
      // 96-hour retention, matching dbHandler.cleanupOldValues()'s and this same class's
      // own (per-bot) cleanupOldSeenValues() convention. Multiple BotWorkers sharing one
      // identityStore each call this once per drain pass - harmless, a DELETE against an
      // indexed primary key, not worth coordinating away.
      this.options.identityStore.cleanupOldSeenValues(96);
      this.queueRunning = false;
    }
  }
}
```

- [ ] **Step 4: Run the test again to verify it passes**

Run: `yarn test:fleet -- --test-name-pattern "drainOnce prunes the identity store"`

Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `yarn typecheck && yarn test:fleet && yarn lint`

Expected: all three succeed.

- [ ] **Step 6: Commit**

```bash
git add fleet/botWorker.ts fleet/botWorker.test.ts
git commit -m "feat(fleet): prune the identity store on each drain pass

Wires BotStore.cleanupOldSeenValues(96) - already implemented and
tested, just never called for this new per-identity instance - into
BotWorker.drainOnce, matching the existing 96-hour retention convention
dbHandler.cleanupOldValues() established for single-bot mode."
```

---

## Self-Review

**Spec coverage:** Architecture (reuse `BotStore`, unconditional early check) → Task 1. Storage path (`data/fleet/identities/<identifier>.sqlite`) → Task 1, Step 5. Wiring (`runFleet.ts` map + `buildWorker` + shutdown close) → Task 1, Step 5. Backfill (none) → no task needed, nothing to build. Testing (two `feedReader.test.ts` regression tests, no new store-level tests) → Task 1, Step 4. Out of scope (`cleanupOldSeenValues` never called for the *per-bot* store) → correctly NOT addressed by Task 2, which only wires the new *per-identity* instance's cleanup call; tracked separately as session task #68.

**Placeholder scan:** No TBD/TODO. Every step shows complete code, not a description of code.

**Type consistency:** `identityStore: BotStore` is the same name and type across `FeedReader`'s constructor, `BotWorkerOptions`, `buildWorker`'s parameter and both object-literal call sites, `benchmarkHarness.ts`, and `botWorker.test.ts`'s `makeWorker` helper — all added in Task 1, Step 5b, so Task 2 only adds behavior against an interface that already typechecks. `computeDedupeKey`/`seenValueExists`/`writeSeenValue`/`cleanupOldSeenValues` signatures match `fleet/dedupeKey.ts` and `fleet/botStore.ts` exactly as read from source, not from memory.
