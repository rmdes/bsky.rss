import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {atUriToBskyUrl, buildNtfyMessage, checkBotNotifications} from './notificationWatcher.ts';
import {Logger, type LogRecord} from '../shared/logging/logger.ts';
import type {BskyClient, ListNotificationsResult} from './bskyClient.ts';
import type {BotStore} from './botStore.ts';
import {BotStore as RealBotStore} from './botStore.ts';
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
    // Fresh by default so tests exercising dedup/logging/etc. aren't incidentally caught by
    // the age cutoff (MAX_NOTIFICATION_AGE_MS) - tests for that cutoff pass their own indexedAt.
    indexedAt: new Date().toISOString(),
    ...overrides,
  };
}

class FakeBskyClient {
  private result: ListNotificationsResult = {ok: true, notifications: []};
  public calls = 0;
  public isDryRun = false;
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
    bskyClient: bskyClient as unknown as BskyClient,
    store: store as unknown as BotStore,
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
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({url: String(input), init: init ?? {}});
    return new Response(null, {status: 200});
  };
  const {logger, records} = makeLogger();

  await checkBotNotifications({
    botId: 'b',
    botHandle: 'b.bsky.social',
    bskyClient: bskyClient as unknown as BskyClient,
    store: store as unknown as BotStore,
    ntfyUrl: 'https://ntfy.example/topic',
    logger,
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://ntfy.example/topic');
  assert.equal(store.seenValueExists(notification.uri, 'notified_items'), true);
  assert.ok(
    records.some(
      r =>
        r.level === 'verbose' &&
        r.message ===
          `Pushed notification (${notification.reason} from @${notification.author.handle})`,
    ),
    'a successful push must log one verbose confirmation line, mentioning the reason and replier',
  );
  assert.equal(
    records.filter(r => r.level === 'summary').length,
    0,
    'a successful push must not log at summary level',
  );
});

test('checkBotNotifications sends an Authorization: Bearer header when an ntfyToken is configured', async () => {
  const bskyClient = new FakeBskyClient();
  const notification = makeNotification();
  bskyClient.setResult({ok: true, notifications: [notification]});
  const store = new FakeStore();
  const calls: {url: string; init: RequestInit}[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({url: String(input), init: init ?? {}});
    return new Response(null, {status: 200});
  };
  const {logger} = makeLogger();

  await checkBotNotifications({
    botId: 'b',
    botHandle: 'b.bsky.social',
    bskyClient: bskyClient as unknown as BskyClient,
    store: store as unknown as BotStore,
    ntfyUrl: 'https://ntfy.example/topic',
    ntfyToken: 'tk_test_token_value',
    logger,
    fetchImpl,
  });

  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers['Authorization'], 'Bearer tk_test_token_value');
});

test('checkBotNotifications omits the Authorization header when no ntfyToken is configured', async () => {
  const bskyClient = new FakeBskyClient();
  const notification = makeNotification();
  bskyClient.setResult({ok: true, notifications: [notification]});
  const store = new FakeStore();
  const calls: {url: string; init: RequestInit}[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({url: String(input), init: init ?? {}});
    return new Response(null, {status: 200});
  };
  const {logger} = makeLogger();

  await checkBotNotifications({
    botId: 'b',
    botHandle: 'b.bsky.social',
    bskyClient: bskyClient as unknown as BskyClient,
    store: store as unknown as BotStore,
    ntfyUrl: 'https://ntfy.example/topic',
    logger,
    fetchImpl,
  });

  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal('Authorization' in headers, false);
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
    bskyClient: bskyClient as unknown as BskyClient,
    store: store as unknown as BotStore,
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
    bskyClient: bskyClient as unknown as BskyClient,
    store: store as unknown as BotStore,
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
    bskyClient: bskyClient as unknown as BskyClient,
    store: store as unknown as BotStore,
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
    bskyClient: bskyClient as unknown as BskyClient,
    store: store as unknown as BotStore,
    ntfyUrl: 'https://ntfy.example/topic',
    logger,
    fetchImpl,
  });

  assert.equal(fetchCalls, 0);
  assert.equal(records.filter(r => r.level === 'summary').length, 0);
  assert.ok(records.some(r => r.level === 'debug'));
});

test('a notification older than the age cutoff is skipped without being pushed or recorded', async () => {
  const bskyClient = new FakeBskyClient();
  const old = makeNotification({
    uri: 'at://did:plc:replier/app.bsky.feed.post/stale',
    indexedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(), // 25h old
  });
  bskyClient.setResult({ok: true, notifications: [old]});
  const store = new FakeStore();
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return new Response(null, {status: 200});
  };
  const {logger} = makeLogger();

  await checkBotNotifications({
    botId: 'b',
    botHandle: 'b.bsky.social',
    bskyClient: bskyClient as unknown as BskyClient,
    store: store as unknown as BotStore,
    ntfyUrl: 'https://ntfy.example/topic',
    logger,
    fetchImpl,
  });

  assert.equal(fetchCalls, 0);
  assert.equal(store.seenValueExists(old.uri, 'notified_items'), false);
});

test('a notification just inside the age cutoff still gets pushed', async () => {
  const bskyClient = new FakeBskyClient();
  const recent = makeNotification({
    uri: 'at://did:plc:replier/app.bsky.feed.post/fresh',
    indexedAt: new Date(Date.now() - 1 * 3600 * 1000).toISOString(), // 1h old
  });
  bskyClient.setResult({ok: true, notifications: [recent]});
  const store = new FakeStore();
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return new Response(null, {status: 200});
  };
  const {logger} = makeLogger();

  await checkBotNotifications({
    botId: 'b',
    botHandle: 'b.bsky.social',
    bskyClient: bskyClient as unknown as BskyClient,
    store: store as unknown as BotStore,
    ntfyUrl: 'https://ntfy.example/topic',
    logger,
    fetchImpl,
  });

  assert.equal(fetchCalls, 1);
  assert.equal(store.seenValueExists(recent.uri, 'notified_items'), true);
});

test('a real BotStore: a notification stale enough to be near the 96h prune window is still just skipped by the age cutoff, never resent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notificationwatcher-test-'));
  const store = new RealBotStore(join(dir, 'state.sqlite'));
  try {
    const bskyClient = new FakeBskyClient();
    const stale = makeNotification({
      uri: 'at://did:plc:replier/app.bsky.feed.post/near-prune',
      indexedAt: new Date(Date.now() - 90 * 3600 * 1000).toISOString(), // 90h old — inside the 96h prune window, but far past the 24h age cutoff
    });
    bskyClient.setResult({ok: true, notifications: [stale]});
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls++;
      return new Response(null, {status: 200});
    };
    const {logger} = makeLogger();
    const params = {
      botId: 'b',
      botHandle: 'b.bsky.social',
      bskyClient: bskyClient as unknown as BskyClient,
      store,
      ntfyUrl: 'https://ntfy.example/topic',
      logger,
      fetchImpl,
    };

    // Run it twice, simulating two separate 5-minute checks — the old bug would have
    // recorded it as seen after a first successful send, then re-sent it once that record
    // was pruned. With the age cutoff, it's never sent in the first place, on either call.
    await checkBotNotifications(params);
    await checkBotNotifications(params);

    assert.equal(fetchCalls, 0, 'a 90h-old notification must never be pushed, on any call');
    assert.equal(store.seenValueExists(stale.uri, 'notified_items'), false);
  } finally {
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a notification with an unparseable indexedAt is skipped, not treated as fresh', async () => {
  const bskyClient = new FakeBskyClient();
  const badDate = makeNotification({
    uri: 'at://did:plc:replier/app.bsky.feed.post/bad-date',
    indexedAt: 'not-a-real-date',
  });
  bskyClient.setResult({ok: true, notifications: [badDate]});
  const store = new FakeStore();
  let fetchCalls = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchCalls++;
    return new Response(null, {status: 200});
  };
  const {logger} = makeLogger();

  await checkBotNotifications({
    botId: 'b',
    botHandle: 'b.bsky.social',
    bskyClient: bskyClient as unknown as BskyClient,
    store: store as unknown as BotStore,
    ntfyUrl: 'https://ntfy.example/topic',
    logger,
    fetchImpl,
  });

  assert.equal(
    fetchCalls,
    0,
    'an unparseable timestamp must fail closed (skip), not fail open (send)',
  );
  assert.equal(store.seenValueExists(badDate.uri, 'notified_items'), false);
});

test('in dry-run mode, checkBotNotifications logs what it would push without a real ntfy POST or recording it as sent', async () => {
  const bskyClient = new FakeBskyClient();
  bskyClient.isDryRun = true;
  const notification = makeNotification();
  bskyClient.setResult({ok: true, notifications: [notification]});
  const store = new FakeStore();
  let fetchCalls = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchCalls++;
    return new Response(null, {status: 200});
  };
  const {logger, records} = makeLogger();

  await checkBotNotifications({
    botId: 'b',
    botHandle: 'b.bsky.social',
    bskyClient: bskyClient as unknown as BskyClient,
    store: store as unknown as BotStore,
    ntfyUrl: 'https://ntfy.example/topic',
    logger,
    fetchImpl,
  });

  assert.equal(fetchCalls, 0, 'dry-run must never hit the real ntfy endpoint');
  assert.equal(
    store.seenValueExists(notification.uri, 'notified_items'),
    false,
    'dry-run must not record as sent, so a later real (non-dry-run) run still pushes it for real',
  );
  assert.ok(
    records.some(r => r.level === 'verbose' && /\[dry-run\]/.test(r.message)),
    'dry-run should still log what it would have pushed',
  );
});

test('atUriToBskyUrl rejects a malformed AT-URI rather than building a header-breaking URL', () => {
  assert.equal(atUriToBskyUrl('at://did:plc:abc/coll/rk,ey'), undefined);
  assert.equal(atUriToBskyUrl('at://did:plc:abc/coll/rk;ey'), undefined);
  assert.equal(atUriToBskyUrl('at://did:plc:abc/coll/rk\r\nX-Injected: evil'), undefined);
  assert.equal(atUriToBskyUrl('not-an-at-uri-at-all'), undefined);
});

test('buildNtfyMessage omits X-Click and X-Actions for notifications with malformed AT-URIs, instead of embedding a broken header', () => {
  const notification = makeNotification({
    uri: 'at://did:plc:replier/app.bsky.feed.post/rk,ey',
    reasonSubject: 'at://did:plc:bot/app.bsky.feed.post/rk;ey',
  });
  const message = buildNtfyMessage('bot.skyfleet.blue', notification);
  assert.equal('X-Click' in message.headers, false);
  assert.equal('X-Actions' in message.headers, false);
  // The rest of the message is still built normally - a malformed URI in one notification
  // shouldn't suppress the whole push, just the two header fields that depend on it.
  assert.equal(message.headers['X-Title'], 'New reply on @bot.skyfleet.blue');
});
