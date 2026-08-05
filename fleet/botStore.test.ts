import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {BotStore} from './botStore.ts';

// db is private; these tests query it directly to construct state that BotStore's
// own public API can't produce (e.g. backdating a row).
function rawDb(store: BotStore): DatabaseSync {
  return (store as unknown as {db: DatabaseSync}).db;
}

function makeStore(): {store: BotStore; dir: string} {
  const dir = mkdtempSync(join(tmpdir(), 'botstore-test-'));
  const store = new BotStore(join(dir, 'state.sqlite'));
  return {store, dir};
}

function cleanup(store: BotStore, dir: string): void {
  store.close();
  rmSync(dir, {recursive: true, force: true});
}

test('readSession returns null before any session is written', () => {
  const {store, dir} = makeStore();
  assert.equal(store.readSession(), null);
  cleanup(store, dir);
});

test('session round-trips through write/read', () => {
  const {store, dir} = makeStore();
  store.writeSession({accessJwt: 'abc', refreshJwt: 'def'});
  assert.deepEqual(store.readSession(), {accessJwt: 'abc', refreshJwt: 'def'});
  cleanup(store, dir);
});

test('writeSession upserts, does not duplicate rows', () => {
  const {store, dir} = makeStore();
  store.writeSession({a: 1});
  store.writeSession({a: 2});
  assert.deepEqual(store.readSession(), {a: 2});
  cleanup(store, dir);
});

test('cursor defaults to empty string, then round-trips', () => {
  const {store, dir} = makeStore();
  assert.equal(store.readCursor(), '');
  const date = new Date('2026-01-01T00:00:00.000Z');
  store.writeCursor(date);
  assert.equal(store.readCursor(), date.toISOString());
  cleanup(store, dir);
});

test('writeCursor upserts, does not duplicate rows', () => {
  const {store, dir} = makeStore();
  store.writeCursor(new Date('2026-01-01T00:00:00.000Z'));
  store.writeCursor(new Date('2026-01-02T00:00:00.000Z'));
  assert.equal(store.readCursor(), '2026-01-02T00:00:00.000Z');
  cleanup(store, dir);
});

test("seen_items uses exact match, not substring — a known bug in today's db.txt", () => {
  const {store, dir} = makeStore();
  store.writeSeenValue('https://example.com/a');
  assert.equal(store.seenValueExists('https://example.com/a'), true);
  assert.equal(store.seenValueExists('https://example.com/a-longer'), false);
  assert.equal(store.seenValueExists('example.com/a'), false);
  assert.equal(store.seenValueExists('unrelated'), false);
  cleanup(store, dir);
});

test('writeSeenValue is idempotent — writing the same value twice does not error', () => {
  const {store, dir} = makeStore();
  store.writeSeenValue('dup');
  store.writeSeenValue('dup');
  assert.equal(store.seenValueExists('dup'), true);
  cleanup(store, dir);
});

test('cleanupOldSeenValues removes only entries past the age cutoff', () => {
  const {store, dir} = makeStore();
  store.writeSeenValue('old');
  // Backdate directly — writeSeenValue always stamps "now", so this is the only
  // way to construct an aged row without waiting in real time.
  rawDb(store)
    .prepare("UPDATE seen_items SET seen_at = ? WHERE value = 'old'")
    .run(new Date(Date.now() - 200 * 3600 * 1000).toISOString());
  store.writeSeenValue('recent');
  store.cleanupOldSeenValues(96);
  assert.equal(store.seenValueExists('old'), false);
  assert.equal(store.seenValueExists('recent'), true);
  cleanup(store, dir);
});

test('listQueued returns an empty array when nothing is queued', () => {
  const {store, dir} = makeStore();
  assert.deepEqual(store.listQueued(), []);
  cleanup(store, dir);
});

test('enqueue/listQueued/setQueueItemStatus drive an item through its lifecycle', () => {
  const {store, dir} = makeStore();
  const id = store.enqueue({
    title: 't',
    content: 'c',
    embedJson: null,
    languagesJson: null,
    itemDate: '2026-01-01T00:00:00.000Z',
    dedupeKey: 'key1',
  });
  assert.equal(store.countQueued(), 1);

  const rows = store.listQueued();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, id);
  assert.equal(rows[0]!.status, 'queued');
  assert.equal(rows[0]!.dedupeKey, 'key1');
  assert.equal(rows[0]!.publishedAt, null);

  store.setQueueItemStatus(id, 'published');
  assert.equal(store.countQueued(), 0);
  assert.deepEqual(store.listQueued(), []);
  cleanup(store, dir);
});

test('enqueue with a repeated dedupeKey is ignored by the UNIQUE constraint - returns 0, does not add a second row', () => {
  const {store, dir} = makeStore();
  const firstId = store.enqueue({
    title: 'first',
    content: 'c',
    embedJson: null,
    languagesJson: null,
    itemDate: '2026-01-01T00:00:00.000Z',
    dedupeKey: 'dup-key',
  });
  assert.notEqual(firstId, 0);

  const secondId = store.enqueue({
    title: 'second, same dedupeKey',
    content: 'c',
    embedJson: null,
    languagesJson: null,
    itemDate: '2026-01-02T00:00:00.000Z',
    dedupeKey: 'dup-key',
  });
  assert.equal(secondId, 0);
  assert.equal(store.countQueued(), 1);
  cleanup(store, dir);
});

test("listQueued only returns rows with status 'queued', ordered oldest item_date first", () => {
  const {store, dir} = makeStore();
  store.enqueue({
    title: 'b',
    content: 'c',
    embedJson: null,
    languagesJson: null,
    itemDate: '2026-01-02T00:00:00.000Z',
    dedupeKey: 'k2',
  });
  const aId = store.enqueue({
    title: 'a',
    content: 'c',
    embedJson: null,
    languagesJson: null,
    itemDate: '2026-01-01T00:00:00.000Z',
    dedupeKey: 'k1',
  });
  const skippedId = store.enqueue({
    title: 'skip-me',
    content: 'c',
    embedJson: null,
    languagesJson: null,
    itemDate: '2025-12-01T00:00:00.000Z',
    dedupeKey: 'k0',
  });
  store.setQueueItemStatus(skippedId, 'skipped');

  const rows = store.listQueued();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.id, aId);
  assert.equal(rows[0]!.title, 'a');
  assert.equal(rows[1]!.title, 'b');
  cleanup(store, dir);
});

test("setQueueItemStatus('published') stamps published_at; other statuses do not", () => {
  const {store, dir} = makeStore();
  const publishedId = store.enqueue({
    title: 'p',
    content: 'c',
    embedJson: null,
    languagesJson: null,
    itemDate: '2026-01-01T00:00:00.000Z',
    dedupeKey: 'kp',
  });
  const skippedId = store.enqueue({
    title: 's',
    content: 'c',
    embedJson: null,
    languagesJson: null,
    itemDate: '2026-01-01T00:00:00.000Z',
    dedupeKey: 'ks',
  });
  store.setQueueItemStatus(publishedId, 'published');
  store.setQueueItemStatus(skippedId, 'skipped');

  // Query directly since listQueued() excludes non-'queued' rows.
  const publishedRow = rawDb(store)
    .prepare('SELECT published_at FROM queue_items WHERE id = ?')
    .get(publishedId) as {published_at: string | null};
  const skippedRow = rawDb(store)
    .prepare('SELECT published_at FROM queue_items WHERE id = ?')
    .get(skippedId) as {published_at: string | null};
  assert.ok(publishedRow.published_at !== null);
  assert.equal(skippedRow.published_at, null);
  cleanup(store, dir);
});

test('embed_json and languages_json round-trip as opaque strings', () => {
  const {store, dir} = makeStore();
  const embedJson = JSON.stringify({uri: 'https://example.com', title: 'Example'});
  const languagesJson = JSON.stringify(['en', 'fr']);
  store.enqueue({
    title: 't',
    content: 'c',
    embedJson,
    languagesJson,
    itemDate: '2026-01-01T00:00:00.000Z',
    dedupeKey: 'k',
  });
  const rows = store.listQueued();
  assert.equal(rows[0]!.embedJson, embedJson);
  assert.equal(rows[0]!.languagesJson, languagesJson);
  cleanup(store, dir);
});

test('a queued item survives closing and reopening the store against the same file — the actual durability property', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botstore-test-'));
  const dbPath = join(dir, 'state.sqlite');

  const store1 = new BotStore(dbPath);
  store1.enqueue({
    title: 'durable',
    content: 'c',
    embedJson: null,
    languagesJson: null,
    itemDate: '2026-01-01T00:00:00.000Z',
    dedupeKey: 'durable-key',
  });
  store1.close();

  const store2 = new BotStore(dbPath);
  const rows = store2.listQueued();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, 'durable');
  assert.equal(rows[0]!.status, 'queued');
  store2.close();
  rmSync(dir, {recursive: true, force: true});
});

test('listSeenValues returns every seen value with its recorded timestamp', t => {
  const dir = mkdtempSync(join(tmpdir(), 'botstore-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const store = new BotStore(join(dir, 'state.sqlite'));
  t.after(() => store.close());

  store.writeSeenValue('https://example.com/a');
  store.writeSeenValue('https://example.com/b');

  const rows = store.listSeenValues();
  const values = rows.map(r => r.value).sort();
  assert.deepEqual(values, ['https://example.com/a', 'https://example.com/b']);
  assert.ok(rows.every(r => typeof r.seenAt === 'string' && r.seenAt.length > 0));
});
