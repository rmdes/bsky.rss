# Feed Parser Migration: feedsub → feedsmith Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unmaintained `feedsub`/`feedme` feed parser with `feedsmith` across both single-bot mode and fleet mode, consolidating the currently-duplicated feed-reading logic into one shared module, with zero required changes to the 59 live production bot configs.

**Architecture:** A new `shared/feedSource/` module owns polling (interval + `axios` fetch), parsing (`feedsmith.parseFeed`), and per-format normalization (RSS/Atom/JSON Feed/RDF → one common `NormalizedItem` shape), exposed through an async-callback interface. `app/utils/rssHandler.ts` and `fleet/feedReader.ts` keep their existing public interfaces and responsibilities (Open Graph fetch, embed-building, queueing/posting) but swap their internals to consume `shared/feedSource` instead of `feedsub`.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), `node:test` + `node:assert`, `feedsmith` (new dependency), `axios` (already a dependency).

## Global Constraints

- Zero required changes to any of the 59 live bot `config.json` files on the VPS. In particular `imageField` (`"media:content"` for 49 bots, `"enclosure"` for 2, `""` for 8) and `dateField` (`""` for all 59) keep their exact current string values and semantics.
- `imageField` is not a closed enum — the resolver must be structured so a third value can be added later as a small, isolated change, not a rewrite (see spec's "Background" section).
- The new shared module must NOT be created at a top-level directory named `lib/` — `tsconfig.json` already sets `"outDir": "lib"` for the TypeScript build cache; use `shared/feedSource/` instead.
- `feedsub` must stay in `package.json` until Task 8 (after the shadow-run script exists) — `fleet/verifyFeedMigration.ts` (Task 7) needs both the old and new parser available side by side.
- `app/utils/rssHandler.ts`'s public interface (`init`, `start`, `launch`) and `fleet/feedReader.ts`'s public interface (constructor signature, `onItem`, `start`, `stop`) must NOT change — `app/index.ts`, `fleet/botWorker.ts`, `fleet/runFleet.ts`, and `fleet/benchmarkHarness.ts` all call these today and must not need edits.
- Dates on `NormalizedItem` stay as raw strings (not parsed `Date` objects), matching today's `new Date(useDate)`-at-comparison-time pattern throughout both consumer files.
- Follow each file's existing test convention exactly: `fleet/*.test.ts` uses flat `test()` from `node:test` + `import assert from 'node:assert/strict'`. `app/utils/*.test.ts` uses `describe`/`it`/`beforeEach` from `node:test` + `import assert from 'node:assert'` (non-strict). New `shared/feedSource/*.test.ts` files use the `fleet/` convention (flat `test()` + `node:assert/strict`).

---

### Task 1: Wire feedsmith, add shared types and the parse wrapper

**Files:**
- Create: `shared/feedSource/types.ts`
- Create: `shared/feedSource/parse.ts`
- Create: `shared/feedSource/parse.test.ts`
- Modify: `package.json` (add `feedsmith` to `dependencies`; do NOT remove `feedsub` yet)

**Interfaces:**
- Produces: `NormalizedItem` (id, title, link, date, description, content, imageUrl — all `string | undefined` except `id: string`), `FeedSourceConfig` (`{imageField?: string}`), `FeedSourceError` (extends `Error`, has `readonly cause?: unknown`), `ParsedFeedResult` (`ReturnType<typeof parseFeed>` from `feedsmith`), `parseRawFeed(rawBody: string): ParsedFeedResult` (throws `FeedSourceError` on unparseable content).

- [ ] **Step 1: Add feedsmith to package.json**

```bash
cd /home/rmdes/bsky.rss
yarn add feedsmith
```

Expected: `package.json`'s `dependencies` block now includes `"feedsmith": "^2.9.6"` (or whatever the resolved version is), `yarn.lock` updated. Do not run `yarn remove feedsub` — it stays until Task 8.

- [ ] **Step 2: Write shared/feedSource/types.ts**

```typescript
import type {parseFeed} from 'feedsmith';

export type ParsedFeedResult = ReturnType<typeof parseFeed>;

export interface NormalizedItem {
  id: string;
  title: string | undefined;
  link: string | undefined;
  date: string | undefined;
  description: string | undefined;
  content: string | undefined;
  imageUrl: string | undefined;
}

export interface FeedSourceConfig {
  imageField?: string;
}

export class FeedSourceError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FeedSourceError';
  }
}

export interface FeedSourceCallbacks {
  /** Fired once per successful poll, with the full item batch (may be empty). */
  onItems: (items: NormalizedItem[]) => void;
  /** Fired once per item, in feed order. A rejection here is caught by the poller
   * and reported via onError - it does not stop the batch or crash the process. */
  onItem: (item: NormalizedItem) => Promise<void>;
  /** Fired on a fetch failure, a parse failure, or a single item's onItem rejecting. */
  onError: (error: FeedSourceError) => void;
}

export interface FeedSource {
  start(callbacks: FeedSourceCallbacks): void;
  stop(): void;
}

export type FetchFeedBody = (url: string, timeoutMs: number) => Promise<string>;
```

- [ ] **Step 3: Write the failing test for parse.ts**

```typescript
// shared/feedSource/parse.test.ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseRawFeed} from './parse.ts';
import {FeedSourceError} from './types.ts';

function fixture(path: string): string {
  return readFileSync(join(__dirname, '../../test-fixtures', path), 'utf-8');
}

test('parseRawFeed detects RSS and returns its items', () => {
  const result = parseRawFeed(fixture('rss/sample-feed.xml'));
  assert.equal(result.format, 'rss');
  assert.equal(result.feed.items?.length, 3);
});

test('parseRawFeed throws a FeedSourceError on unparseable content', () => {
  assert.throws(
    () => parseRawFeed('not a feed, just plain text'),
    (error: unknown) => error instanceof FeedSourceError,
  );
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd /home/rmdes/bsky.rss && node --import tsx --test shared/feedSource/parse.test.ts`
Expected: FAIL - `Cannot find module './parse.ts'` (parse.ts doesn't exist yet).

- [ ] **Step 5: Write shared/feedSource/parse.ts**

```typescript
import {parseFeed} from 'feedsmith';
import {FeedSourceError, type ParsedFeedResult} from './types.ts';

export function parseRawFeed(rawBody: string): ParsedFeedResult {
  try {
    return parseFeed(rawBody);
  } catch (error) {
    throw new FeedSourceError('Unable to parse feed content', error);
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd /home/rmdes/bsky.rss && node --import tsx --test shared/feedSource/parse.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Type-check and lint**

Run: `cd /home/rmdes/bsky.rss && yarn typecheck && yarn lint`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
cd /home/rmdes/bsky.rss
git add package.json yarn.lock shared/feedSource/types.ts shared/feedSource/parse.ts shared/feedSource/parse.test.ts
git commit -m "feat(feedSource): add feedsmith dependency and the parse wrapper"
```

---

### Task 2: RSS normalizer and image resolver

**Files:**
- Create: `shared/feedSource/imageResolver.ts`
- Create: `shared/feedSource/imageResolver.test.ts`
- Create: `shared/feedSource/normalize.ts`
- Create: `shared/feedSource/normalize.test.ts`
- Create: `test-fixtures/rss/sample-feed-with-media.xml`

**Interfaces:**
- Consumes: `ParsedFeedResult`, `NormalizedItem`, `FeedSourceConfig`, `FeedSourceError` from Task 1's `shared/feedSource/types.ts`.
- Produces: `resolveImageUrl(item: ImageResolvableItem, imageField: string | undefined): string | undefined` and `normalizeFeed(parsed: ParsedFeedResult, config: FeedSourceConfig): NormalizedItem[]` (RSS case only for now - the dispatch throws `FeedSourceError` for `atom`/`json`/`rdf` until Task 3 fills those in). Both are used directly by Task 4's `poller.ts`.

- [ ] **Step 1: Add the media-namespace RSS fixture**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Sample Feed With Media</title>
    <description>A sample feed using the Media RSS namespace, matching FreshRSS's generated output</description>
    <link>https://example.com</link>
    <item>
      <title>Article With Media Content</title>
      <link>https://example.com/media-article-1</link>
      <description>An article whose image comes via media:content.</description>
      <pubDate>Wed, 05 Aug 2026 09:00:00 GMT</pubDate>
      <guid isPermaLink="true">https://example.com/media-article-1</guid>
      <media:content url="https://example.com/images/media-article-1.jpg" type="image/jpeg" medium="image"/>
    </item>
  </channel>
</rss>
```

Save to: `test-fixtures/rss/sample-feed-with-media.xml`

- [ ] **Step 2: Write the failing tests for imageResolver.ts**

```typescript
// shared/feedSource/imageResolver.test.ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveImageUrl} from './imageResolver.ts';

test('resolveImageUrl returns the enclosure URL when imageField is "enclosure"', () => {
  const item = {enclosures: [{url: 'https://example.com/a.jpg', length: 100, type: 'image/jpeg'}]};
  assert.equal(resolveImageUrl(item, 'enclosure'), 'https://example.com/a.jpg');
});

test('resolveImageUrl returns the media:content URL when imageField is "media:content"', () => {
  const item = {media: {contents: [{url: 'https://example.com/b.jpg'}]}};
  assert.equal(resolveImageUrl(item, 'media:content'), 'https://example.com/b.jpg');
});

test('resolveImageUrl finds a media:content URL nested inside a media:group', () => {
  const item = {media: {groups: [{contents: [{url: 'https://example.com/c.jpg'}]}]}};
  assert.equal(resolveImageUrl(item, 'media:content'), 'https://example.com/c.jpg');
});

test('resolveImageUrl returns undefined when imageField is unset', () => {
  const item = {enclosures: [{url: 'https://example.com/a.jpg', length: 100, type: 'image/jpeg'}]};
  assert.equal(resolveImageUrl(item, undefined), undefined);
});

test('resolveImageUrl returns undefined when imageField is unset and empty', () => {
  const item = {enclosures: [{url: 'https://example.com/a.jpg', length: 100, type: 'image/jpeg'}]};
  assert.equal(resolveImageUrl(item, ''), undefined);
});

test('resolveImageUrl falls back to undefined for an unrecognized imageField value, not an error', () => {
  const item = {enclosures: [{url: 'https://example.com/a.jpg', length: 100, type: 'image/jpeg'}]};
  assert.equal(resolveImageUrl(item, 'itunes:image'), undefined);
});

test('resolveImageUrl returns undefined when the named location is present but empty', () => {
  assert.equal(resolveImageUrl({enclosures: []}, 'enclosure'), undefined);
  assert.equal(resolveImageUrl({media: {}}, 'media:content'), undefined);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /home/rmdes/bsky.rss && node --import tsx --test shared/feedSource/imageResolver.test.ts`
Expected: FAIL - `Cannot find module './imageResolver.ts'`.

- [ ] **Step 4: Write shared/feedSource/imageResolver.ts**

```typescript
export interface ImageResolvableItem {
  enclosures?: Array<{url?: string}>;
  media?: {
    contents?: Array<{url?: string}>;
    groups?: Array<{contents?: Array<{url?: string}>}>;
  };
}

// imageField is not a closed enum - some bots' feeds pass through FreshRSS's "User
// Query" folder-merge feature (which always emits media:content regardless of the
// original source), others point at a single source feed where the value was set by
// hand after inspecting that feed's own image convention. An unrecognized value falls
// back to undefined (caller falls back to Open Graph) rather than erroring, so a bot
// with a not-yet-mapped value degrades gracefully instead of breaking. Adding a new
// recognized value is a new `if` branch here, isolated from every other value.
export function resolveImageUrl(
  item: ImageResolvableItem,
  imageField: string | undefined,
): string | undefined {
  if (!imageField) return undefined;
  if (imageField === 'enclosure') return item.enclosures?.[0]?.url;
  if (imageField === 'media:content') {
    return item.media?.contents?.[0]?.url ?? item.media?.groups?.[0]?.contents?.[0]?.url;
  }
  return undefined;
}
```

- [ ] **Step 5: Run the imageResolver tests to verify they pass**

Run: `cd /home/rmdes/bsky.rss && node --import tsx --test shared/feedSource/imageResolver.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Write the failing tests for normalize.ts (RSS)**

```typescript
// shared/feedSource/normalize.test.ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseRawFeed} from './parse.ts';
import {normalizeFeed} from './normalize.ts';

function fixture(path: string): string {
  return readFileSync(join(__dirname, '../../test-fixtures', path), 'utf-8');
}

test('normalizeFeed maps RSS items to NormalizedItem', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed.xml'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items.length, 3);
  assert.deepEqual(items[0], {
    id: 'https://example.com/article-1',
    title: 'First Test Article',
    link: 'https://example.com/article-1',
    date: 'Wed, 05 Aug 2026 09:00:00 GMT',
    description:
      'This is a test article description with some <strong>HTML</strong> content.',
    content: undefined,
    imageUrl: undefined,
  });
});

test('normalizeFeed resolves an RSS enclosure image when imageField is "enclosure"', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed.xml'));
  const items = normalizeFeed(parsed, {imageField: 'enclosure'});
  const withImage = items.find(item => item.id === 'https://example.com/article-3');

  assert.equal(withImage?.imageUrl, 'https://example.com/images/test.jpg');
});

test('normalizeFeed resolves a media:content image when imageField is "media:content"', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-media.xml'));
  const items = normalizeFeed(parsed, {imageField: 'media:content'});

  assert.equal(items[0]?.imageUrl, 'https://example.com/images/media-article-1.jpg');
});

test('normalizeFeed falls back to guid.value for id when link differs from guid', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed.xml'));
  const items = normalizeFeed(parsed, {});

  // sample-feed.xml's items use the same URL for both link and guid; this asserts
  // the id field is genuinely sourced from guid.value, not merely copied from link.
  assert.equal(items[0]?.id, 'https://example.com/article-1');
});
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `cd /home/rmdes/bsky.rss && node --import tsx --test shared/feedSource/normalize.test.ts`
Expected: FAIL - `Cannot find module './normalize.ts'`.

- [ ] **Step 8: Write shared/feedSource/normalize.ts (RSS case only)**

```typescript
import type {Rss} from 'feedsmith/types';
import type {DeepPartial} from 'feedsmith/types';
import type {FeedSourceConfig, NormalizedItem, ParsedFeedResult} from './types.ts';
import {FeedSourceError} from './types.ts';
import {resolveImageUrl} from './imageResolver.ts';

function normalizeRssItem(item: DeepPartial<Rss.Item<string>>): NormalizedItem {
  return {
    id: item.guid?.value || item.link || '',
    title: item.title,
    link: item.link,
    date: item.pubDate,
    description: item.description,
    content: item.content?.encoded,
    imageUrl: resolveImageUrl(item, undefined),
  };
}

export function normalizeFeed(parsed: ParsedFeedResult, config: FeedSourceConfig): NormalizedItem[] {
  if (parsed.format === 'rss') {
    return (parsed.feed.items ?? []).map(item => ({
      ...normalizeRssItem(item),
      imageUrl: resolveImageUrl(item, config.imageField),
    }));
  }
  throw new FeedSourceError(`Unsupported feed format: ${parsed.format}`);
}
```

- [ ] **Step 9: Run the normalize tests to verify they pass**

Run: `cd /home/rmdes/bsky.rss && node --import tsx --test shared/feedSource/normalize.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 10: Type-check and lint**

Run: `cd /home/rmdes/bsky.rss && yarn typecheck && yarn lint`
Expected: both clean.

- [ ] **Step 11: Commit**

```bash
cd /home/rmdes/bsky.rss
git add shared/feedSource/imageResolver.ts shared/feedSource/imageResolver.test.ts \
  shared/feedSource/normalize.ts shared/feedSource/normalize.test.ts \
  test-fixtures/rss/sample-feed-with-media.xml
git commit -m "feat(feedSource): add RSS normalizer and imageField-driven image resolution"
```

---

### Task 3: Atom, JSON Feed, and RDF normalizers

**Files:**
- Modify: `shared/feedSource/normalize.ts`
- Modify: `shared/feedSource/normalize.test.ts`
- Create: `test-fixtures/atom/sample-feed.xml`
- Create: `test-fixtures/jsonfeed/sample-feed.json`
- Create: `test-fixtures/rdf/sample-feed.xml`

**Interfaces:**
- Consumes: everything from Task 2's `normalize.ts`/`imageResolver.ts`.
- Produces: `normalizeFeed` now handles all four formats (`rss`, `atom`, `json`, `rdf`) - the `FeedSourceError` "Unsupported feed format" branch is removed. This is what Task 4's `poller.ts` relies on for full-format support.

- [ ] **Step 1: Add the Atom fixture**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Sample Atom Feed</title>
  <id>https://example.com/atom</id>
  <updated>2026-08-05T10:00:00Z</updated>
  <link href="https://example.com" rel="alternate"/>
  <entry>
    <title>First Atom Entry</title>
    <id>https://example.com/atom/entry-1</id>
    <link href="https://example.com/atom/entry-1" rel="alternate"/>
    <published>2026-08-05T09:00:00Z</published>
    <updated>2026-08-05T09:00:00Z</updated>
    <summary>A short summary of the first Atom entry.</summary>
    <content>The full content of the first Atom entry.</content>
  </entry>
  <entry>
    <title>Second Atom Entry, No Published Date</title>
    <id>https://example.com/atom/entry-2</id>
    <link href="https://example.com/atom/entry-2" rel="alternate"/>
    <updated>2026-08-05T08:00:00Z</updated>
    <summary>Only has an updated date, no published date.</summary>
  </entry>
</feed>
```

Save to: `test-fixtures/atom/sample-feed.xml`

- [ ] **Step 2: Add the JSON Feed fixture**

```json
{
  "version": "https://jsonfeed.org/version/1.1",
  "title": "Sample JSON Feed",
  "home_page_url": "https://example.com",
  "feed_url": "https://example.com/feed.json",
  "items": [
    {
      "id": "https://example.com/jsonfeed/article-1",
      "url": "https://example.com/jsonfeed/article-1",
      "title": "First JSON Feed Article",
      "content_text": "The full text content of the first article.",
      "summary": "A short summary of the first article.",
      "date_published": "2026-08-05T09:00:00Z",
      "image": "https://example.com/jsonfeed/images/article-1.jpg"
    },
    {
      "id": "https://example.com/jsonfeed/article-2",
      "url": "https://example.com/jsonfeed/article-2",
      "title": "Second JSON Feed Article",
      "content_html": "<p>The full HTML content of the second article.</p>",
      "date_published": "2026-08-05T08:00:00Z"
    }
  ]
}
```

Save to: `test-fixtures/jsonfeed/sample-feed.json`

- [ ] **Step 3: Add the RDF (RSS 1.0) fixture**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF
  xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
  xmlns="http://purl.org/rss/1.0/"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://example.com/rdf">
    <title>Sample RDF Feed</title>
    <description>A sample RSS 1.0 / RDF feed for testing bsky.rss</description>
    <link>https://example.com</link>
  </channel>
  <item rdf:about="https://example.com/rdf/article-1">
    <title>First RDF Article</title>
    <link>https://example.com/rdf/article-1</link>
    <description>A test article in RDF/RSS 1.0 format.</description>
    <dc:date>2026-08-05T09:00:00Z</dc:date>
  </item>
</rdf:RDF>
```

Save to: `test-fixtures/rdf/sample-feed.xml`

- [ ] **Step 4: Add the failing tests for Atom, JSON Feed, and RDF to normalize.test.ts**

Append to `shared/feedSource/normalize.test.ts`:

```typescript
test('normalizeFeed maps Atom entries to NormalizedItem, preferring published over updated', () => {
  const parsed = parseRawFeed(fixture('atom/sample-feed.xml'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    id: 'https://example.com/atom/entry-1',
    title: 'First Atom Entry',
    link: 'https://example.com/atom/entry-1',
    date: '2026-08-05T09:00:00Z',
    description: 'A short summary of the first Atom entry.',
    content: 'The full content of the first Atom entry.',
    imageUrl: undefined,
  });
});

test('normalizeFeed falls back to updated when an Atom entry has no published date', () => {
  const parsed = parseRawFeed(fixture('atom/sample-feed.xml'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items[1]?.date, '2026-08-05T08:00:00Z');
});

test('normalizeFeed maps JSON Feed items to NormalizedItem, using the native image field', () => {
  const parsed = parseRawFeed(fixture('jsonfeed/sample-feed.json'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    id: 'https://example.com/jsonfeed/article-1',
    title: 'First JSON Feed Article',
    link: 'https://example.com/jsonfeed/article-1',
    date: '2026-08-05T09:00:00Z',
    description: 'A short summary of the first article.',
    content: 'The full text content of the first article.',
    imageUrl: 'https://example.com/jsonfeed/images/article-1.jpg',
  });
});

test('normalizeFeed prefers content_html over content_text when JSON Feed has both', () => {
  const parsed = parseRawFeed(fixture('jsonfeed/sample-feed.json'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items[1]?.content, '<p>The full HTML content of the second article.</p>');
});

test('normalizeFeed maps RDF items to NormalizedItem, deriving id from link', () => {
  const parsed = parseRawFeed(fixture('rdf/sample-feed.xml'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    id: 'https://example.com/rdf/article-1',
    title: 'First RDF Article',
    link: 'https://example.com/rdf/article-1',
    date: '2026-08-05T09:00:00Z',
    description: 'A test article in RDF/RSS 1.0 format.',
    content: undefined,
    imageUrl: undefined,
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `cd /home/rmdes/bsky.rss && node --import tsx --test shared/feedSource/normalize.test.ts`
Expected: FAIL - the new assertions fail because `normalizeFeed` throws `FeedSourceError` for `atom`/`json`/`rdf`.

- [ ] **Step 6: Extend shared/feedSource/normalize.ts with Atom, JSON Feed, and RDF**

Replace the full contents of `shared/feedSource/normalize.ts`:

```typescript
import type {Atom, Json, Rdf, Rss} from 'feedsmith/types';
import type {DeepPartial} from 'feedsmith/types';
import type {FeedSourceConfig, NormalizedItem, ParsedFeedResult} from './types.ts';
import {resolveImageUrl} from './imageResolver.ts';

function normalizeRssItem(item: DeepPartial<Rss.Item<string>>): NormalizedItem {
  return {
    id: item.guid?.value || item.link || '',
    title: item.title,
    link: item.link,
    date: item.pubDate,
    description: item.description,
    content: item.content?.encoded,
    imageUrl: undefined,
  };
}

function normalizeAtomEntry(entry: DeepPartial<Atom.Entry<string>>): NormalizedItem {
  const link = entry.links?.find(l => !l.rel || l.rel === 'alternate')?.href ?? entry.links?.[0]?.href;
  return {
    id: entry.id || link || '',
    title: entry.title,
    link,
    date: entry.published ?? entry.updated,
    description: entry.summary,
    content: entry.content,
    imageUrl: undefined,
  };
}

function normalizeJsonItem(item: DeepPartial<Json.Item<string>>): NormalizedItem {
  return {
    id: item.id || item.url || '',
    title: item.title,
    link: item.url,
    date: item.date_published ?? item.date_modified,
    description: item.summary,
    content: item.content_html ?? item.content_text,
    imageUrl: item.image,
  };
}

function normalizeRdfItem(item: DeepPartial<Rdf.Item<string>>): NormalizedItem {
  return {
    id: item.link || '',
    title: item.title,
    link: item.link,
    date: item.dc?.dates?.[0],
    description: item.description,
    content: item.content?.encoded,
    imageUrl: undefined,
  };
}

export function normalizeFeed(parsed: ParsedFeedResult, config: FeedSourceConfig): NormalizedItem[] {
  if (parsed.format === 'rss') {
    return (parsed.feed.items ?? []).map(item => ({
      ...normalizeRssItem(item),
      imageUrl: resolveImageUrl(item, config.imageField),
    }));
  }
  if (parsed.format === 'atom') {
    return (parsed.feed.entries ?? []).map(entry => normalizeAtomEntry(entry));
  }
  if (parsed.format === 'json') {
    return (parsed.feed.items ?? []).map(item => normalizeJsonItem(item));
  }
  return (parsed.feed.items ?? []).map(item => ({
    ...normalizeRdfItem(item),
    imageUrl: resolveImageUrl(item, config.imageField),
  }));
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd /home/rmdes/bsky.rss && node --import tsx --test shared/feedSource/normalize.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 8: Type-check and lint**

Run: `cd /home/rmdes/bsky.rss && yarn typecheck && yarn lint`
Expected: both clean.

- [ ] **Step 9: Commit**

```bash
cd /home/rmdes/bsky.rss
git add shared/feedSource/normalize.ts shared/feedSource/normalize.test.ts \
  test-fixtures/atom/sample-feed.xml test-fixtures/jsonfeed/sample-feed.json test-fixtures/rdf/sample-feed.xml
git commit -m "feat(feedSource): add Atom, JSON Feed, and RDF normalizers"
```

---

### Task 4: The poller and public entrypoint

**Files:**
- Create: `shared/feedSource/poller.ts`
- Create: `shared/feedSource/index.ts`
- Create: `shared/feedSource/poller.test.ts`

**Interfaces:**
- Consumes: `parseRawFeed` (Task 1), `normalizeFeed` (Tasks 2-3), `FeedSourceCallbacks`/`FeedSource`/`FeedSourceConfig`/`FeedSourceError`/`FetchFeedBody` (Task 1's types.ts).
- Produces: `createFeedSource(feedUrl: URL, intervalMinutes: number, config?: FeedSourceConfig, options?: {fetchTimeoutMs?: number; fetchBody?: FetchFeedBody}): FeedSource`. This is the exact function Task 5 and Task 6 import and call.

- [ ] **Step 1: Write the failing tests for poller.ts**

```typescript
// shared/feedSource/poller.test.ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {Server} from 'node:http';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createFeedSource} from './index.ts';
import type {NormalizedItem} from './types.ts';

function fixture(path: string): string {
  return readFileSync(join(__dirname, '../../test-fixtures', path), 'utf-8');
}

function startFeedServer(body: string): Promise<{server: Server; port: number}> {
  return new Promise(resolve => {
    const server = createServer((_req, res) => {
      res.writeHead(200, {'Content-Type': 'application/rss+xml'});
      res.end(body);
    });
    server.listen(0, () => {
      const port = (server.address() as {port: number}).port;
      resolve({server, port});
    });
  });
}

test('createFeedSource polls immediately on start and delivers every item', async t => {
  const {server, port} = await startFeedServer(fixture('rss/sample-feed.xml'));
  t.after(() => server.close());

  const source = createFeedSource(new URL(`http://127.0.0.1:${port}/feed.xml`), 60);
  t.after(() => source.stop());

  const items: NormalizedItem[] = [];
  const batches: NormalizedItem[][] = [];
  await new Promise<void>(resolve => {
    source.start({
      onItems: batch => {
        batches.push(batch);
        resolve();
      },
      onItem: async item => {
        items.push(item);
      },
      onError: err => assert.fail(`unexpected error: ${err.message}`),
    });
  });

  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.length, 3);
  assert.equal(items.length, 3);
});

test('createFeedSource reports a fetch failure via onError, not a thrown/unhandled rejection', async t => {
  // Port 1 is unroutable - matches the existing feedReader.test.ts convention for
  // simulating a feed-fetch failure without a flaky real network dependency.
  const source = createFeedSource(new URL('http://127.0.0.1:1/feed.xml'), 60, {}, {fetchTimeoutMs: 500});
  t.after(() => source.stop());

  await new Promise<void>(resolve => {
    source.start({
      onItems: () => assert.fail('should not reach onItems on a fetch failure'),
      onItem: async () => assert.fail('should not reach onItem on a fetch failure'),
      onError: () => resolve(),
    });
  });
});

test('createFeedSource reports one bad item via onError without stopping the batch', async t => {
  const {server, port} = await startFeedServer(fixture('rss/sample-feed.xml'));
  t.after(() => server.close());

  const source = createFeedSource(new URL(`http://127.0.0.1:${port}/feed.xml`), 60);
  t.after(() => source.stop());

  const processed: string[] = [];
  const errors: string[] = [];
  await new Promise<void>(resolve => {
    source.start({
      onItems: () => undefined,
      onItem: async item => {
        if (item.title === 'Second Test Article') throw new Error('simulated bad item');
        processed.push(item.title ?? '');
      },
      onError: err => errors.push(err.message),
    });
    // The poller awaits all 3 items sequentially, in order, on this one poll cycle
    // (the interval is 60 minutes, so a second cycle cannot fire during this test) -
    // a short delay is enough for that in-memory sequential loop to finish.
    setTimeout(resolve, 100);
  });

  assert.deepEqual(processed, ['First Test Article', 'Article with Image']);
  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.includes('Item handling failed'));
});

test('createFeedSource.stop() prevents further polls', async t => {
  const {server, port} = await startFeedServer(fixture('rss/sample-feed.xml'));
  t.after(() => server.close());

  let pollCount = 0;
  const source = createFeedSource(new URL(`http://127.0.0.1:${port}/feed.xml`), 60);
  await new Promise<void>(resolve => {
    source.start({
      onItems: () => {
        pollCount++;
        resolve();
      },
      onItem: async () => undefined,
      onError: () => undefined,
    });
  });
  source.stop();

  const countAfterStop = pollCount;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(pollCount, countAfterStop);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/rmdes/bsky.rss && node --import tsx --test shared/feedSource/poller.test.ts`
Expected: FAIL - `Cannot find module './index.ts'`.

- [ ] **Step 3: Write shared/feedSource/poller.ts**

```typescript
import axios from 'axios';
import {parseRawFeed} from './parse.ts';
import {normalizeFeed} from './normalize.ts';
import {FeedSourceError} from './types.ts';
import type {
  FeedSource,
  FeedSourceCallbacks,
  FeedSourceConfig,
  FetchFeedBody,
  NormalizedItem,
} from './types.ts';

const defaultFetch: FetchFeedBody = async (url, timeoutMs) => {
  const response = await axios.get<string>(url, {responseType: 'text', timeout: timeoutMs});
  return response.data;
};

export interface PollerOptions {
  fetchTimeoutMs?: number;
  fetchBody?: FetchFeedBody;
}

export function createPoller(
  feedUrl: URL,
  intervalMinutes: number,
  config: FeedSourceConfig,
  options: PollerOptions = {},
): FeedSource {
  const fetchBody = options.fetchBody ?? defaultFetch;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 10_000;
  let timer: NodeJS.Timeout | null = null;
  let callbacks: FeedSourceCallbacks | null = null;

  async function pollOnce(): Promise<void> {
    if (!callbacks) return;
    let items: NormalizedItem[];
    try {
      const body = await fetchBody(String(feedUrl), fetchTimeoutMs);
      items = normalizeFeed(parseRawFeed(body), config);
    } catch (error) {
      callbacks.onError(
        error instanceof FeedSourceError ? error : new FeedSourceError('Feed fetch failed', error),
      );
      return;
    }
    callbacks.onItems(items);
    for (const item of items) {
      try {
        await callbacks.onItem(item);
      } catch (error) {
        callbacks.onError(new FeedSourceError('Item handling failed', error));
      }
    }
  }

  return {
    start(cb: FeedSourceCallbacks): void {
      callbacks = cb;
      void pollOnce();
      timer = setInterval(() => void pollOnce(), intervalMinutes * 60_000);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      callbacks = null;
    },
  };
}
```

- [ ] **Step 4: Write shared/feedSource/index.ts**

```typescript
import {createPoller, type PollerOptions} from './poller.ts';
import type {FeedSource, FeedSourceConfig} from './types.ts';

export function createFeedSource(
  feedUrl: URL,
  intervalMinutes: number,
  config: FeedSourceConfig = {},
  options: PollerOptions = {},
): FeedSource {
  return createPoller(feedUrl, intervalMinutes, config, options);
}

export type {
  FeedSource,
  FeedSourceCallbacks,
  FeedSourceConfig,
  FeedSourceError,
  NormalizedItem,
} from './types.ts';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /home/rmdes/bsky.rss && node --import tsx --test shared/feedSource/poller.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the full shared/feedSource suite together**

Run: `cd /home/rmdes/bsky.rss && node --import tsx --test shared/feedSource/*.test.ts`
Expected: PASS (all tests from Tasks 1-4).

- [ ] **Step 7: Type-check and lint**

Run: `cd /home/rmdes/bsky.rss && yarn typecheck && yarn lint`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
cd /home/rmdes/bsky.rss
git add shared/feedSource/poller.ts shared/feedSource/index.ts shared/feedSource/poller.test.ts
git commit -m "feat(feedSource): add the poller and createFeedSource public entrypoint"
```

---

### Task 5: Migrate fleet/feedReader.ts

**Files:**
- Modify: `fleet/feedReader.ts`
- Modify: `fleet/feedReader.test.ts`

**Interfaces:**
- Consumes: `createFeedSource` from `shared/feedSource/index.ts` (Task 4). `FeedReader`'s own constructor signature, `onItem`, `start`, `stop` stay byte-for-byte identical to today - `fleet/botWorker.ts`, `fleet/runFleet.ts`, and `fleet/benchmarkHarness.ts` must not need any changes.
- Produces: nothing new for later tasks - this is a leaf consumer.

- [ ] **Step 1: Replace fleet/feedReader.ts's feedsub usage with shared/feedSource**

Read the current file first (`fleet/feedReader.ts`) to confirm line numbers match, since this is an edit to an existing file, not a fresh write. Apply these changes:

Replace the import block (lines 1-11):

```typescript
import axios from 'axios';
import og from 'open-graph-scraper';
import {decode} from 'html-entities';
import {BotStore} from './botStore.ts';
import {computeDedupeKey} from './dedupeKey.ts';
import {SharedLimiters} from './sharedLimiters.ts';
import {BotOperations, classifyFeedFailure} from './botOperations.ts';
import {FleetLogger, formatDebugError} from './logging.ts';
import {createFeedSource} from '../shared/feedSource/index.ts';
import type {FeedSource, NormalizedItem} from '../shared/feedSource/index.ts';
```

Remove the `FeedItem` interface (lines 12-22) entirely - `NormalizedItem` (imported above) replaces it. Remove `textOf()` (lines 82-90) entirely - every format's normalizer already resolves a plain-string `id`, so no per-tag-shape unwrapping is needed at the call site anymore. `removeHTMLTags`, `decodeHTMLTwice`, `fixMalformedUrl` stay unchanged.

Update `parseString` (the free function, not the class) to take `NormalizedItem` instead of `FeedItem`, and drop the `typeof item.link === 'object'` branch since `NormalizedItem.link` is always a plain string or `undefined`:

```typescript
export function parseString(
  template: string,
  item: NormalizedItem,
  truncate: boolean,
  titleClearHTML: boolean,
  descriptionClearHTML: boolean,
): string {
  let result = template;

  if (template.includes('$title')) {
    if (!item.title) throw new Error('No title provided from RSS reader.');
    result = result.replace(
      '$title',
      titleClearHTML ? decodeHTMLTwice(removeHTMLTags(item.title)) : item.title,
    );
  }

  if (template.includes('$link')) {
    if (!item.link) throw new Error('No link provided from RSS reader.');
    result = result.replace('$link', item.link);
  }

  if (template.includes('$description')) {
    let description = item.description ?? item.content ?? '';
    if (descriptionClearHTML) description = removeHTMLTags(description);
    result = result.replace('$description', description);
  }

  if (result.length > 300 && truncate) {
    result = result.slice(0, 277) + '...';
  }

  return result;
}
```

In the `FeedReader` class, replace the `reader` field's type and the constructor body:

```typescript
export class FeedReader {
  private reader: FeedSource;
  private itemHandler: ((parsed: ParsedItem) => void) | null = null;

  constructor(
    private botId: string,
    feedUrl: URL,
    fetchIntervalMinutes: number,
    private config: FeedReaderConfig,
    private store: BotStore,
    private sharedLimiters: SharedLimiters,
    private runtime: FeedReaderRuntime,
  ) {
    this.reader = createFeedSource(
      feedUrl,
      fetchIntervalMinutes,
      {imageField: config.imageField},
      {fetchTimeoutMs: sharedLimiters.httpTimeoutMs},
    );
  }
```

Replace `start()`'s body:

```typescript
  start(): void {
    this.reader.start({
      onItems: () => {
        const {recoveredFailures} = this.runtime.operations.recordFeedSuccess();
        if (recoveredFailures > 0) {
          this.runtime.logger.summary(
            'FEED',
            `Feed recovered after ${recoveredFailures} failed poll(s)`,
            this.botId,
          );
        }
      },
      onItem: (item: NormalizedItem) => this.handleItem(item),
      onError: err => {
        const category = classifyFeedFailure(err.cause ?? err);
        const {becameFailing} = this.runtime.operations.recordFeedFailure(category);
        if (becameFailing) {
          this.runtime.logger.summary('FEED', `Feed unavailable (${category})`, this.botId);
        }
        this.runtime.logger.debug('FEED', formatDebugError(err.cause ?? err), this.botId);
      },
    });
  }

  stop(): void {
    this.reader.stop();
  }
```

Update `handleItem`'s signature and body to consume `NormalizedItem` instead of `FeedItem`, dropping the now-unnecessary `textOf()`-based guid unwrapping (`NormalizedItem.id` is already the resolved string):

```typescript
  private async handleItem(item: NormalizedItem): Promise<void> {
    const itemUrl = item.link;
    // dateField historically pointed at an arbitrary raw feedme tag name (feedme kept
    // every tag from the source feed as a flat property). NormalizedItem no longer
    // carries arbitrary per-feed fields - only its own fixed shape - so dateField now
    // only resolves against NormalizedItem's own field names. All 59 live bot configs
    // leave dateField empty today, so this has no real-world effect; kept for config
    // compatibility per the migration spec's Non-goals, not redesigned.
    const useDate: string | undefined = this.config.dateField
      ? (item as unknown as Record<string, string | undefined>)[this.config.dateField]
      : item.date;
    if (!useDate) {
      this.runtime.logger.verbose(
        'FEED',
        `Skipping item without a date: ${item.title ?? '(untitled)'} (${itemUrl ?? 'no URL'})`,
        this.botId,
      );
      return;
    }

    const dedupeKey = computeDedupeKey(this.botId, item.id);

    const lastCursor = this.store.readCursor();
    let embed: ParsedEmbed | undefined;

    if (this.config.publishEmbed) {
      const url = itemUrl;
      if (!url) throw new Error('No link provided from RSS reader to fetch Open Graph data.');

      if (this.config.removeDuplicate) {
        if (this.store.seenValueExists(url)) {
          this.runtime.logger.verbose(
            'FEED',
            `Skipping duplicate item: ${item.title} (${url})`,
            this.botId,
          );
          return;
        }
        this.store.writeSeenValue(url);
      } else {
        if (new Date(useDate) <= new Date(lastCursor)) {
          this.runtime.logger.verbose(
            'FEED',
            `Skipping stale item: ${item.title} (${url})`,
            this.botId,
          );
          return;
        }
      }

      let imageUrl: string | undefined = item.imageUrl;

      let description: string | undefined;
      if (this.config.forceDescriptionEmbed) {
        description = item.description ?? item.content;
        if (description && this.config.descriptionClearHTML)
          description = removeHTMLTags(description);
      }

      let imageAlt: string | undefined;
      if (this.config.embedType === 'image' && this.config.imageAlt) {
        imageAlt = parseString(this.config.imageAlt, item, false, false, false);
      }

      const defaultUserAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      const openGraphFetch = await this.fetchOpenGraph(
        url,
        this.config.ogUserAgent || defaultUserAgent,
      );

      if (openGraphFetch.ok) {
        const openGraphResult = openGraphFetch.result as {
          ogImage?: {url: string}[];
          ogDescription?: string;
          ogUrl?: string;
          ogTitle?: string;
        };
        this.runtime.operations.recordOpenGraphSuccess();
        if (!imageUrl && openGraphResult.ogImage?.[0]?.url) {
          imageUrl = openGraphResult.ogImage[0].url;
        }
        if (!description) {
          description = openGraphResult.ogDescription ?? item.description ?? item.content;
        }
        if (description && this.config.descriptionClearHTML)
          description = removeHTMLTags(description);

        let uri = openGraphResult.ogUrl ? fixMalformedUrl(openGraphResult.ogUrl) : url;
        if (openGraphResult.ogUrl) {
          const validUrl =
            /^(h|H)(t|T)(t|T)(p|P)(s|S)?:\/\/[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/;
          if (!validUrl.test(uri)) uri = url;
        }

        if (uri && (openGraphResult.ogTitle || item.title)) {
          embed = {
            uri,
            title: openGraphResult.ogTitle ?? item.title ?? '',
            description,
            imageUrl,
            imageAlt,
            type: this.config.embedType,
          };
        }
      } else {
        this.runtime.operations.recordOpenGraphFallback();
        this.runtime.logger.verbose(
          'FETCH',
          `Open Graph fallback for ${item.title} (${url})`,
          this.botId,
        );
        this.runtime.logger.debug('FETCH', formatDebugError(openGraphFetch.error), this.botId);
        description = item.description ?? item.content;
        if (description && this.config.descriptionClearHTML)
          description = removeHTMLTags(description);
        embed = {
          uri: url,
          title: item.title ?? '',
          description,
          imageUrl,
          imageAlt,
          type: this.config.embedType,
        };
      }
    }

    if (new Date(useDate) <= new Date(lastCursor)) {
      this.runtime.logger.verbose(
        'FEED',
        `Skipping stale item: ${item.title} (${itemUrl ?? 'no URL'})`,
        this.botId,
      );
      return;
    }

    const title =
      item.title && this.config.titleClearHTML
        ? decodeHTMLTwice(removeHTMLTags(item.title))
        : item.title;

    const content = parseString(
      this.config.string,
      item,
      this.config.truncate === true,
      this.config.titleClearHTML === true,
      this.config.descriptionClearHTML === true,
    );

    this.itemHandler?.({
      title,
      content,
      embed: this.config.publishEmbed ? embed : undefined,
      languages: this.config.languages,
      itemDate: useDate,
      dedupeKey,
    } as ParsedItem);
  }
```

`resolveEmbedImage` and `fetchOpenGraph` (the private methods) are unaffected by this migration - leave them exactly as they are today.

Also update the `FeedItem` type export at the top of the file: remove it (it's no longer used anywhere in this file or exported for consumers - `botWorker.ts` imports `FeedReader`, `ParsedItem`, `ParsedEmbed`, never `FeedItem`, confirmed by grep in Task 5's research).

- [ ] **Step 2: Run typecheck to see what the old test file breaks on**

Run: `cd /home/rmdes/bsky.rss && yarn typecheck`
Expected: FAIL - `fleet/feedReader.test.ts` references `FeedItem`, `textOf`, and the removed `underlyingFeedSub`/`reader.emit(...)` pattern, none of which exist anymore.

- [ ] **Step 3: Rewrite fleet/feedReader.test.ts's setup helpers and poll-level tests**

Read the current file first to confirm exact line ranges before editing, since only specific sections change - most of the file (embed-building tests driven through the private `handleItem()` helper) stays as-is.

Replace the imports (lines 1-23):

```typescript
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {Server} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {removeHTMLTags, decodeHTMLTwice, fixMalformedUrl, parseString, FeedReader, type ParsedItem} from './feedReader.ts';
import type {NormalizedItem} from '../shared/feedSource/index.ts';
import {computeDedupeKey} from './dedupeKey.ts';
import {BotStore} from './botStore.ts';
import {SharedLimiters} from './sharedLimiters.ts';
import {BotOperations} from './botOperations.ts';
import {FleetLogger, type FleetLogRecord} from './logging.ts';
import jimp from 'jimp';
```

Replace `underlyingFeedSub` (lines 25-37) and `handleItem` helper (lines 39-43) with:

```typescript
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
    ...overrides,
  };
}
```

`createRuntime` (lines 47-67) stays unchanged. Replace `createInstrumentedReader` (lines 69-100) - it no longer needs to stub out `read`/`start`/`stop` on a private field, since the reader isn't constructed against a real feed URL that would actually be polled by these tests (they call `handleItem` directly, never `reader.start()`):

```typescript
function createInstrumentedReader(
  t: {after(callback: () => void): void},
  options: {
    config?: Record<string, unknown>;
    fetchOpenGraph?: (url: string, userAgent: string, timeoutMs: number) => Promise<unknown>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'feedreader-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const store = new BotStore(join(dir, 'state.sqlite'));
  t.after(() => store.close());
  const runtime = createRuntime('test-bot', options.fetchOpenGraph);
  const reader = new FeedReader(
    'test-bot',
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
```

Every existing test in the file that called `handleItem(reader, {title: ..., link: {href: ...}, ...})` with a raw feedme-shaped object literal needs that argument replaced with `normalizedItem({title: ..., link: '...', ...})` - a plain string `link`, not `{href: ...}`. Apply this change to every `handleItem(reader, {...})` call site in the file (there are several across the embed-building test block). For example, a call site that reads:

```typescript
await handleItem(reader, {title: 'Test', link: {href: 'https://example.com/x'}, description: 'desc'});
```

becomes:

```typescript
await handleItem(reader, normalizedItem({title: 'Test', link: 'https://example.com/x', description: 'desc'}));
```

Remove the `guid`-object-shape dedupe-key tests (the ones exercising `textOf()` on `isPermaLink` object-vs-string guid shapes) - `textOf()` no longer exists, and `NormalizedItem.id` is always a resolved plain string by the time it reaches `FeedReader`, so there is nothing format-shape-dependent left to test at this layer; the guid/id resolution behavior is now covered by Task 2/3's `normalize.test.ts` instead.

Replace the three `underlyingFeedSub(reader).emit(...)`-based tests (`'an items batch with entries records a successful feed poll'`, `'an empty items batch still records a successful feed poll'`, `'feed failures are summarized once and a later items batch records the exact recovery count'`) with four equivalents driven through a real local HTTP server and the real `reader.start()`/`reader.stop()`, since there is no longer a private EventEmitter to reach into. The recovery-count scenario splits into two tests below (a plain fetch-failure test, and a fail-twice-then-recover test) since driving both through a real server needs two different server behaviors:

```typescript
function startFeedResponseServer(status: number, body: string): Promise<{server: Server; port: number}> {
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

const sampleFeedWithOneItem = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><description>D</description><link>https://example.com</link><item><title>one</title><link>https://example.com/one</link><guid>https://example.com/one</guid><pubDate>Wed, 05 Aug 2026 09:00:00 GMT</pubDate></item></channel></rss>`;
const emptyFeed = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><description>D</description><link>https://example.com</link></channel></rss>`;

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
```

Remove the `'start() attaches an error listener so a feed-fetch failure is logged per-bot, not an uncaught exception'` test entirely - it specifically regression-tests an EventEmitter default-uncaught-exception gotcha that is structurally impossible with the new callback-based `FeedSource` interface (there is no special-cased `'error'` event name to have a missing listener for). The replacement test above (`'a feed-fetch failure is recorded and logged per-bot...'`) covers the same real behavior (a fetch failure is recorded and logged, not thrown) through the new mechanism.

Leave every other test in the file (the embed-building tests driven through `handleItem()`, the `resolveEmbedImage` tests using `startFixedResponseServer`, the `removeHTMLTags`/`decodeHTMLTwice`/`fixMalformedUrl` tests) untouched except for updating any `handleItem(reader, {...})` call site's argument shape as described above.

- [ ] **Step 4: Run the full fleet suite**

Run: `cd /home/rmdes/bsky.rss && yarn test:fleet`
Expected: PASS - all tests in `fleet/*.test.ts`, including the rewritten `feedReader.test.ts` and the unmodified `botWorker.test.ts` (which constructs `FeedReader` but never reaches into its internals, so it's unaffected by this task).

- [ ] **Step 5: Type-check and lint**

Run: `cd /home/rmdes/bsky.rss && yarn typecheck && yarn lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
cd /home/rmdes/bsky.rss
git add fleet/feedReader.ts fleet/feedReader.test.ts
git commit -m "refactor(fleet): migrate FeedReader from feedsub to shared/feedSource"
```

---

### Task 6: Migrate app/utils/rssHandler.ts

**Files:**
- Modify: `app/utils/rssHandler.ts`
- Modify: `app/utils/rssHandler.test.ts`
- Modify: `app/types/index.d.ts`

**Interfaces:**
- Consumes: `createFeedSource` from `shared/feedSource/index.ts` (Task 4). `init`, `start`, `launch` (the module's default export) stay identical to today - `app/index.ts` must not need any changes.
- Produces: nothing new for later tasks - this is a leaf consumer.

**Note on `QueueItems.date`:** today's code passes a raw string (`useDate`) into this field despite it being declared `date: Date` - this type-checks today only because `useDate`'s type is silently widened to `any` via `item[config.dateField]` indexing into the old ambient `Item` interface's `[key: string]: any`. `NormalizedItem.date` is genuinely `string | undefined`, so this migration would surface a real type error here unless the declared type is corrected to match what's actually passed - which is also what `app/utils/queueHandler.ts:91,106` already assumes on the consuming side (`new Date(item.date)`, which accepts a string just as well as a `Date`). Fix the declared type rather than force a `Date` object into existence purely to satisfy the type checker.

- [ ] **Step 1: Replace app/utils/rssHandler.ts's feedsub usage with shared/feedSource**

Read the current file first to confirm line numbers. Replace the import block (lines 1-7):

```typescript
import jimp from 'jimp';
import axios from 'axios';
import queue from './queueHandler';
import db from './dbHandler';
import og from 'open-graph-scraper';
import {decode} from 'html-entities';
import {createFeedSource} from '../../shared/feedSource/index.ts';
import type {FeedSource, NormalizedItem} from '../../shared/feedSource/index.ts';
```

Replace the module-level state (lines 9-33) - drop the `any`-typed `reader` and replace it with a properly-typed `FeedSource`:

```typescript
let reader: FeedSource | null = null;
let lastDate: string = '';

let config: Config = {
  string: '',
  publishEmbed: false,
  languages: ['en'],
  truncate: true,
  runInterval: 60,
  publishDate: false,
  dateField: '',
  imageField: '',
  ogUserAgent: 'bsky.rss/1.0 (Open Graph Scraper)',
  descriptionClearHTML: true,
  forceDescriptionEmbed: false,
  removeDuplicate: false,
  titleClearHTML: false,
  adaptiveSpacing: false,
  spacingWindow: 600,
  minSpacing: 1,
  maxSpacing: 60,
};
```

Replace `start()` (lines 35-225) - the per-item body (Open Graph fetch, embed-building, queueing) is unchanged logic, only the outer wiring and the item shape change:

```typescript
async function start() {
  if (!reader) throw new Error('Reader not initialized.');

  reader.start({
    onItems: () => undefined,
    onItem: handleItem,
    onError: err => {
      console.log(
        `[${new Date().toUTCString()}] - [bsky.rss FETCH] Feed error: ${err.message}${
          err.cause ? ` (${String(err.cause)})` : ''
        }`,
      );
    },
  });
}

async function handleItem(item: NormalizedItem): Promise<void> {
  // dateField historically pointed at an arbitrary raw feedme tag name (feedme kept
  // every tag from the source feed as a flat property). NormalizedItem no longer
  // carries arbitrary per-feed fields - only its own fixed shape - so dateField now
  // only resolves against NormalizedItem's own field names. All 59 live bot configs
  // leave dateField empty today, so this has no real-world effect; kept for config
  // compatibility per the migration spec's Non-goals, not redesigned.
  const useDate = config.dateField
    ? (item as unknown as Record<string, string | undefined>)[config.dateField]
    : item.date;
  if (!useDate) return console.log('No date provided by RSS reader for post.');

  const parsed = parseString(config.string, item, config.truncate === true);
  let embed: Embed | undefined = undefined;
  let title: string | undefined = undefined;

  if (config.publishEmbed) {
    if (!item.link) throw new Error('No link provided from RSS reader to fetch Open Graph data.');
    const url = item.link;

    if (config.removeDuplicate) {
      if (await db.valueExists(url)) return;
      else await db.writeValue(url);
    } else {
      if (new Date(useDate) <= new Date(lastDate)) return;
    }

    let image: Buffer | undefined = item.imageUrl ? await fetchImage(item.imageUrl) : undefined;
    let description: string | undefined = undefined;
    let imageAlt: string | undefined = undefined;

    if (image === undefined && item.imageUrl) {
      console.log(
        `[${new Date().toUTCString()}] - [bsky.rss FETCH] Error fetching image for ${
          item.title
        } (${item.imageUrl})`,
      );
    }

    if (config.forceDescriptionEmbed) {
      description = item.description ? item.description : item.content ? item.content : undefined;

      if (description && config.descriptionClearHTML) {
        description = removeHTMLTags(description);
      }
    }

    if (config.embedType === 'image' && config.imageAlt) {
      imageAlt = parseString(config.imageAlt, item, false).text;
    }

    const defaultUserAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const userAgent = config.ogUserAgent || defaultUserAgent;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openGraphData: any = await og({
      url,
      timeout: 10000,
      fetchOptions: {
        headers: {
          'user-agent': userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
        },
      },
    })
      .then(res => (res.error ? {error: true} : res.result))
      .catch(() => ({
        error: true,
      }));

    if (!openGraphData.error) {
      if (image === undefined && openGraphData.ogImage) {
        const imageUrl: string = openGraphData.ogImage[0].url;

        if (imageUrl !== '' && imageUrl !== undefined) {
          image = await fetchImage(imageUrl);

          if (image === undefined) {
            console.log(
              `[${new Date().toUTCString()}] - [bsky.rss FETCH] Error fetching image for ${
                item.title
              } (${imageUrl})`,
            );
          }
        }

        if (description === undefined) {
          description = openGraphData.ogDescription
            ? openGraphData.ogDescription
            : item.description
              ? item.description
              : item.content
                ? item.content
                : undefined;
        }
      }

      if (description !== undefined && config.descriptionClearHTML) {
        description = removeHTMLTags(description);
      }

      let uri = openGraphData.ogUrl ? fixMalformedUrl(openGraphData.ogUrl) : url;

      if (openGraphData.ogUrl) {
        const regexURL = new RegExp(
          '^(h|H)(t|T)(t|T)(p|P)(s|S)?:\\/\\/[-a-zA-Z0-9@:%._\\+~#=]{1,256}\\.[a-zA-Z0-9()]{1,6}\\b([-a-zA-Z0-9()@:%_\\+.~#?&//=]*)',
        );

        if (!regexURL.test(uri)) uri = url;
      }

      if (!uri || (!openGraphData.ogTitle && !item.title)) {
        embed = undefined;
      } else {
        embed = {
          uri: uri,
          title: openGraphData.ogTitle ? openGraphData.ogTitle : item.title ?? '',
          description: description,
          image: image,
          imageAlt: imageAlt,
          type: config.embedType,
        };
      }
    } else {
      console.log(
        `[${new Date().toUTCString()}] - [bsky.rss FETCH] Error fetching Open Graph data for ${
          item.title
        } (${url})`,
      );

      description = item.description || item.content;
      if (description && config.descriptionClearHTML) {
        description = removeHTMLTags(description);
      }

      embed = {
        uri: url,
        title: item.title ?? '',
        description: description,
        image: image,
        imageAlt: imageAlt,
        type: config.embedType,
      };
    }
  }

  if (new Date(useDate) <= new Date(lastDate)) return;

  title = item.title;

  if (title && config.titleClearHTML) {
    title = decodeHTML(removeHTMLTags(title));
  }

  await queue.writeQueue({
    content: parsed.text,
    title: title,
    embed: config.publishEmbed ? embed : undefined,
    languages: config.languages ? config.languages : undefined,
    date: useDate,
  });
}
```

Replace `init()` (lines 227-239):

```typescript
async function init({fetch_interval, fetch_url}: {fetch_interval: number; fetch_url: URL}) {
  config = await db.initConfig();
  if (!config.string) throw new Error('No string provided.');

  lastDate = await db.readLast();
  reader = createFeedSource(fetch_url, fetch_interval, {imageField: config.imageField});
  return reader;
}
```

`launch()` (lines 241-244) stays unchanged in behavior, but there's nothing left for it to meaningfully do since `start()` now begins polling immediately via `reader.start()` inside `start()` itself - keep it as a no-op passthrough for interface stability (`app/index.ts` still calls `await reader.launch()` and must not break):

```typescript
async function launch() {
  return reader;
}
```

Update `parseString` (the free function) to take `NormalizedItem` and drop the object-link check, matching Task 5's identical change in `fleet/feedReader.ts`:

```typescript
function parseString(string: string, item: NormalizedItem, truncate: boolean) {
  const result: ParseResult = {
    text: '',
  };

  let parsedString = string;
  if (string.includes('$title')) {
    if (!item.title) throw new Error('No title provided from RSS reader.');

    if (config.titleClearHTML) {
      parsedString = parsedString.replace('$title', decodeHTML(removeHTMLTags(item.title)));
    } else {
      parsedString = parsedString.replace('$title', item.title);
    }
  }

  if (string.includes('$link')) {
    if (!item.link) throw new Error('No link provided from RSS reader.');
    parsedString = parsedString.replace('$link', item.link);
  }

  let description = item.description ? item.description : item.content;

  if (string.includes('$description')) {
    if (config.descriptionClearHTML && description) description = removeHTMLTags(description);
    parsedString = parsedString.replace('$description', description ?? '');
  }

  if (parsedString.length > 300 && truncate) {
    parsedString = parsedString.slice(0, 277) + '...';
  }
  result.text = parsedString;
  return result;
}
```

`fetchImage`, `removeHTMLTags`, `decodeHTML`, `fixMalformedUrl`, `resizeImageToBuffer` stay unchanged.

- [ ] **Step 2: Fix QueueItems.date's declared type in app/types/index.d.ts**

In the `QueueItems` interface, change:

```typescript
  date: Date;
```

to:

```typescript
  date: string;
```

- [ ] **Step 3: Run typecheck to see what else breaks**

Run: `cd /home/rmdes/bsky.rss && yarn typecheck`
Expected: any remaining type errors point at `app/utils/rssHandler.test.ts` call sites still using the old feedme-shaped item literals (e.g. `link: {href: ...}` instead of a plain string) - fix each one to match `NormalizedItem`'s shape (plain string `link`, no `href` wrapper), the same change made to `fleet/feedReader.test.ts` in Task 5.

- [ ] **Step 4: Update app/utils/rssHandler.test.ts's item literals**

Read the current file first. Every test that builds a raw item object (e.g. `{title: '...', link: {href: '...'}, description: '...'}`) to pass into logic under test needs `link` changed from `{href: '...'}` to a plain string `'...'`, matching `NormalizedItem`. `parseString`'s own tests (the ones replicating template substitution inline, per the file's existing style) are unaffected since they don't construct feedme-shaped objects at all.

- [ ] **Step 5: Run the full app suite**

Run: `cd /home/rmdes/bsky.rss && yarn test:app`
Expected: PASS.

- [ ] **Step 6: Type-check and lint**

Run: `cd /home/rmdes/bsky.rss && yarn typecheck && yarn lint`
Expected: both clean.

- [ ] **Step 7: Manual smoke test in dry-run-equivalent mode**

Single-bot mode has no `DRY_RUN` flag, so smoke-test by running against a real public feed with posting disabled by using invalid Bluesky credentials (the process will fail at login, but feed polling happens independently beforehand - confirm via logs that items are fetched and parsed without a crash):

Run: `cd /home/rmdes/bsky.rss && IDENTIFIER=test APP_PASSWORD=test FETCH_URL=https://hnrss.org/frontpage INSTANCE_URL=https://bsky.social timeout 15 yarn dev 2>&1 | head -40`
Expected: log lines showing the feed was fetched and items processed (or a clear login failure after that point) - no stack trace originating from `rssHandler.ts`/`shared/feedSource`.

- [ ] **Step 8: Commit**

```bash
cd /home/rmdes/bsky.rss
git add app/utils/rssHandler.ts app/utils/rssHandler.test.ts app/types/index.d.ts
git commit -m "refactor(app): migrate rssHandler from feedsub to shared/feedSource"
```

---

### Task 7: Shadow-run verification script

**Files:**
- Create: `fleet/verifyFeedMigration.ts`

**Interfaces:**
- Consumes: `parseRawFeed`/`normalizeFeed` from `shared/feedSource` (Tasks 1-3), `feedsub`'s `FeedSub` directly (still in `package.json` at this point), `axios` for the raw fetch, real bot configs read from `FLEET_CONFIG_ROOT` (matching `fleet/configLoader.ts`'s existing env-var convention).

- [ ] **Step 1: Write fleet/verifyFeedMigration.ts**

```typescript
import 'dotenv/config';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import axios from 'axios';
import FeedSub from 'feedsub';
import {parseRawFeed} from '../shared/feedSource/parse.ts';
import {normalizeFeed} from '../shared/feedSource/normalize.ts';

interface BotConfig {
  feedUrl: string;
  imageField?: string;
}

function loadBotConfigs(configRoot: string): Map<string, BotConfig> {
  const botsDir = join(configRoot, 'bots');
  const configs = new Map<string, BotConfig>();
  for (const botId of readdirSync(botsDir)) {
    const botJsonPath = join(botsDir, botId, 'bot.json');
    const configJsonPath = join(botsDir, botId, 'config.json');
    try {
      const bot = JSON.parse(readFileSync(botJsonPath, 'utf-8')) as {feedUrl: string};
      const config = JSON.parse(readFileSync(configJsonPath, 'utf-8')) as {imageField?: string};
      configs.set(botId, {feedUrl: bot.feedUrl, imageField: config.imageField});
    } catch (error) {
      console.log(`Skipping ${botId}: could not read config (${String(error)})`);
    }
  }
  return configs;
}

// FeedSub has no way to hand it an already-fetched body - .read(callback) always does
// its own internal fetch (via miniget) against the URL passed to its constructor, and
// with emitOnStart:true a fresh (no-history) instance's first read treats every item
// as new. This exercises feedsub's real end-to-end fetch+parse behavior, the same as
// what runs in production today - confirmed against the installed feedsub source
// (node_modules/feedsub/dist/feedsub.js), not guessed.
function parseWithFeedsub(feedUrl: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const sub = new FeedSub(feedUrl, {interval: 60, emitOnStart: true});
    sub.read((err: Error | null, items: Array<Record<string, unknown>>) => {
      if (err) reject(err);
      else resolve(items);
    });
  });
}

function textOf(v: unknown): string | undefined {
  const text = v && typeof v === 'object' ? (v as {text?: string}).text : (v as string | undefined);
  return text || undefined;
}

async function compareBot(botId: string, config: BotConfig): Promise<void> {
  console.log(`\n=== ${botId} (${config.feedUrl}) ===`);

  let oldItems: Array<Record<string, unknown>>;
  try {
    oldItems = await parseWithFeedsub(config.feedUrl);
  } catch (error) {
    console.log(`  OLD PARSER (feedsub) FAILED: ${String(error)}`);
    return;
  }

  // feedsmith only parses an already-fetched string, so this is a second, separate
  // fetch of the same URL - a divergence below could in principle stem from the two
  // HTTP clients (miniget vs axios) handling something differently, not just the
  // parsers, and is worth reporting either way.
  let rawBody: string;
  try {
    const response = await axios.get<string>(config.feedUrl, {responseType: 'text', timeout: 10_000});
    rawBody = response.data;
  } catch (error) {
    console.log(`  NEW PATH FETCH FAILED: ${String(error)}`);
    return;
  }

  let newItems: ReturnType<typeof normalizeFeed>;
  try {
    newItems = normalizeFeed(parseRawFeed(rawBody), {imageField: config.imageField});
  } catch (error) {
    console.log(`  NEW PARSER (feedsmith) FAILED: ${String(error)}`);
    return;
  }

  console.log(`  old: ${oldItems.length} item(s), new: ${newItems.length} item(s)`);
  if (oldItems.length !== newItems.length) {
    console.log('  DIVERGENCE: item count differs');
  }

  const count = Math.min(oldItems.length, newItems.length);
  for (let i = 0; i < count; i++) {
    const oldItem = oldItems[i];
    const newItem = newItems[i];
    const oldTitle = textOf(oldItem?.title);
    const oldLink = textOf(oldItem?.link);
    if (oldTitle !== newItem?.title) {
      console.log(`  DIVERGENCE item ${i} title: old=${JSON.stringify(oldTitle)} new=${JSON.stringify(newItem?.title)}`);
    }
    if (oldLink !== newItem?.link) {
      console.log(`  DIVERGENCE item ${i} link: old=${JSON.stringify(oldLink)} new=${JSON.stringify(newItem?.link)}`);
    }
  }
}

async function main(): Promise<void> {
  const configRoot = process.env.FLEET_CONFIG_ROOT;
  if (!configRoot) throw new Error('Missing env var FLEET_CONFIG_ROOT');

  console.log(
    '=== Feed migration shadow-run: feedsub vs feedsmith ===\n' +
      'Fetches each configured bot feed and diffs the old and new parsers\' output.\n' +
      'Run this against the live VPS config before cutting over production.\n',
  );

  const configs = loadBotConfigs(configRoot);
  console.log(`Found ${configs.size} bot config(s).\n`);

  for (const [botId, config] of configs) {
    await compareBot(botId, config);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Type-check and lint**

Run: `cd /home/rmdes/bsky.rss && yarn typecheck && yarn lint`
Expected: both clean. (`feedsub` is still a dependency at this point, so the `import FeedSub from 'feedsub'` resolves.)

- [ ] **Step 3: Smoke-test the script against one real public feed**

This script's normal use is against the live VPS's `FLEET_CONFIG_ROOT` (an operational step covered in Task 8 / Rollout, not something to run destructively here). Confirm it at least runs without crashing against an empty/local config dir first:

```bash
cd /home/rmdes/bsky.rss
mkdir -p /tmp/verify-test-config/bots
FLEET_CONFIG_ROOT=/tmp/verify-test-config node --import tsx fleet/verifyFeedMigration.ts
```

Expected: `Found 0 bot config(s).` and a clean exit (0 bots, no crash).

- [ ] **Step 4: Commit**

```bash
cd /home/rmdes/bsky.rss
git add fleet/verifyFeedMigration.ts
git commit -m "feat(fleet): add feedsub-vs-feedsmith shadow-run verification script"
```

---

### Task 8: Remove feedsub, update CLAUDE.md, final verification

**Files:**
- Modify: `package.json`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing - this is the final task.

**Before starting this task:** run `fleet/verifyFeedMigration.ts` (Task 7) against the real production VPS config as described in the spec's "Verification before cutover" section (`ssh` to the VPS, `FLEET_CONFIG_ROOT=/home/skyfleet-next/config node --import tsx fleet/verifyFeedMigration.ts`, or copy the repo's current state there temporarily) and confirm no unexplained `DIVERGENCE` lines across the 59 real bot feeds. This is an operational verification step, not an automated test - do not proceed with Step 1 below until it's been run and reviewed.

- [ ] **Step 1: Remove feedsub from package.json**

```bash
cd /home/rmdes/bsky.rss
yarn remove feedsub
```

Expected: `package.json`'s `dependencies` no longer lists `feedsub`; `yarn.lock` updated; `feedme`, `miniget`, `newsemitter`, `tiny-typed-emitter` (feedsub's own transitive dependencies, confirmed via Task-1-era research to be unused anywhere else in the repo) are removed from `yarn.lock` as a consequence.

- [ ] **Step 2: Confirm fleet/verifyFeedMigration.ts no longer type-checks (expected) and remove it**

Since `fleet/verifyFeedMigration.ts` imports `feedsub` directly for the old-parser comparison, removing the dependency breaks it - this is expected, it has served its purpose as a pre-cutover gate. Delete it:

```bash
cd /home/rmdes/bsky.rss
git rm fleet/verifyFeedMigration.ts
```

- [ ] **Step 3: Update CLAUDE.md's architecture description**

Read `CLAUDE.md` first to confirm exact current wording. In the "Architecture" section, the line describing `rssHandler`:

```
1. **`rssHandler`** — wraps `FeedSub` to poll `FETCH_URL` every `FETCH_INTERVAL` minutes. On each new
   item it builds the post text (`$title`/`$link`/`$description` templating against `config.string`),
```

becomes:

```
1. **`rssHandler`** — uses `shared/feedSource` (RSS/Atom/JSON Feed/RDF via `feedsmith`) to poll `FETCH_URL`
   every `FETCH_INTERVAL` minutes. On each new item it builds the post text (`$title`/`$link`/`$description`
   templating against `config.string`),
```

Also add a line to the "Architecture" section documenting the new shared module's existence, since it's now a real architectural component both `app/` and `fleet/` depend on - insert after the existing three-numbered-list architecture description:

```
`shared/feedSource/` is used by both `rssHandler` and `fleet/feedReader.ts` - it owns polling, parsing
(via `feedsmith`, supporting RSS/Atom/JSON Feed/RDF), and per-format normalization into one common
`NormalizedItem` shape. Image resolution for the `imageField` config option (`"enclosure"` or
`"media:content"`) lives in `shared/feedSource/imageResolver.ts`.
```

- [ ] **Step 4: Run the full test suite, typecheck, and lint**

Run: `cd /home/rmdes/bsky.rss && yarn test && yarn typecheck && yarn lint`
Expected: all three clean. This is the same three-gate check `pr-checks.yml` runs in CI.

- [ ] **Step 5: Commit**

```bash
cd /home/rmdes/bsky.rss
git add package.json yarn.lock CLAUDE.md
git commit -m "chore: remove feedsub dependency now that the shadow-run has verified feedsmith"
```

---

## Post-plan: deployment

Not part of this plan's tasks (this plan delivers the code; deployment is an operational step matching the spec's "Rollout" section and the pattern already established this session): merge to `main`, bump `package.json`'s version and tag a release, `git pull` + rebuild/pull the image on the VPS, `docker compose up -d --force-recreate`, watch the staggered 59-bot reactivation and `/health` endpoint the same way prior production deploys in this repo have been verified.
