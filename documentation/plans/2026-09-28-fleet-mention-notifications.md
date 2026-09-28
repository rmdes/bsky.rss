# Fleet Mention/Reply/Quote Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push a phone notification (via the operator's existing `ntfy` server) the first time each fleet account gets a reply, @-mention, or quote-post on Bluesky — never twice for the same one, even across restarts.

**Architecture:** A new pure module, `fleet/notificationWatcher.ts`, polls one bot's Bluesky notifications via a new `BskyClient.listNotifications()` method, dedups against a new `notified_items` table in that bot's existing `state.sqlite` (reusing `BotStore`'s existing seen-value methods, parameterized by table name), and POSTs new ones to `ntfy` with enrichment headers. `BotWorker` owns a second `setInterval` (independent of its existing posting-drain interval) that calls into this module every 5 minutes — started inside `BotWorker.start()`, so it's staggered across the fleet for free by `AuthCoordinator`'s existing sequential bot activation, with zero new scheduling code.

**Tech Stack:** TypeScript (tsx, no build step), `@atproto/api`'s `BskyAgent.app.bsky.notification.listNotifications`, `node:sqlite`, `node:test` + `node:assert/strict`.

## Global Constraints

- **Fleet-only.** `app/` (single-bot mode) is out of scope — do not touch it.
- **Reasons:** exactly `['reply', 'mention', 'quote']` — no likes/reposts/follows.
- **Check interval:** every 5 minutes (300 seconds) per bot, started when that bot activates (no computed offset — `AuthCoordinator`'s existing sequential activation provides the stagger).
- **One shared ntfy topic** — no per-account routing. Config is one `NTFY_URL` env var, e.g. `https://ntfy.rmendes.net/skyfleet`. Unset → that bot's notification-check interval simply never starts; fleet posting is entirely unaffected.
- **Dedup ordering is write-AFTER-confirm**, deliberately the opposite of the identity store's write-before-confirm pattern (`documentation/specs/2026-08-09-fleet-identity-dedup-design.md`): a notification's `uri` is recorded in `notified_items` only *after* the `ntfy` POST actually succeeds. A failed POST leaves it unrecorded, retried next cycle.
- **Rate limits:** reuse `classifyPostError` (in `fleet/bskyClient.ts`) verbatim for `listNotifications` errors — it already correctly classifies a 429 `RateLimitExceeded` / 504 `UpstreamTimeout` via the real `retry-after` header, generic despite its name. A classified rate limit logs at `summary` (not `debug`); the existing 5-minute interval already exceeds any real `retry-after` value, so no new backoff timer is added.
- **Message format** (exact, from the design spec):
  - Title: `New {reply|mention|quote} on @{bot's handle}`
  - Body: `{replier's handle}: "{record text, truncated to 200 chars + …}"`
  - Headers: `X-Title`, `X-Click` (→ the new content via `notification.uri`), `X-Tags` (`speech_balloon`/`loudspeaker`/`repeat`), `X-Actions` (a `view` button to the original post via `notification.reasonSubject`, only when present).
- **URL construction:** derive `https://bsky.app/profile/{did}/post/{rkey}` directly from an AT-URI's own `at://{did}/{collection}/{rkey}` shape — no separate handle lookup needed, bsky.app resolves a DID in a profile URL identically to a handle.
- **No new dependencies.** `fetch`/`Response` are global (Node 24); reuse `createTimeoutFetch` from `shared/http/timeoutFetch.ts`.

---

### Task 1: `BotStore` — `notified_items` table + table-parameterized seen-value methods

**Files:**
- Modify: `fleet/botStore.ts`
- Test: `fleet/botStore.test.ts`

**Interfaces:**
- Produces: `export type SeenTable = 'seen_items' | 'notified_items';` and `seenValueExists(value: string, table?: SeenTable): boolean`, `writeSeenValue(value: string, table?: SeenTable): void`, `cleanupOldSeenValues(maxAgeHours: number, table?: SeenTable): void` — all default to `'seen_items'`, so every existing call site (`feedReader.ts`, `botWorker.ts`, `runFleet.ts`, `legacyImport.ts`) is unaffected without changes.

- [ ] **Step 1: Write the failing tests**

Add to `fleet/botStore.test.ts` (after the existing `cleanupOldSeenValues` test, i.e. after line 94):

```typescript
test('notified_items is a separate table from seen_items, addressed via the table parameter', () => {
  const {store, dir} = makeStore();
  store.writeSeenValue('at://did:plc:abc/app.bsky.feed.post/xyz', 'notified_items');
  assert.equal(store.seenValueExists('at://did:plc:abc/app.bsky.feed.post/xyz', 'notified_items'), true);
  assert.equal(store.seenValueExists('at://did:plc:abc/app.bsky.feed.post/xyz', 'seen_items'), false);
  cleanup(store, dir);
});

test('cleanupOldSeenValues respects the table parameter for notified_items too', () => {
  const {store, dir} = makeStore();
  store.writeSeenValue('old-notification-uri', 'notified_items');
  rawDb(store)
    .prepare("UPDATE notified_items SET seen_at = ? WHERE value = 'old-notification-uri'")
    .run(new Date(Date.now() - 100 * 3600 * 1000).toISOString());
  store.writeSeenValue('recent-notification-uri', 'notified_items');

  store.cleanupOldSeenValues(96, 'notified_items');

  assert.equal(store.seenValueExists('old-notification-uri', 'notified_items'), false);
  assert.equal(store.seenValueExists('recent-notification-uri', 'notified_items'), true);
  cleanup(store, dir);
});

test('existing seen_items callers are unaffected by the new table parameter defaulting', () => {
  const {store, dir} = makeStore();
  store.writeSeenValue('unchanged-call-site');
  assert.equal(store.seenValueExists('unchanged-call-site'), true);
  cleanup(store, dir);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:fleet`
Expected: FAIL — `notified_items` table doesn't exist yet (`SqliteError: no such table: notified_items`), and `seenValueExists`/`writeSeenValue`/`cleanupOldSeenValues` don't yet accept a second argument (TypeScript will also flag this at `yarn typecheck`).

- [ ] **Step 3: Implement**

In `fleet/botStore.ts`, add the new table to the constructor's `CREATE TABLE IF NOT EXISTS` block (after `seen_items`, before `queue_items`):

```typescript
      CREATE TABLE IF NOT EXISTS seen_items (
        value TEXT PRIMARY KEY,
        seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notified_items (
        value TEXT PRIMARY KEY,
        seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS queue_items (
```

Add the exported type near the top of the file, after the `QueueItemRow` interface:

```typescript
export type SeenTable = 'seen_items' | 'notified_items';
```

Replace the three existing methods:

```typescript
  seenValueExists(value: string, table: SeenTable = 'seen_items'): boolean {
    const row = this.db.prepare(`SELECT 1 FROM ${table} WHERE value = ?`).get(value);
    return row !== undefined;
  }

  writeSeenValue(value: string, table: SeenTable = 'seen_items'): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`INSERT OR IGNORE INTO ${table} (value, seen_at) VALUES (?, ?)`)
      .run(value, now);
  }

  listSeenValues(): {value: string; seenAt: string}[] {
    return this.db
      .prepare('SELECT value, seen_at as seenAt FROM seen_items ORDER BY seen_at ASC')
      .all() as {value: string; seenAt: string}[];
  }

  cleanupOldSeenValues(maxAgeHours: number, table: SeenTable = 'seen_items'): void {
    const cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();
    this.db.prepare(`DELETE FROM ${table} WHERE seen_at < ?`).run(cutoff);
  }
```

(`listSeenValues` is unchanged — nothing in this feature needs a listing of `notified_items`, per the design spec's "no notification history UI" non-goal; only `legacyExport.ts` calls it, against `seen_items` only. `table` is restricted to the `SeenTable` literal union, so the string interpolation into SQL has no injection surface — it can only ever be one of the two hardcoded values TypeScript allows.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:fleet && yarn typecheck`
Expected: PASS, all tests including the three new ones; no type errors.

- [ ] **Step 5: Commit**

```bash
git add fleet/botStore.ts fleet/botStore.test.ts
git commit -m "feat(fleet): add notified_items table, parameterize seen-value methods by table"
```

---

### Task 2: `BskyClient.listNotifications()`

**Files:**
- Modify: `fleet/bskyClient.ts`
- Test: `fleet/bskyClient.test.ts`

**Interfaces:**
- Consumes: `classifyPostError(error: unknown): {ratelimit: boolean; retryAfterSeconds: number}` (already exported, unchanged).
- Produces: `export interface ListNotificationsResult { ok: boolean; notifications?: AppBskyNotificationListNotifications.Notification[]; ratelimit?: boolean; retryAfterSeconds?: number; }` and `BskyClient.listNotifications(reasons: string[], limit?: number): Promise<ListNotificationsResult>`.

- [ ] **Step 1: Write the failing tests**

Add to `fleet/bskyClient.test.ts` (after the existing `isAlreadyExistsError` test block, before the TID-regex test comment):

```typescript
function stubListNotifications(
  client: BskyClient,
  impl: () => Promise<{data: {notifications: unknown[]}}>,
): void {
  (
    client as unknown as {
      agent: {app: {bsky: {notification: {listNotifications: typeof impl}}}};
    }
  ).agent.app = {bsky: {notification: {listNotifications: impl}}};
}

test('listNotifications returns ok:true with the raw notifications array on success', async () => {
  const {client} = makeClient('summary');
  const fakeNotifications = [
    {
      uri: 'at://did:plc:a/app.bsky.feed.post/1',
      cid: 'c1',
      author: {did: 'did:plc:a', handle: 'a.bsky.social'},
      reason: 'reply',
      record: {text: 'hi'},
      isRead: false,
      indexedAt: '2026-09-28T00:00:00.000Z',
    },
  ];
  stubListNotifications(client, async () => ({data: {notifications: fakeNotifications}}));

  const result = await client.listNotifications(['reply', 'mention', 'quote']);

  assert.equal(result.ok, true);
  assert.deepEqual(result.notifications, fakeNotifications);
});

test('listNotifications classifies a 429 the same way post() does', async () => {
  const {client} = makeClient('summary');
  const err = makeXRPCError(ResponseType.RateLimitExceeded, {'retry-after': '20'});
  stubListNotifications(client, async () => {
    throw err;
  });

  const result = await client.listNotifications(['reply']);

  assert.equal(result.ok, false);
  assert.equal(result.ratelimit, true);
  assert.equal(result.retryAfterSeconds, 20);
});

test('listNotifications treats a non-rate-limit error as uncertain, not a rate limit', async () => {
  const {client} = makeClient('summary');
  stubListNotifications(client, async () => {
    throw new Error('network down');
  });

  const result = await client.listNotifications(['reply']);

  assert.equal(result.ok, false);
  assert.equal(result.ratelimit, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:fleet`
Expected: FAIL — `client.listNotifications is not a function`.

- [ ] **Step 3: Implement**

In `fleet/bskyClient.ts`, add `AppBskyNotificationListNotifications` to the existing `@atproto/api` import:

```typescript
import {
  BskyAgent,
  RichText,
  AtpSessionEvent,
  AtpSessionData,
  AppBskyFeedPost,
  AppBskyNotificationListNotifications,
  type Facet,
} from '@atproto/api';
```

Add the result type near `PostResult`:

```typescript
export interface ListNotificationsResult {
  ok: boolean;
  notifications?: AppBskyNotificationListNotifications.Notification[];
  ratelimit?: boolean;
  retryAfterSeconds?: number;
}
```

Add the method to the `BskyClient` class, after `post()` and before `logDuration`:

```typescript
  async listNotifications(reasons: string[], limit = 50): Promise<ListNotificationsResult> {
    try {
      const result = await this.agent.app.bsky.notification.listNotifications({reasons, limit});
      return {ok: true, notifications: result.data.notifications};
    } catch (error) {
      this.logger.debug(
        'NOTIFY',
        `listNotifications failed\n${formatDebugError(error)}`,
        this.botId,
      );
      const {ratelimit, retryAfterSeconds} = classifyPostError(error);
      return {ok: false, ratelimit, retryAfterSeconds};
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:fleet && yarn typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add fleet/bskyClient.ts fleet/bskyClient.test.ts
git commit -m "feat(fleet): add BskyClient.listNotifications with rate-limit classification"
```

---

### Task 3: `fleet/notificationWatcher.ts` — dedup, message formatting, ntfy POST

**Files:**
- Create: `fleet/notificationWatcher.ts`
- Test: `fleet/notificationWatcher.test.ts`

**Interfaces:**
- Consumes: `BotStore.seenValueExists/writeSeenValue/cleanupOldSeenValues(value, table?)` (Task 1), `BskyClient.listNotifications` + `ListNotificationsResult` (Task 2), `createTimeoutFetch` (`shared/http/timeoutFetch.ts`, existing), `Logger`/`formatDebugError` (`shared/logging/logger.ts`, existing).
- Produces: `atUriToBskyUrl(uri: string): string`, `buildNtfyMessage(botHandle: string, notification: AppBskyNotificationListNotifications.Notification): {body: string; headers: Record<string, string>}`, `checkBotNotifications(params: CheckBotNotificationsParams): Promise<void>` where `CheckBotNotificationsParams = {botId: string; botHandle: string; bskyClient: Pick<BskyClient, 'listNotifications'>; store: Pick<BotStore, 'seenValueExists' | 'writeSeenValue' | 'cleanupOldSeenValues'>; ntfyUrl: string; logger: Logger; fetchImpl?: typeof fetch}` — this is what Task 4 (`BotWorker`) calls.

- [ ] **Step 1: Write the failing tests**

Create `fleet/notificationWatcher.test.ts`:

```typescript
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {atUriToBskyUrl, buildNtfyMessage, checkBotNotifications} from './notificationWatcher.ts';
import {Logger, type LogRecord} from '../shared/logging/logger.ts';
import type {ListNotificationsResult} from './bskyClient.ts';
import type {AppBskyNotificationListNotifications} from '@atproto/api';

type Notification = AppBskyNotificationListNotifications.Notification;

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    uri: 'at://did:plc:replier/app.bsky.feed.post/reply1',
    cid: 'cid1',
    author: {did: 'did:plc:replier', handle: 'replier.bsky.social'} as Notification['author'],
    reason: 'reply',
    reasonSubject: 'at://did:plc:bot/app.bsky.feed.post/original1',
    record: {text: 'hello there'},
    isRead: false,
    indexedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

class FakeBskyClient {
  private result: ListNotificationsResult = {ok: true, notifications: []};
  public calls = 0;
  setResult(result: ListNotificationsResult): void {
    this.result = result;
  }
  async listNotifications(): Promise<ListNotificationsResult> {
    this.calls++;
    return this.result;
  }
}

class FakeStore {
  private seen = new Map<string, Set<string>>();
  private bucket(table: string): Set<string> {
    let b = this.seen.get(table);
    if (!b) {
      b = new Set();
      this.seen.set(table, b);
    }
    return b;
  }
  seenValueExists(value: string, table = 'seen_items'): boolean {
    return this.bucket(table).has(value);
  }
  writeSeenValue(value: string, table = 'seen_items'): void {
    this.bucket(table).add(value);
  }
  cleanupOldSeenValues(): void {}
}

function makeLogger(): {logger: Logger; records: LogRecord[]} {
  const records: LogRecord[] = [];
  const logger = new Logger({defaultLevel: 'debug', sink: (_line, record) => records.push(record)});
  return {logger, records};
}

test('atUriToBskyUrl converts an AT-URI into the bsky.app web URL', () => {
  assert.equal(
    atUriToBskyUrl('at://did:plc:abc123/app.bsky.feed.post/3jxyz'),
    'https://bsky.app/profile/did:plc:abc123/post/3jxyz',
  );
});

test('buildNtfyMessage builds title/body/headers for a reply, truncating long text', () => {
  const notification = makeNotification({record: {text: 'x'.repeat(250)}});
  const message = buildNtfyMessage('bot.skyfleet.blue', notification);
  assert.equal(message.headers['X-Title'], 'New reply on @bot.skyfleet.blue');
  assert.equal(message.headers['X-Tags'], 'speech_balloon');
  assert.equal(message.headers['X-Click'], 'https://bsky.app/profile/did:plc:replier/post/reply1');
  assert.equal(
    message.headers['X-Actions'],
    'view, Open original post, https://bsky.app/profile/did:plc:bot/post/original1',
  );
  assert.equal(message.body, `replier.bsky.social: "${'x'.repeat(200)}…"`);
});

test('buildNtfyMessage omits X-Actions when reasonSubject is absent', () => {
  const notification = makeNotification({reason: 'mention', reasonSubject: undefined});
  const message = buildNtfyMessage('bot.skyfleet.blue', notification);
  assert.equal(message.headers['X-Tags'], 'loudspeaker');
  assert.equal('X-Actions' in message.headers, false);
});

test('buildNtfyMessage tags a quote with repeat', () => {
  const notification = makeNotification({reason: 'quote'});
  const message = buildNtfyMessage('bot.skyfleet.blue', notification);
  assert.equal(message.headers['X-Tags'], 'repeat');
});

test('checkBotNotifications skips a notification already recorded as sent', async () => {
  const bskyClient = new FakeBskyClient();
  const notification = makeNotification();
  bskyClient.setResult({ok: true, notifications: [notification]});
  const store = new FakeStore();
  store.writeSeenValue(notification.uri, 'notified_items');
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return new Response(null, {status: 200});
  };
  const {logger} = makeLogger();

  await checkBotNotifications({
    botId: 'b',
    botHandle: 'b.bsky.social',
    bskyClient,
    store,
    ntfyUrl: 'https://ntfy.example/topic',
    logger,
    fetchImpl,
  });

  assert.equal(fetchCalls, 0);
});

test('checkBotNotifications posts to ntfy and records the uri only after a successful POST', async () => {
  const bskyClient = new FakeBskyClient();
  const notification = makeNotification();
  bskyClient.setResult({ok: true, notifications: [notification]});
  const store = new FakeStore();
  const calls: {url: string; init: RequestInit}[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({url, init});
    return new Response(null, {status: 200});
  };
  const {logger} = makeLogger();

  await checkBotNotifications({
    botId: 'b',
    botHandle: 'b.bsky.social',
    bskyClient,
    store,
    ntfyUrl: 'https://ntfy.example/topic',
    logger,
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://ntfy.example/topic');
  assert.equal(store.seenValueExists(notification.uri, 'notified_items'), true);
});

test('one failed ntfy POST does not block the rest of the batch, and is not recorded', async () => {
  const bskyClient = new FakeBskyClient();
  const failing = makeNotification({uri: 'at://did:plc:replier/app.bsky.feed.post/fail'});
  const succeeding = makeNotification({uri: 'at://did:plc:replier/app.bsky.feed.post/ok'});
  bskyClient.setResult({ok: true, notifications: [failing, succeeding]});
  const store = new FakeStore();
  let call = 0;
  const fetchImpl = async () => {
    call++;
    return call === 1 ? new Response(null, {status: 500}) : new Response(null, {status: 200});
  };
  const {logger} = makeLogger();

  await checkBotNotifications({
    botId: 'b',
    botHandle: 'b.bsky.social',
    bskyClient,
    store,
    ntfyUrl: 'https://ntfy.example/topic',
    logger,
    fetchImpl,
  });

  assert.equal(call, 2);
  assert.equal(store.seenValueExists(failing.uri, 'notified_items'), false);
  assert.equal(store.seenValueExists(succeeding.uri, 'notified_items'), true);
});

test('a failed send is retried on the next call (its uri was never recorded)', async () => {
  const bskyClient = new FakeBskyClient();
  const notification = makeNotification();
  bskyClient.setResult({ok: true, notifications: [notification]});
  const store = new FakeStore();
  let call = 0;
  const fetchImpl = async () => {
    call++;
    return new Response(null, {status: call === 1 ? 500 : 200});
  };
  const {logger} = makeLogger();
  const params = {
    botId: 'b',
    botHandle: 'b.bsky.social',
    bskyClient,
    store,
    ntfyUrl: 'https://ntfy.example/topic',
    logger,
    fetchImpl,
  };

  await checkBotNotifications(params);
  assert.equal(store.seenValueExists(notification.uri, 'notified_items'), false);

  await checkBotNotifications(params);
  assert.equal(store.seenValueExists(notification.uri, 'notified_items'), true);
  assert.equal(call, 2);
});

test('a rate-limited listNotifications logs a summary line and sends nothing', async () => {
  const bskyClient = new FakeBskyClient();
  bskyClient.setResult({ok: false, ratelimit: true, retryAfterSeconds: 20});
  const store = new FakeStore();
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return new Response(null, {status: 200});
  };
  const {logger, records} = makeLogger();

  await checkBotNotifications({
    botId: 'b',
    botHandle: 'b.bsky.social',
    bskyClient,
    store,
    ntfyUrl: 'https://ntfy.example/topic',
    logger,
    fetchImpl,
  });

  assert.equal(fetchCalls, 0);
  assert.ok(records.some(r => r.level === 'summary' && /rate limit/i.test(r.message)));
});

test('a non-rate-limit listNotifications failure is logged at debug only, sends nothing', async () => {
  const bskyClient = new FakeBskyClient();
  bskyClient.setResult({ok: false, ratelimit: false});
  const store = new FakeStore();
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return new Response(null, {status: 200});
  };
  const {logger, records} = makeLogger();

  await checkBotNotifications({
    botId: 'b',
    botHandle: 'b.bsky.social',
    bskyClient,
    store,
    ntfyUrl: 'https://ntfy.example/topic',
    logger,
    fetchImpl,
  });

  assert.equal(fetchCalls, 0);
  assert.equal(records.filter(r => r.level === 'summary').length, 0);
  assert.ok(records.some(r => r.level === 'debug'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:fleet`
Expected: FAIL — `Cannot find module './notificationWatcher.ts'`.

- [ ] **Step 3: Implement**

Create `fleet/notificationWatcher.ts`:

```typescript
import type {BskyClient} from './bskyClient.ts';
import type {BotStore} from './botStore.ts';
import {Logger, formatDebugError} from '../shared/logging/logger.ts';
import {createTimeoutFetch} from '../shared/http/timeoutFetch.ts';
import type {AppBskyNotificationListNotifications} from '@atproto/api';

// ntfy is a lightweight external service, not our own PDS - 10s is plenty and keeps a
// stalled request from blocking the 5-minute check cycle for long.
const NTFY_TIMEOUT_MS = 10_000;
const NOTIFIED_TABLE = 'notified_items' as const;
const BODY_TRUNCATE_LENGTH = 200;

const REASON_TAGS: Record<string, string> = {
  reply: 'speech_balloon',
  mention: 'loudspeaker',
  quote: 'repeat',
};

/**
 * Converts an AT-URI (at://<did>/<collection>/<rkey>) into the bsky.app web URL for that
 * record. bsky.app resolves a DID in a profile URL exactly like a handle, so this needs no
 * separate handle lookup for the linked post's author.
 */
export function atUriToBskyUrl(uri: string): string {
  const [did, , rkey] = uri.replace('at://', '').split('/');
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

export interface NtfyMessage {
  body: string;
  headers: Record<string, string>;
}

export function buildNtfyMessage(
  botHandle: string,
  notification: AppBskyNotificationListNotifications.Notification,
): NtfyMessage {
  const text = typeof notification.record.text === 'string' ? notification.record.text : '';
  const truncated =
    text.length > BODY_TRUNCATE_LENGTH ? `${text.slice(0, BODY_TRUNCATE_LENGTH)}…` : text;

  const headers: Record<string, string> = {
    'X-Title': `New ${notification.reason} on @${botHandle}`,
    'X-Click': atUriToBskyUrl(notification.uri),
    'X-Tags': REASON_TAGS[notification.reason] ?? 'bell',
  };
  if (notification.reasonSubject) {
    headers['X-Actions'] =
      `view, Open original post, ${atUriToBskyUrl(notification.reasonSubject)}`;
  }

  return {body: `${notification.author.handle}: "${truncated}"`, headers};
}

export interface CheckBotNotificationsParams {
  botId: string;
  botHandle: string;
  bskyClient: Pick<BskyClient, 'listNotifications'>;
  store: Pick<BotStore, 'seenValueExists' | 'writeSeenValue' | 'cleanupOldSeenValues'>;
  ntfyUrl: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export async function checkBotNotifications(params: CheckBotNotificationsParams): Promise<void> {
  const {botId, botHandle, bskyClient, store, ntfyUrl, logger} = params;
  const fetchImpl = params.fetchImpl ?? createTimeoutFetch(NTFY_TIMEOUT_MS);

  store.cleanupOldSeenValues(96, NOTIFIED_TABLE);

  const result = await bskyClient.listNotifications(['reply', 'mention', 'quote']);
  if (!result.ok) {
    if (result.ratelimit) {
      logger.summary('NOTIFY', 'listNotifications rate limited, skipping this cycle', botId);
    } else {
      logger.debug('NOTIFY', 'listNotifications failed, skipping this cycle', botId);
    }
    return;
  }

  for (const notification of result.notifications ?? []) {
    if (store.seenValueExists(notification.uri, NOTIFIED_TABLE)) continue;

    const message = buildNtfyMessage(botHandle, notification);
    try {
      const response = await fetchImpl(ntfyUrl, {
        method: 'POST',
        body: message.body,
        headers: message.headers,
      });
      if (!response.ok) {
        logger.debug('NOTIFY', `ntfy POST failed with status ${response.status}`, botId);
        continue;
      }
    } catch (error) {
      logger.debug('NOTIFY', `ntfy POST failed\n${formatDebugError(error)}`, botId);
      continue;
    }
    store.writeSeenValue(notification.uri, NOTIFIED_TABLE);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:fleet && yarn typecheck`
Expected: PASS, all 11 new tests.

- [ ] **Step 5: Commit**

```bash
git add fleet/notificationWatcher.ts fleet/notificationWatcher.test.ts
git commit -m "feat(fleet): add notificationWatcher — dedup, ntfy formatting, rate-limit handling"
```

---

### Task 4: Wire the notification-check interval into `BotWorker`

**Files:**
- Modify: `fleet/botWorker.ts`
- Test: `fleet/botWorker.test.ts`

**Interfaces:**
- Consumes: `checkBotNotifications` (Task 3), `BskyClient.listNotifications`/`ListNotificationsResult` (Task 2).
- Produces: `BotWorkerOptions.ntfyUrl?: string`, `BotWorkerOptions.botHandle?: string`, `BotWorker.checkNotificationsOnce(): Promise<void>` (public, mirrors `drainOnce()` — directly testable, also what the new interval calls).

- [ ] **Step 1: Write the failing tests**

In `fleet/botWorker.test.ts`, extend the imports and fakes. Replace the `FakeBskyClient` class (lines 32-42) with:

```typescript
class FakeBskyClient {
  public posted: {content: string; rkey: string; embed?: ResolvedEmbed}[] = [];
  public notificationChecks = 0;
  private nextResult: PostResult = {ok: true, uri: 'at://fake/1'};
  private notificationsResult: ListNotificationsResult = {ok: true, notifications: []};
  setNextResult(result: PostResult): void {
    this.nextResult = result;
  }
  setNotificationsResult(result: ListNotificationsResult): void {
    this.notificationsResult = result;
  }
  async post(params: {content: string; rkey: string; embed?: ResolvedEmbed}): Promise<PostResult> {
    this.posted.push(params);
    return this.nextResult;
  }
  async listNotifications(): Promise<ListNotificationsResult> {
    this.notificationChecks++;
    return this.notificationsResult;
  }
}
```

Add `ListNotificationsResult` to the existing `bskyClient.ts` type import (line 7):

```typescript
import type {BskyClient, PostResult, ResolvedEmbed, ListNotificationsResult} from './bskyClient.ts';
```

In `makeWorker`'s `overrides` parameter type, add two fields (after `botId?: string;`):

```typescript
    ntfyUrl?: string;
    botHandle?: string;
```

In `makeWorker`'s body, add to the `new BotWorker({...})` call (after `logger,`):

```typescript
    ntfyUrl: overrides?.ntfyUrl,
    botHandle: overrides?.botHandle,
```

Then add these new tests at the end of the file:

```typescript
test('checkNotificationsOnce calls through to bskyClient.listNotifications when ntfyUrl is configured', async t => {
  const {worker, bskyClient} = makeWorker(t, {
    ntfyUrl: 'https://ntfy.example/topic',
    botHandle: 'bot.bsky.social',
  });
  await worker.start();
  await worker.checkNotificationsOnce();
  assert.equal(bskyClient.notificationChecks, 1);
});

test('checkNotificationsOnce is a no-op when ntfyUrl is not configured', async t => {
  const {worker, bskyClient} = makeWorker(t);
  await worker.start();
  await worker.checkNotificationsOnce();
  assert.equal(bskyClient.notificationChecks, 0);
});

test('start() creates a notification-check interval only when ntfyUrl is configured', async t => {
  const withNtfy = makeWorker(t, {ntfyUrl: 'https://ntfy.example/topic', botHandle: 'bot.bsky.social'});
  await withNtfy.worker.start();
  assert.notEqual(
    (withNtfy.worker as unknown as {notificationIntervalHandle: unknown}).notificationIntervalHandle,
    null,
  );

  const withoutNtfy = makeWorker(t);
  await withoutNtfy.worker.start();
  assert.equal(
    (withoutNtfy.worker as unknown as {notificationIntervalHandle: unknown}).notificationIntervalHandle,
    null,
  );
});

test('shutdown does not hang when a notification-check interval is active', async t => {
  const {worker} = makeWorker(t, {ntfyUrl: 'https://ntfy.example/topic', botHandle: 'bot.bsky.social'});
  await worker.start();
  const start = Date.now();
  await worker.shutdown(1000);
  assert.ok(Date.now() - start < 1000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:fleet`
Expected: FAIL — `worker.checkNotificationsOnce is not a function`, and `notificationIntervalHandle` is `undefined` not present.

- [ ] **Step 3: Implement**

In `fleet/botWorker.ts`, add the import:

```typescript
import {checkBotNotifications} from './notificationWatcher.ts';
```

Add two fields to `BotWorkerOptions` (after `logger: Logger;`):

```typescript
  ntfyUrl?: string;
  botHandle?: string;
```

Add a private field and constant to the class (after `private intervalHandle: NodeJS.Timeout | null = null;`):

```typescript
  private notificationIntervalHandle: NodeJS.Timeout | null = null;
  private static readonly NOTIFICATION_CHECK_INTERVAL_MS = 300_000;
```

Update `start()`:

```typescript
  async start(): Promise<void> {
    this.options.feedReader.onItem((item: ParsedItem) => this.enqueue(item));
    this.options.feedReader.start();
    this.intervalHandle = setInterval(() => {
      this.drainOnce().catch(err => {
        this.options.logger.summary('QUEUE', 'Unexpected error during drain', this.botId);
        this.options.logger.debug('QUEUE', formatDebugError(err), this.botId);
      });
    }, this.options.runIntervalSeconds * 1000);

    if (this.options.ntfyUrl) {
      this.notificationIntervalHandle = setInterval(() => {
        this.checkNotificationsOnce().catch(err => {
          this.options.logger.summary('NOTIFY', 'Unexpected error checking notifications', this.botId);
          this.options.logger.debug('NOTIFY', formatDebugError(err), this.botId);
        });
      }, BotWorker.NOTIFICATION_CHECK_INTERVAL_MS);
    }
  }

  async checkNotificationsOnce(): Promise<void> {
    if (!this.options.ntfyUrl) return;
    await checkBotNotifications({
      botId: this.botId,
      botHandle: this.options.botHandle ?? this.botId,
      bskyClient: this.options.bskyClient,
      store: this.options.store,
      ntfyUrl: this.options.ntfyUrl,
      logger: this.options.logger,
    });
  }
```

Update `stop()` and `shutdown()`:

```typescript
  stop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    if (this.notificationIntervalHandle) clearInterval(this.notificationIntervalHandle);
  }

  async shutdown(timeoutMs: number): Promise<void> {
    this.options.feedReader.stop();
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    if (this.notificationIntervalHandle) clearInterval(this.notificationIntervalHandle);
    await this.waitForDrainToFinish(timeoutMs);
    this.options.store.close();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:fleet && yarn typecheck`
Expected: PASS, all tests including the 4 new ones and every pre-existing test in the file (the new options are optional, so no existing `makeWorker()` call needs updating).

- [ ] **Step 5: Commit**

```bash
git add fleet/botWorker.ts fleet/botWorker.test.ts
git commit -m "feat(fleet): BotWorker starts a staggered notification-check interval when NTFY_URL is set"
```

---

### Task 5: Wire `NTFY_URL` through `runFleet.ts`

**Files:**
- Modify: `fleet/runFleet.ts`

**Interfaces:**
- Consumes: `BotWorkerOptions.ntfyUrl`/`botHandle` (Task 4), `BotSpec.identifier` (existing, `fleet/configLoader.ts`).
- Produces: nothing new consumed by later tasks — this is the final wiring task. No dedicated test file: `runFleet.ts` has no existing unit tests (it's the process entrypoint, exercised via `fleet/*.test.ts`'s use of its exported `buildWorker`-adjacent pieces is not a pattern used today), so this task is verified by `yarn typecheck` plus the full suite from Task 4 continuing to pass, matching how the file's existing `NTFY_URL`-shaped siblings (`DRY_RUN`, `FLEET_LOG_LEVEL`) were added.

- [ ] **Step 1: Implement**

In `fleet/runFleet.ts`, update `buildWorker`'s signature to accept `ntfyUrl`:

```typescript
async function buildWorker(
  spec: BotSpec,
  sharedLimiters: SharedLimiters,
  operations: BotOperations,
  logger: Logger,
  dryRun: boolean,
  runIntervalSeconds: number,
  freshnessConfig: FreshnessConfig,
  perBotQueueMaxLength: number,
  identityStore: BotStore,
  ntfyUrl: string | undefined,
): Promise<BotWorker> {
```

Pass it through to the `BotWorker` construction:

```typescript
    const worker = new BotWorker({
      botId: spec.botId,
      feedReader,
      scheduler: new Scheduler(spec.schedulerConfig),
      bskyClient,
      store,
      runIntervalSeconds,
      freshnessConfig,
      perBotQueueMaxLength,
      operations,
      logger,
      ntfyUrl,
      botHandle: spec.identifier,
    });
```

In `main()`, read the env var alongside the other config reads (after the `shutdownOverallTimeoutMs` line):

```typescript
  const ntfyUrl = process.env.NTFY_URL;
```

Log its absence once, alongside the existing config summary log (after the `logger.summary('FLEET', \`Loaded ${bots.length}...\`)` block, before the `identityStores` map):

```typescript
  if (!ntfyUrl) {
    logger.summary('FLEET', 'NTFY_URL not set - reply/mention/quote notifications disabled');
  }
```

Pass it into the `activateBot` call inside the `AuthCoordinator` construction:

```typescript
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
        ntfyUrl,
      );
```

- [ ] **Step 2: Verify**

Run: `yarn typecheck && yarn test:fleet`
Expected: PASS — no test exercises `runFleet.ts` directly, so this step is a type-check plus regression run confirming nothing else broke.

- [ ] **Step 3: Commit**

```bash
git add fleet/runFleet.ts
git commit -m "feat(fleet): read NTFY_URL and thread it into each bot's worker"
```

---

### Task 6: Documentation

**Files:**
- Modify: `documentation/fleet.md`
- Modify: `CLAUDE.md`

**Interfaces:** None — this task changes only prose.

- [ ] **Step 1: Add a subsection to `documentation/fleet.md`**

Insert this new subsection at the end of the existing `## Operations visibility` section, immediately before the `## Legacy import` heading (fleet.md:223):

```markdown
### Reply/mention/quote notifications

Set `NTFY_URL` to a full ntfy topic URL (for example
`https://ntfy.rmendes.net/skyfleet`) to get a push notification on your phone
whenever any fleet account receives a reply, @-mention, or quote-post on
Bluesky. Each bot checks its own notifications once every 5 minutes, staggered
the same way bot activation already is, using its existing authenticated
session - no extra login or credential handling.

Each notification is sent once, ever - a per-bot record of already-sent
notification URIs persists in that bot's own `state.sqlite`, so a fleet
restart never resends anything. A failed push (network error, ntfy
unreachable) is retried on the next 5-minute check rather than lost.

`NTFY_URL` is entirely optional. Leave it unset and fleet posting behaves
identically; nothing in the posting pipeline depends on it.
```

- [ ] **Step 2: Add one line to `CLAUDE.md`'s Fleet mode section**

Insert this bullet immediately after the existing `AuthCoordinator` bullet and before the `Health/observability` bullet:

```markdown
- **`fleet/notificationWatcher.ts`** polls each bot's Bluesky notifications (reply/mention/quote)
  every 5 minutes via `BotWorker`'s own interval (staggered for free by `AuthCoordinator`'s
  sequential activation) and forwards new ones to the operator's phone via `ntfy`
  (`NTFY_URL` env var) - persisted per-bot so a restart never resends. Optional; fleet posting is
  unaffected when `NTFY_URL` is unset.
```

- [ ] **Step 3: Commit**

```bash
git add documentation/fleet.md CLAUDE.md
git commit -m "docs(fleet): document NTFY_URL reply/mention/quote notifications"
```

---

## Self-Review

**1. Spec coverage.** Every section of `documentation/specs/2026-09-28-fleet-mention-notifications-design.md` maps to a task: `BskyClient` changes → Task 2; `BotStore` changes → Task 1; the watcher module and its dedup/error-handling rules → Task 3; scheduling (corrected to `BotWorker`-owned) → Task 4; `runFleet.ts` config wiring → Task 5; the Documentation section → Task 6. The rate-limit handling the user asked about mid-plan is covered in Task 2 (classification) and Task 3 (the `summary`-vs-`debug` log split and skip-without-recording behavior).

**2. Placeholder scan.** No TODOs, no "add appropriate handling," no "similar to Task N" — every step has complete, real code.

**3. Type consistency.** `ListNotificationsResult` (Task 2) is the same shape used in Task 3's `CheckBotNotificationsParams.bskyClient` (via `Pick<BskyClient, 'listNotifications'>`) and Task 4's `FakeBskyClient`. `SeenTable` (Task 1) is used identically in Task 3's `NOTIFIED_TABLE` constant. `checkBotNotifications`'s params object matches exactly between its Task 3 definition and its Task 4 call site inside `BotWorker.checkNotificationsOnce()`. `botHandle` flows from `BotSpec.identifier` (Task 5) → `BotWorkerOptions.botHandle` (Task 4) → `CheckBotNotificationsParams.botHandle` (Task 3) → `buildNtfyMessage`'s title/body (Task 3) — traced end to end, no name mismatch.

---

**Plan complete and saved to `documentation/plans/2026-09-28-fleet-mention-notifications.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
