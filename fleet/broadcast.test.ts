import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  broadcastDedupeKey,
  targetBots,
  buildBroadcastEmbed,
  enqueueBroadcast,
} from './broadcast.ts';
import {BotStore} from './botStore.ts';
import type {BotSpec} from './configLoader.ts';

function makeBotSpec(botId: string): BotSpec {
  return {
    botId,
    identifier: `${botId}.bsky.social`,
    appPassword: 'unused-in-this-test',
    instanceUrl: 'https://bsky.social',
    feedUrl: 'https://example.com/feed.xml',
    fetchIntervalMinutes: 5,
    dbPath: '/unused/in/this/test.sqlite',
    feedReaderConfig: {} as BotSpec['feedReaderConfig'],
    schedulerConfig: {} as BotSpec['schedulerConfig'],
  };
}

test('broadcastDedupeKey is deterministic for the same message+link', () => {
  const a = broadcastDedupeKey('hello', 'https://example.com');
  const b = broadcastDedupeKey('hello', 'https://example.com');
  assert.equal(a, b);
  assert.match(a, /^broadcast:[0-9a-f]{64}$/);
});

test('broadcastDedupeKey differs for a different message or a different link', () => {
  const base = broadcastDedupeKey('hello', 'https://example.com');
  assert.notEqual(broadcastDedupeKey('goodbye', 'https://example.com'), base);
  assert.notEqual(broadcastDedupeKey('hello', 'https://example.com/other'), base);
});

test('targetBots excludes named bot IDs, keeps the rest', () => {
  const all = [makeBotSpec('a'), makeBotSpec('b'), makeBotSpec('c')];
  const result = targetBots(all, ['b']);
  assert.deepEqual(
    result.map(b => b.botId),
    ['a', 'c'],
  );
});

test('targetBots with an empty exclude list returns every bot', () => {
  const all = [makeBotSpec('a'), makeBotSpec('b')];
  assert.deepEqual(
    targetBots(all, []).map(b => b.botId),
    ['a', 'b'],
  );
});

test('targetBots excluding a nonexistent bot ID is a no-op, not an error', () => {
  const all = [makeBotSpec('a')];
  assert.deepEqual(
    targetBots(all, ['does-not-exist']).map(b => b.botId),
    ['a'],
  );
});

test('buildBroadcastEmbed builds a ParsedEmbed from a successful Open Graph result', () => {
  const embed = buildBroadcastEmbed(
    {
      ogTitle: 'Example Title',
      ogDescription: 'Example description',
      ogImage: [{url: 'https://example.com/image.jpg'}],
      ogUrl: 'https://example.com/canonical',
    },
    'https://example.com/original-link',
  );
  assert.deepEqual(embed, {
    uri: 'https://example.com/canonical',
    title: 'Example Title',
    description: 'Example description',
    imageUrl: 'https://example.com/image.jpg',
    imageAlt: undefined,
  });
});

test('buildBroadcastEmbed falls back to the original link when ogUrl is absent', () => {
  const embed = buildBroadcastEmbed({ogTitle: 'Title only'}, 'https://example.com/link');
  assert.equal(embed?.uri, 'https://example.com/link');
});

test('buildBroadcastEmbed returns undefined when the Open Graph result is undefined (scrape failed)', () => {
  assert.equal(buildBroadcastEmbed(undefined, 'https://example.com'), undefined);
});

test('buildBroadcastEmbed returns undefined when the Open Graph result has no title', () => {
  assert.equal(
    buildBroadcastEmbed({ogDescription: 'no title here'}, 'https://example.com'),
    undefined,
  );
});

function makeStore(): {store: BotStore; dir: string} {
  const dir = mkdtempSync(join(tmpdir(), 'broadcast-test-'));
  const store = new BotStore(join(dir, 'state.sqlite'));
  return {store, dir};
}

test('enqueueBroadcast writes a real queued row and reports "enqueued"', () => {
  const {store, dir} = makeStore();
  try {
    const outcome = enqueueBroadcast(store, {
      title: 'Broadcast: test',
      message: 'Test broadcast message',
      embed: undefined,
      dedupeKey: broadcastDedupeKey('Test broadcast message', 'https://example.com'),
    });
    assert.equal(outcome, 'enqueued');
    const queued = store.listQueued();
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.content, 'Test broadcast message');
    assert.equal(queued[0]!.embedJson, null);
  } finally {
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('enqueueBroadcast with an embed serializes it into embedJson', () => {
  const {store, dir} = makeStore();
  try {
    const embed = {
      uri: 'https://example.com',
      title: 'T',
      description: undefined,
      imageUrl: undefined,
      imageAlt: undefined,
    };
    enqueueBroadcast(store, {
      title: 'Broadcast: test',
      message: 'msg',
      embed,
      dedupeKey: broadcastDedupeKey('msg', 'https://example.com'),
    });
    const queued = store.listQueued();
    const parsed = JSON.parse(queued[0]!.embedJson!);
    // JSON doesn't preserve undefined values - verify the values that were present are there
    assert.equal(parsed.uri, embed.uri);
    assert.equal(parsed.title, embed.title);
  } finally {
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('enqueueBroadcast reports "duplicate" for a repeated dedupeKey, without adding a second row', () => {
  const {store, dir} = makeStore();
  try {
    const dedupeKey = broadcastDedupeKey('msg', 'https://example.com');
    const first = enqueueBroadcast(store, {
      title: 't',
      message: 'msg',
      embed: undefined,
      dedupeKey,
    });
    const second = enqueueBroadcast(store, {
      title: 't',
      message: 'msg',
      embed: undefined,
      dedupeKey,
    });
    assert.equal(first, 'enqueued');
    assert.equal(second, 'duplicate');
    assert.equal(store.listQueued().length, 1);
  } finally {
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
