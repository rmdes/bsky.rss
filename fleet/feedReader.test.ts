import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {Server} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  removeHTMLTags,
  decodeHTMLTwice,
  fixMalformedUrl,
  parseString,
  FeedReader,
  type ParsedItem,
} from './feedReader.ts';
import type {NormalizedItem} from '../shared/feedSource/index.ts';
import {computeDedupeKey} from './dedupeKey.ts';
import {BotStore} from './botStore.ts';
import {SharedLimiters} from './sharedLimiters.ts';
import {BotOperations} from './botOperations.ts';
import {FleetLogger, type FleetLogRecord} from './logging.ts';
import jimp from 'jimp';

// handleItem is private; these tests drive it directly to exercise item-processing
// behavior without going through a real feed poll.
function handleItem(reader: FeedReader, item: NormalizedItem): Promise<void> {
  return (reader as unknown as {handleItem: (item: NormalizedItem) => Promise<void>}).handleItem(
    item,
  );
}

function normalizedItem(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    id: 'https://example.com/default-item',
    title: 'Default Title',
    link: 'https://example.com/default-item',
    date: '2026-08-05T09:00:00.000Z',
    description: undefined,
    content: undefined,
    imageUrl: undefined,
    geo: undefined,
    mappedValues: {},
    ...overrides,
  };
}

const fixedNow = new Date('2026-08-03T12:00:00.000Z');

function createRuntime(
  botId = 'test-bot',
  fetchOpenGraph?: (url: string, userAgent: string, timeoutMs: number) => Promise<unknown>,
): {
  operations: BotOperations;
  logger: FleetLogger;
  records: FleetLogRecord[];
  fetchOpenGraph?: typeof fetchOpenGraph;
} {
  const records: FleetLogRecord[] = [];
  return {
    operations: new BotOperations(botId, () => fixedNow),
    logger: new FleetLogger({
      defaultLevel: 'debug',
      now: () => fixedNow,
      sink: (_line, record) => records.push(record),
    }),
    records,
    fetchOpenGraph,
  };
}

function createInstrumentedReader(
  t: {after(callback: () => void): void},
  options: {
    botId?: string;
    identifier?: string;
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
  const runtime = createRuntime(botId, options.fetchOpenGraph);
  const reader = new FeedReader(
    botId,
    identifier,
    new URL('http://127.0.0.1:1/feed.xml'),
    5,
    {string: '$title', ...options.config},
    store,
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

test('removeHTMLTags strips tags and collapses whitespace', () => {
  assert.equal(removeHTMLTags('<p>Hello <b>world</b></p>'), 'Hello world');
});

test('removeHTMLTags converts &nbsp; to a plain space', () => {
  assert.equal(removeHTMLTags('Hello&nbsp;world'), 'Hello world');
});

test('removeHTMLTags collapses multiple spaces into one', () => {
  assert.equal(removeHTMLTags('Hello   world'), 'Hello world');
});

test('decodeHTMLTwice handles double-encoded entities', () => {
  // &amp;#233; -> &#233; -> é, matching today's rssHandler.ts comment/behavior exactly
  assert.equal(decodeHTMLTwice('&amp;#233;'), 'é');
});

test('fixMalformedUrl fixes a missing colon after https', () => {
  assert.equal(fixMalformedUrl('https//example.com/a'), 'https://example.com/a');
});

test('fixMalformedUrl fixes a missing colon after http', () => {
  assert.equal(fixMalformedUrl('http//example.com/a'), 'http://example.com/a');
});

test('fixMalformedUrl leaves a well-formed URL unchanged', () => {
  assert.equal(fixMalformedUrl('https://example.com/a'), 'https://example.com/a');
});

test('parseString substitutes $title, $link, $description', () => {
  const item = normalizedItem({
    title: 'My Title',
    link: 'https://example.com/post',
    description: 'My description',
  });
  const result = parseString('$title - $link ($description)', item, false, false, false);
  assert.equal(result.text, 'My Title - https://example.com/post (My description)');
});

test('parseString truncates past 300 chars to 280 chars when truncate is true', () => {
  const longTitle = 'x'.repeat(400);
  const item = normalizedItem({title: longTitle, link: 'https://example.com', description: ''});
  const result = parseString('$title', item, true, false, false);
  assert.equal(result.text.length, 280);
  assert.ok(result.text.endsWith('...'));
});

test('parseString does not truncate when truncate is false', () => {
  const longTitle = 'x'.repeat(400);
  const item = normalizedItem({title: longTitle, link: 'https://example.com', description: ''});
  const result = parseString('$title', item, false, false, false);
  assert.equal(result.text.length, 400);
});

test('parseString cleans HTML from the title when titleClearHTML is true', () => {
  const item = normalizedItem({
    title: '<b>Bold</b> Title',
    link: 'https://example.com',
    description: '',
  });
  const result = parseString('$title', item, false, true, false);
  assert.equal(result.text, 'Bold Title');
});

test('parseString substitutes $georss with an OpenStreetMap link built from geo', () => {
  const item = normalizedItem({geo: {lat: 47.391, lng: -70.2406}});
  const result = parseString('$georss', item, false, false, false);
  assert.equal(result.text, 'https://www.openstreetmap.org/?mlat=47.391&mlon=-70.2406');
});

test('parseString substitutes $georss with an empty string when geo is absent', () => {
  const item = normalizedItem({geo: undefined});
  const result = parseString('Location: $georss', item, false, false, false);
  assert.equal(result.text, 'Location: ');
});

test('parseString substitutes a $key placeholder from mappedValues', () => {
  const item = normalizedItem({mappedValues: {author: 'Jane Doe'}});
  const result = parseString('By $author', item, false, false, false);
  assert.equal(result.text, 'By Jane Doe');
});

test('parseString substitutes multiple $key placeholders from mappedValues', () => {
  const item = normalizedItem({mappedValues: {author: 'Jane Doe', duration: '2416'}});
  const result = parseString('$author - $duration seconds', item, false, false, false);
  assert.equal(result.text, 'Jane Doe - 2416 seconds');
});

test('parseString leaves a template placeholder with no matching mappedValues key untouched', () => {
  const item = normalizedItem({mappedValues: {}});
  const result = parseString('$unmapped stays literal', item, false, false, false);
  assert.equal(result.text, '$unmapped stays literal');
});

test('parseString substitutes $authorName correctly even when the shorter "author" key is declared first', () => {
  // Confirmed bug: substitution order followed Object.entries insertion order. The
  // template here only uses $authorName (no separate $author). But when "author" is
  // processed first, its placeholder "$author" is a literal prefix substring of
  // "$authorName" in the template text, so `.includes('$author')` falsely matches and
  // `.replace('$author', ...)` eats the front of $authorName - corrupting the output to
  // "By JaneName" instead of resolving $authorName to its own mapped value.
  const item = normalizedItem({
    mappedValues: {author: 'Jane', authorName: 'Jane Smith'},
  });
  const result = parseString('By $authorName', item, false, false, false);
  assert.equal(result.text, 'By Jane Smith');
});

test('parseString substitutes $authorName correctly when it is declared before the shorter "author" key', () => {
  const item = normalizedItem({
    mappedValues: {authorName: 'Jane Smith', author: 'Jane'},
  });
  const result = parseString('By $authorName', item, false, false, false);
  assert.equal(result.text, 'By Jane Smith');
});

test('parseString does not let the mappedValues loop touch a $key-shaped placeholder leaked from feed content', () => {
  // Confirmed bug: the mappedValues loop guarded its substitution with
  // `.includes()` on the string-in-progress (already containing $description's
  // substituted content), unlike every other branch which guards against the
  // original template. So feed-supplied content that happens to literally contain
  // "$author" (e.g. "buy now $author") got treated as a real placeholder and
  // substituted, corrupting the description text - only the operator's real
  // $author placeholder (declared separately in the template) should ever resolve.
  const item = normalizedItem({
    description: 'buy now $author',
    mappedValues: {author: 'Real Author'},
  });
  const result = parseString('$description | $author', item, false, false, false);
  assert.equal(result.text, 'buy now $author | Real Author');
});

test('parseString leaves a $key-shaped substring inside feed content untouched when the operator never declared that placeholder in the template', () => {
  const item = normalizedItem({
    description: 'buy now $author',
    mappedValues: {author: 'Real Author'},
  });
  const result = parseString('$description', item, false, false, false);
  assert.equal(result.text, 'buy now $author');
});

test('parseString resolves [$title]($link) into text plus a facet with correct byte offsets', () => {
  const item = {
    id: '1',
    title: 'Breaking',
    link: 'https://example.com/1',
    date: '2026-08-08T00:00:00Z',
    description: undefined,
    content: undefined,
    imageUrl: undefined,
    geo: undefined,
    mappedValues: {},
  };
  const result = parseString('[$title]($link)', item, false, false, false);
  assert.equal(result.text, 'Breaking');
  assert.deepEqual(result.facets, [{byteStart: 0, byteEnd: 8, uri: 'https://example.com/1'}]);
});

test('parseString throws when [$title](...) is used but the item has no title, matching bare $title', () => {
  const item = {
    id: '1',
    title: undefined,
    link: 'https://example.com/1',
    date: '2026-08-08T00:00:00Z',
    description: undefined,
    content: undefined,
    imageUrl: undefined,
    geo: undefined,
    mappedValues: {},
  };
  assert.throws(
    () => parseString('[$title]($link)', item, false, false, false),
    /No title provided/,
  );
});

test('parseString returns an empty facets array for a template with no bracket syntax', () => {
  const item = {
    id: '1',
    title: 'T',
    link: 'https://example.com/1',
    date: '2026-08-08T00:00:00Z',
    description: undefined,
    content: undefined,
    imageUrl: undefined,
    geo: undefined,
    mappedValues: {},
  };
  const result = parseString('$title - $link', item, false, false, false);
  assert.equal(result.text, 'T - https://example.com/1');
  assert.deepEqual(result.facets, []);
});

test('parseString drops a facet entirely when truncation cuts into its byte range', () => {
  const longTitle = 'x'.repeat(320);
  const item = {
    id: '1',
    title: longTitle,
    link: 'https://example.com/1',
    date: '2026-08-08T00:00:00Z',
    description: undefined,
    content: undefined,
    imageUrl: undefined,
    geo: undefined,
    mappedValues: {},
  };
  const result = parseString('[$title]($link)', item, true, false, false);
  assert.equal(result.text.length, 280);
  assert.deepEqual(result.facets, []);
});

test('parseString drops a facet whose byteEnd lands just past the 277-byte cutoff instead of letting it survive covering part of the appended ellipsis', () => {
  // Regression test for Finding 1: computing the truncation byte-length ceiling on the
  // string that ALREADY has '...' appended let a facet whose byteEnd fell 1-3 bytes past
  // the real 277-byte cutoff survive, ending up covering the appended ellipsis. Facet
  // here spans bytes [270, 279) - 2 bytes past the cutoff.
  const item = {
    id: '1',
    title: undefined,
    link: 'https://example.com/1',
    date: '2026-08-08T00:00:00Z',
    description: undefined,
    content: undefined,
    imageUrl: undefined,
    geo: undefined,
    mappedValues: {},
  };
  const template = 'y'.repeat(270) + '[CLICKHERE]($link)' + 'z'.repeat(100);
  const result = parseString(template, item, true, false, false);
  assert.equal(result.text.length, 280);
  assert.ok(result.text.endsWith('...'));
  assert.deepEqual(result.facets, []); // byteEnd 279 > 277-byte cutoff - dropped, not partially retained
});

test('parseString computes correct facet byte offsets when a bare placeholder precedes a bracket span', () => {
  // Regression test for a real bug found and fixed in Task 2's rssHandler.ts equivalent:
  // a single-pass resolver computed facet offsets before the bare-placeholder loop below
  // it mutated the string's length further, staling every facet positioned after it.
  const item = {
    id: '1',
    title: 'A much longer title than the placeholder',
    link: 'https://x.com',
    date: '2026-08-08T00:00:00Z',
    description: undefined,
    content: undefined,
    imageUrl: undefined,
    geo: undefined,
    mappedValues: {},
  };
  const result = parseString('$title - [text]($link)', item, false, false, false);
  assert.equal(result.text, 'A much longer title than the placeholder - text');
  const bytes = Buffer.from(result.text, 'utf8');
  const facetText = bytes
    .slice(result.facets[0]!.byteStart, result.facets[0]!.byteEnd)
    .toString('utf8');
  assert.equal(facetText, 'text');
});

test('parseString resolves [$georss](...) used as DISPLAY text to an empty, vanished span on a geo-less item, not the literal string "$georss"', () => {
  // Regression test for Finding 5: the bracket-resolver closure returned undefined for
  // $georss with no geo data, so resolve(token) ?? token left the literal text "$georss"
  // behind. The bare substitution path already correctly used '' for this same case.
  const item = {
    id: '1',
    title: 'T',
    link: 'https://example.com/1',
    date: '2026-08-08T00:00:00Z',
    description: undefined,
    content: undefined,
    imageUrl: undefined,
    geo: undefined,
    mappedValues: {},
  };
  const result = parseString('before [$georss]($link) after', item, false, false, false);
  assert.equal(result.text, 'before  after');
  assert.deepEqual(result.facets, []);
});

test('parseString does not throw or corrupt when resolved feed content inside a bracket happens to contain a $-shaped substring', () => {
  const item = {
    id: '1',
    title: undefined,
    link: 'https://x.com',
    date: '2026-08-08T00:00:00Z',
    description: 'Remember to set $title in your config',
    content: undefined,
    imageUrl: undefined,
    geo: undefined,
    mappedValues: {},
  };
  const result = parseString('[$description]($link)', item, false, false, false);
  assert.equal(result.text, 'Remember to set $title in your config');
  assert.deepEqual(result.facets, [{byteStart: 0, byteEnd: 37, uri: 'https://x.com'}]);
});

test('computeDedupeKey matches what a FeedReader-computed dedupeKey should look like for a known URL', () => {
  // Guards the FeedReader <-> dedupeKey.ts integration contract: FeedReader must call
  // computeDedupeKey(botId, itemUrl) with the item's link, not some other string.
  const key = computeDedupeKey('bot-1', 'https://example.com/a');
  assert.equal(typeof key, 'string');
  assert.equal(key.length, 64);
});

test('handleItem derives the dedupe key from the item link, not its guid-derived id', async t => {
  // Break caught: NormalizedItem.id is guid-first (guid ?? link), but the pre-migration
  // dedupe key was link-first. On any feed where guid !== link (WordPress's
  // <guid isPermaLink="false">, UUID guids), switching precedence recomputes a new key
  // for every already-queued item at cutover - dedupe_key is a persisted UNIQUE column
  // and the AT-Proto record key, so the item stops colliding with its own queued row
  // and gets posted twice.
  const {reader} = createInstrumentedReader(t);
  const emitted: ParsedItem[] = [];
  reader.onItem(item => emitted.push(item));

  await handleItem(
    reader,
    normalizedItem({
      id: 'https://example.test/?p=123',
      link: 'https://example.test/the-article',
      date: '2026-08-03T12:01:00.000Z',
    }),
  );

  assert.equal(emitted.length, 1);
  assert.equal(
    emitted[0]?.dedupeKey,
    computeDedupeKey('test-bot', 'https://example.test/the-article'),
  );
  assert.notEqual(
    emitted[0]?.dedupeKey,
    computeDedupeKey('test-bot', 'https://example.test/?p=123'),
  );
});

test('handleItem falls back to the item id for the dedupe key when there is no link', async t => {
  const {reader} = createInstrumentedReader(t);
  const emitted: ParsedItem[] = [];
  reader.onItem(item => emitted.push(item));

  await handleItem(
    reader,
    normalizedItem({
      id: 'urn:uuid:abc-123',
      link: undefined,
      date: '2026-08-03T12:01:00.000Z',
    }),
  );

  assert.equal(emitted[0]?.dedupeKey, computeDedupeKey('test-bot', 'urn:uuid:abc-123'));
});

test('two bot configs sharing one Bluesky identifier compute the same dedupeKey for the same item, even with different botIds', async t => {
  // Real production bug: multiple bot configs (different feeds - e.g. separate FreshRSS
  // category exports) can deliberately share one Bluesky identifier so several feeds post
  // to one logical account. The same story appearing in both feeds must dedupe against
  // that shared identity, not against whichever bot config happened to discover it first.
  // Before this fix, dedupeKey was computed from botId, so two differently-configured
  // bots sharing one identifier never recognized each other's posts as duplicates - the
  // same story got posted twice to the same account.
  const {reader: readerA} = createInstrumentedReader(t, {
    botId: 'trumpwatch-en',
    identifier: 'trumpwatch.skyfleet.blue',
  });
  const {reader: readerB} = createInstrumentedReader(t, {
    botId: 'trumpnews-en',
    identifier: 'trumpwatch.skyfleet.blue',
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

  assert.equal(emittedA[0]?.dedupeKey, emittedB[0]?.dedupeKey);
});

test('two bot configs with different identifiers compute different dedupeKeys for the same item', async t => {
  const {reader: readerA} = createInstrumentedReader(t, {identifier: 'accountA.example'});
  const {reader: readerB} = createInstrumentedReader(t, {identifier: 'accountB.example'});
  const emittedA: ParsedItem[] = [];
  const emittedB: ParsedItem[] = [];
  readerA.onItem(item => emittedA.push(item));
  readerB.onItem(item => emittedB.push(item));

  const item = normalizedItem({link: 'https://example.test/same-story'});

  await handleItem(readerA, item);
  await handleItem(readerB, item);

  assert.notEqual(emittedA[0]?.dedupeKey, emittedB[0]?.dedupeKey);
});

function startFeedResponseServer(
  status: number,
  body: string,
): Promise<{server: Server; port: number}> {
  return new Promise(resolve => {
    const server = createServer((_req, res) => {
      res.writeHead(status, {'Content-Type': 'application/rss+xml'});
      res.end(body);
    });
    server.listen(0, () => {
      const port = (server.address() as {port: number}).port;
      resolve({server, port});
    });
  });
}

const sampleFeedWithOneItem =
  '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><description>D</description><link>https://example.com</link><item><title>one</title><link>https://example.com/one</link><guid>https://example.com/one</guid><pubDate>Wed, 05 Aug 2026 09:00:00 GMT</pubDate></item></channel></rss>';
const emptyFeed =
  '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><description>D</description><link>https://example.com</link></channel></rss>';

// These three tests construct FeedReader with a real feedUrl pointed at a local test
// server (matching the existing resolveEmbedImage tests' own pattern below) and drive
// it through the real reader.start()/reader.stop(), since there is no longer a private
// EventEmitter to reach into and emit synthetic 'items'/'error' events on directly.
test('a poll with items records a successful feed poll', async t => {
  const {server, port} = await startFeedResponseServer(200, sampleFeedWithOneItem);
  t.after(() => server.close());

  const dir = mkdtempSync(join(tmpdir(), 'feedreader-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const store = new BotStore(join(dir, 'state.sqlite'));
  t.after(() => store.close());
  const runtime = createRuntime();

  const reader = new FeedReader(
    'test-bot',
    'test-bot',
    new URL(`http://127.0.0.1:${port}/feed.xml`),
    60,
    {string: '$title'},
    store,
    new SharedLimiters({
      maxConcurrentOpenGraphFetches: 1,
      maxConcurrentImageJobs: 1,
      maxImageDownloadBytes: 10_000_000,
      httpTimeoutMs: 5000,
    }),
    runtime,
  );
  t.after(() => reader.stop());
  reader.onItem(() => undefined);
  reader.start();

  await new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (runtime.operations.snapshot().counters.feedPollSucceeded > 0) {
        clearInterval(check);
        resolve();
      }
    }, 10);
  });

  const snapshot = runtime.operations.snapshot();
  assert.equal(snapshot.feedState, 'ok');
  assert.equal(snapshot.counters.feedPollSucceeded, 1);
});

const sampleFeedWithOneBadItem =
  '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><description>D</description><link>https://example.com</link><item><description>no title, only description</description><link>https://example.com/bad</link><guid>https://example.com/bad</guid><pubDate>Wed, 05 Aug 2026 09:00:00 GMT</pubDate></item></channel></rss>';

test('a single bad item is logged but does not affect feed health state', async t => {
  // Break caught: routing a per-item onItem failure through classifyFeedFailure/
  // recordFeedFailure would flip a healthy bot's feedState to 'failing' over one
  // malformed item, producing a false "Feed unavailable" alert - matching the
  // pre-migration feedsub-based behavior, where an 'item' handler rejection was
  // always a plain summary log, never a feed-health signal.
  const {server, port} = await startFeedResponseServer(200, sampleFeedWithOneBadItem);
  t.after(() => server.close());

  const dir = mkdtempSync(join(tmpdir(), 'feedreader-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const store = new BotStore(join(dir, 'state.sqlite'));
  t.after(() => store.close());
  const runtime = createRuntime();

  const reader = new FeedReader(
    'test-bot',
    'test-bot',
    new URL(`http://127.0.0.1:${port}/feed.xml`),
    60,
    {string: '$title'}, // the bad item has no title, so parseString throws for it
    store,
    new SharedLimiters({
      maxConcurrentOpenGraphFetches: 1,
      maxConcurrentImageJobs: 1,
      maxImageDownloadBytes: 10_000_000,
      httpTimeoutMs: 5000,
    }),
    runtime,
  );
  t.after(() => reader.stop());
  reader.onItem(() => undefined);
  reader.start();

  await new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (runtime.operations.snapshot().counters.feedPollSucceeded > 0) {
        clearInterval(check);
        resolve();
      }
    }, 10);
  });

  const snapshot = runtime.operations.snapshot();
  assert.equal(snapshot.feedState, 'ok');
  assert.equal(snapshot.counters.feedPollFailed, 0);
  assert.equal(snapshot.counters.feedPollSucceeded, 1);
  assert.deepEqual(
    runtime.records.filter(record => record.level === 'summary').map(record => record.message),
    ['Item handling failed'],
  );
});

test('an empty feed still records a successful feed poll', async t => {
  const {server, port} = await startFeedResponseServer(200, emptyFeed);
  t.after(() => server.close());

  const dir = mkdtempSync(join(tmpdir(), 'feedreader-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const store = new BotStore(join(dir, 'state.sqlite'));
  t.after(() => store.close());
  const runtime = createRuntime();

  const reader = new FeedReader(
    'test-bot',
    'test-bot',
    new URL(`http://127.0.0.1:${port}/feed.xml`),
    60,
    {string: '$title'},
    store,
    new SharedLimiters({
      maxConcurrentOpenGraphFetches: 1,
      maxConcurrentImageJobs: 1,
      maxImageDownloadBytes: 10_000_000,
      httpTimeoutMs: 5000,
    }),
    runtime,
  );
  t.after(() => reader.stop());
  reader.onItem(() => undefined);
  reader.start();

  await new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (runtime.operations.snapshot().counters.feedPollSucceeded > 0) {
        clearInterval(check);
        resolve();
      }
    }, 10);
  });

  assert.equal(runtime.operations.snapshot().counters.feedPollSucceeded, 1);
});

test('a feed-fetch failure is recorded and logged per-bot, not an uncaught exception', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'feedreader-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const store = new BotStore(join(dir, 'state.sqlite'));
  t.after(() => store.close());
  const runtime = createRuntime();

  const reader = new FeedReader(
    'test-bot',
    'test-bot',
    new URL('http://127.0.0.1:1/feed.xml'), // unroutable port - always fails to fetch
    60,
    {string: '$title'},
    store,
    new SharedLimiters({
      maxConcurrentOpenGraphFetches: 1,
      maxConcurrentImageJobs: 1,
      maxImageDownloadBytes: 10_000_000,
      httpTimeoutMs: 500,
    }),
    runtime,
  );
  t.after(() => reader.stop());
  reader.onItem(() => undefined);

  await assert.doesNotReject(async () => {
    reader.start();
    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (runtime.operations.snapshot().counters.feedPollFailed > 0) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });
  });

  const snapshot = runtime.operations.snapshot();
  assert.equal(snapshot.feedState, 'failing');
  assert.equal(snapshot.counters.feedPollFailed, 1);
});

function startFailThenSucceedServer(
  failCount: number,
  successBody: string,
): Promise<{server: Server; port: number}> {
  let requests = 0;
  return new Promise(resolve => {
    const server = createServer((_req, res) => {
      requests++;
      if (requests <= failCount) {
        res.writeHead(500);
        res.end('fail');
      } else {
        res.writeHead(200, {'Content-Type': 'application/rss+xml'});
        res.end(successBody);
      }
    });
    server.listen(0, () => {
      const port = (server.address() as {port: number}).port;
      resolve({server, port});
    });
  });
}

test('feed failures are summarized once and a later poll records the exact recovery count', async t => {
  // Break caught: logging every failed poll creates an incident flood, while losing
  // the prior count makes a recovery impossible to assess from the summary line.
  const {server, port} = await startFailThenSucceedServer(2, sampleFeedWithOneItem);
  t.after(() => server.close());

  const dir = mkdtempSync(join(tmpdir(), 'feedreader-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const store = new BotStore(join(dir, 'state.sqlite'));
  t.after(() => store.close());
  const runtime = createRuntime();

  const reader = new FeedReader(
    'test-bot',
    'test-bot',
    new URL(`http://127.0.0.1:${port}/feed.xml`),
    1 / 1200, // 50ms - a fractional-minute interval used only to make this test's
    // multiple poll cycles observable within a normal test timeout.
    {string: '$title'},
    store,
    new SharedLimiters({
      maxConcurrentOpenGraphFetches: 1,
      maxConcurrentImageJobs: 1,
      maxImageDownloadBytes: 10_000_000,
      httpTimeoutMs: 500,
    }),
    runtime,
  );
  t.after(() => reader.stop());
  reader.onItem(() => undefined);

  await new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (runtime.operations.snapshot().counters.feedPollSucceeded > 0) {
        clearInterval(check);
        resolve();
      }
    }, 10);
    reader.start();
  });

  const snapshot = runtime.operations.snapshot();
  assert.equal(snapshot.feedState, 'ok');
  assert.equal(snapshot.counters.feedPollFailed, 2);
  assert.equal(snapshot.counters.feedPollSucceeded, 1);
  assert.equal(snapshot.consecutiveFeedFailures, 0);
  assert.deepEqual(
    runtime.records.filter(record => record.level === 'summary').map(record => record.message),
    ['Feed unavailable (http-500)', 'Feed recovered after 2 failed poll(s)'],
  );
});

test('a successful Open Graph fetch records success', async t => {
  // Break caught: accepting the fetched Open Graph result without recording its
  // outcome makes the operations snapshot undercount successful enrichment.
  const {reader, runtime} = createInstrumentedReader(t, {
    config: {publishEmbed: true, embedType: 'card'},
    fetchOpenGraph: async () => ({
      ogTitle: 'Open Graph title',
      ogDescription: 'Open Graph description',
      ogUrl: 'https://example.test/canonical',
    }),
  });
  const emitted: unknown[] = [];
  reader.onItem(item => emitted.push(item));

  await handleItem(
    reader,
    normalizedItem({
      id: 'https://example.test/article',
      title: 'RSS title',
      link: 'https://example.test/article',
      description: 'RSS description',
      date: '2026-08-03T12:01:00.000Z',
    }),
  );

  assert.equal(runtime.operations.snapshot().counters.openGraphSucceeded, 1);
  assert.equal(runtime.operations.snapshot().counters.openGraphFallback, 0);
  assert.ok(
    runtime.records.some(
      record =>
        record.level === 'debug' && /Open Graph fetch completed in \d+ms/.test(record.message),
    ),
  );
  assert.deepEqual(emitted, [
    {
      title: 'RSS title',
      content: 'RSS title',
      facets: [],
      embed: {
        uri: 'https://example.test/canonical',
        title: 'Open Graph title',
        description: 'Open Graph description',
        imageUrl: undefined,
        imageAlt: undefined,
        type: 'card',
      },
      languages: undefined,
      itemDate: '2026-08-03T12:01:00.000Z',
      dedupeKey: computeDedupeKey('test-bot', 'https://example.test/article'),
    },
  ]);
});

test('a rejected Open Graph fetch records fallback without leaking item details to summary logs', async t => {
  // Break caught: a rejected enrichment request must retain today's RSS-derived
  // embed fallback, but leaking its URL/title/error to summary logs exposes noisy
  // operational detail and makes a harmless fallback look like a feed outage.
  const itemUrl = 'https://private.example.test/article';
  const itemTitle = 'Sensitive RSS title';
  const rawError = 'upstream token should stay debug-only';
  const {reader, runtime} = createInstrumentedReader(t, {
    config: {publishEmbed: true, embedType: 'card'},
    fetchOpenGraph: async () => {
      throw new Error(rawError);
    },
  });
  const emitted: ParsedItem[] = [];
  reader.onItem(item => emitted.push(item));

  await handleItem(
    reader,
    normalizedItem({
      id: itemUrl,
      title: itemTitle,
      link: itemUrl,
      description: 'RSS fallback description',
      date: '2026-08-03T12:01:00.000Z',
    }),
  );

  assert.deepEqual(emitted[0]!.embed, {
    uri: itemUrl,
    title: itemTitle,
    description: 'RSS fallback description',
    imageUrl: undefined,
    imageAlt: undefined,
    type: 'card',
  });
  assert.equal(runtime.operations.snapshot().counters.openGraphSucceeded, 0);
  assert.equal(runtime.operations.snapshot().counters.openGraphFallback, 1);

  const summaries = runtime.records.filter(record => record.level === 'summary');
  assert.equal(summaries.length, 0);
  assert.equal(
    summaries.some(record =>
      [itemUrl, itemTitle, rawError].some(sensitiveDetail =>
        record.message.includes(sensitiveDetail),
      ),
    ),
    false,
  );
  assert.ok(
    runtime.records.some(
      record =>
        record.level === 'verbose' &&
        record.message.includes(itemUrl) &&
        record.message.includes(itemTitle),
    ),
  );
  assert.ok(
    runtime.records.some(record => record.level === 'debug' && record.message.includes(rawError)),
  );
});

test('an Open Graph rejection with undefined still records fallback and returns the RSS embed', async t => {
  // Break caught: using an optional error field as the result discriminant turns
  // Promise.reject(undefined) into a false success, so fallback data is lost.
  const itemUrl = 'https://example.test/undefined-rejection';
  const {reader, runtime} = createInstrumentedReader(t, {
    config: {publishEmbed: true, embedType: 'card'},
    fetchOpenGraph: async () => Promise.reject(undefined),
  });
  const emitted: ParsedItem[] = [];
  reader.onItem(item => emitted.push(item));

  await handleItem(
    reader,
    normalizedItem({
      id: itemUrl,
      title: 'RSS fallback title',
      link: itemUrl,
      description: 'RSS fallback description',
      date: '2026-08-03T12:01:00.000Z',
    }),
  );

  assert.deepEqual(emitted[0]!.embed, {
    uri: itemUrl,
    title: 'RSS fallback title',
    description: 'RSS fallback description',
    imageUrl: undefined,
    imageAlt: undefined,
    type: 'card',
  });
  const counters = runtime.operations.snapshot().counters;
  assert.equal(counters.openGraphSucceeded, 0);
  assert.equal(counters.openGraphFallback, 1);
});

function startFixedResponseServer(body: Buffer): Promise<{server: Server; port: number}> {
  return new Promise(resolve => {
    const server = createServer((_req, res) => {
      res.writeHead(200, {'Content-Type': 'image/jpeg'});
      res.end(body);
    });
    server.listen(0, () => {
      const port = (server.address() as {port: number}).port;
      resolve({server, port});
    });
  });
}

test('resolveEmbedImage returns undefined when the response exceeds maxImageDownloadBytes', async t => {
  const {server, port} = await startFixedResponseServer(Buffer.alloc(2000));
  t.after(() => server.close());

  const dir = mkdtempSync(join(tmpdir(), 'feedreader-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const store = new BotStore(join(dir, 'state.sqlite'));
  t.after(() => store.close());

  const sharedLimiters = new SharedLimiters({
    maxConcurrentOpenGraphFetches: 1,
    maxConcurrentImageJobs: 1,
    maxImageDownloadBytes: 1000,
    httpTimeoutMs: 5000,
  });

  const runtime = createRuntime();
  const reader = new FeedReader(
    'test-bot',
    'test-bot',
    new URL(`http://127.0.0.1:${port}/feed.xml`),
    5,
    {string: '$title'},
    store,
    sharedLimiters,
    runtime,
  );

  const result = await reader.resolveEmbedImage(`http://127.0.0.1:${port}/image.jpg`);
  assert.equal(result, undefined);
  assert.ok(
    runtime.records.some(
      record => record.level === 'debug' && /image download failed/i.test(record.message),
    ),
  );
  assert.ok(
    runtime.records.some(
      record =>
        record.level === 'debug' && /image download completed in \d+ms/i.test(record.message),
    ),
  );
});

test('resolveEmbedImage succeeds when the response is within maxImageDownloadBytes', async t => {
  // Must be real, decodable JPEG bytes: resolveEmbedImage feeds the response body
  // through jimp to resize it, and jimp rejects arbitrary/zero-filled bytes as
  // "Could not find MIME for Buffer" regardless of whether the size cap passed.
  const image = await jimp.create(2, 2, 0xff0000ff);
  const imageBuffer = await image.getBufferAsync(jimp.MIME_JPEG);

  const {server, port} = await startFixedResponseServer(imageBuffer);
  t.after(() => server.close());

  const dir = mkdtempSync(join(tmpdir(), 'feedreader-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const store = new BotStore(join(dir, 'state.sqlite'));
  t.after(() => store.close());

  const sharedLimiters = new SharedLimiters({
    maxConcurrentOpenGraphFetches: 1,
    maxConcurrentImageJobs: 1,
    maxImageDownloadBytes: 10_000_000,
    httpTimeoutMs: 5000,
  });

  const reader = new FeedReader(
    'test-bot',
    'test-bot',
    new URL(`http://127.0.0.1:${port}/feed.xml`),
    5,
    {string: '$title'},
    store,
    sharedLimiters,
    createRuntime(),
  );

  const result = await reader.resolveEmbedImage(`http://127.0.0.1:${port}/image.jpg`);
  assert.ok(result, 'a within-cap image should resolve to a Buffer, not undefined');
});
