import {test} from 'node:test';
import assert from 'node:assert/strict';
import {atUriToBskyUrl, buildNtfyMessage, checkBotNotifications} from './notificationWatcher.ts';
import {Logger, type LogRecord} from '../shared/logging/logger.ts';
import type {BskyClient, ListNotificationsResult} from './bskyClient.ts';
import type {BotStore} from './botStore.ts';
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
