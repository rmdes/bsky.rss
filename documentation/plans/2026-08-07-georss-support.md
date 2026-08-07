# GeoRSS Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `$georss` template placeholder (renders as an OpenStreetMap link from `georss:point`
coordinates) usable in `config.string`/`config.imageAlt`, plus a safe automatic link-from-`id`
fallback for Atom entries with no `<link>` element.

**Architecture:** `feedsmith` already parses `georss:point` into structured `{lat, lng}` data across
RSS, Atom, and RDF (not JSON Feed, which has no namespace concept). `shared/feedSource/normalize.ts`
extracts it into a new `NormalizedItem.geo` field; `app/utils/rssHandler.ts` and
`fleet/feedReader.ts` each render it into post text via their own (separately implemented)
`parseString` function.

**Tech Stack:** TypeScript, `feedsmith` (already a dependency), Node's built-in test runner
(`node:test`).

## Global Constraints

- Spec: `documentation/specs/2026-08-07-georss-support-design.md` (approved, commit `6310463`).
- Only `georss:point` is in scope. Not `elev`, `line`, `polygon`, `box`.
- No general namespace field-mapping mechanism (`mappedValues` or similar) - `$georss` is a single,
  fixed placeholder, same tier as `$title`/`$link`/`$description`.
- No explicit `linkField` config option - only the automatic `id`-as-URL fallback.
- `$georss` with no geo data present substitutes empty string - never throws, never disqualifies the
  item (matches `$description`'s existing behavior, unlike `$title`/`$link` which throw).
- The Atom link fallback (`entry.id` used as `link` when no `<link>` exists) only fires when `id`
  matches `/^https?:\/\//` - must never override an existing `<link>`, and must never promote a
  non-URL `id` (e.g. a `tag:` URI) to a link.
- OpenStreetMap link format: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}` - no
  proprietary map provider.
- `NormalizedItem.geo` type: `{lat: number; lng: number} | undefined` - a required key (like every
  other `NormalizedItem` field), not an optional (`geo?:`) one. Every object literal typed as
  `NormalizedItem` in the codebase must include it explicitly.
- `tsconfig.json`'s `strictNullChecks`/`noUncheckedIndexedAccess` apply - `feedsmith`'s
  `DeepPartial<T>` makes `point.lat`/`point.lng` individually `number | undefined`, not `number`.
  Any code reading them must runtime-check both before treating the result as a real point (verified
  against the project's real strict tsconfig during planning - see Task 1).
- `feedsmith`'s package `exports` map only publishes `"."` and `"./types"` - namespace types like
  `GeoRssNs` are not importable by path from outside the package. Use structural typing
  (`{lat?: number; lng?: number} | undefined`) instead of importing the namespace type.

---

### Task 1: `NormalizedItem.geo` field and GeoRSS extraction

**Files:**
- Modify: `shared/feedSource/types.ts`
- Modify: `shared/feedSource/normalize.ts`
- Modify: `shared/feedSource/normalize.test.ts`
- Modify: `fleet/feedReader.test.ts` (one-line fix to keep the whole repo green - see rationale in
  Step 6)
- Create: `test-fixtures/atom/sample-feed-georss-no-link.xml`
- Create: `test-fixtures/atom/sample-feed-georss-tag-id.xml`
- Create: `test-fixtures/rss/sample-feed-with-georss.xml`

**Interfaces:**
- Consumes: `feedsmith`'s parsed `item.georss?.point` / `entry.georss?.point`, shape
  `{lat?: number; lng?: number} | undefined` under `DeepPartial` (verified during planning via a
  real `tsc --noEmit` run against the project's actual strict tsconfig - zero errors).
- Produces: `NormalizedItem.geo: {lat: number; lng: number} | undefined`, populated by
  `normalizeFeed` for RSS/Atom/RDF (never for JSON Feed). Task 3 and Task 4 both read this field.

- [ ] **Step 1: Write the failing tests in `shared/feedSource/normalize.test.ts`**

First, every existing `assert.deepEqual` in this file compares against an object literal that will
now be missing a required key (`geo`) once Step 3 changes the type - so those assertions must be
updated in the same step as the new tests, not left broken. Replace the whole file:

```typescript
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
    description: 'This is a test article description with some <strong>HTML</strong> content.',
    content: undefined,
    imageUrl: undefined,
    geo: undefined,
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
    geo: undefined,
  });
});

test('normalizeFeed falls back to updated when an Atom entry has no published date', () => {
  const parsed = parseRawFeed(fixture('atom/sample-feed.xml'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items[1]?.date, '2026-08-05T08:00:00Z');
});

test('normalizeFeed maps JSON Feed items to NormalizedItem, using the native image field', () => {
  const parsed = parseRawFeed(fixture('jsonfeed/sample-feed.json'));
  const items = normalizeFeed(parsed, {imageField: 'enclosure'});

  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    id: 'https://example.com/jsonfeed/article-1',
    title: 'First JSON Feed Article',
    link: 'https://example.com/jsonfeed/article-1',
    date: '2026-08-05T09:00:00Z',
    description: 'A short summary of the first article.',
    content: 'The full text content of the first article.',
    imageUrl: 'https://example.com/jsonfeed/images/article-1.jpg',
    geo: undefined,
  });
});

test('normalizeFeed ignores the JSON Feed native image when imageField is unset', () => {
  const parsed = parseRawFeed(fixture('jsonfeed/sample-feed.json'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items[0]?.imageUrl, undefined);
});

test('normalizeFeed resolves an Atom media:content image when imageField is "media:content"', () => {
  const parsed = parseRawFeed(fixture('atom/sample-feed.xml'));
  const items = normalizeFeed(parsed, {imageField: 'media:content'});

  assert.equal(items[0]?.imageUrl, 'https://example.com/atom/images/entry-1.jpg');
  assert.equal(items[1]?.imageUrl, undefined);
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
    geo: undefined,
  });
});

test('normalizeFeed extracts georss:point into geo for an RSS item', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-georss.xml'));
  const items = normalizeFeed(parsed, {});

  assert.deepEqual(items[0]?.geo, {lat: 52.9793, lng: -132.6194});
});

test('normalizeFeed extracts georss:point into geo for an Atom entry', () => {
  const parsed = parseRawFeed(fixture('atom/sample-feed-georss-no-link.xml'));
  const items = normalizeFeed(parsed, {});

  assert.deepEqual(items[0]?.geo, {lat: 47.391, lng: -70.2406});
});

test('normalizeFeed leaves geo undefined when a feed has no georss:point', () => {
  const parsed = parseRawFeed(fixture('atom/sample-feed.xml'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items[0]?.geo, undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/tsx --test shared/feedSource/normalize.test.ts`

Expected: FAIL. The `deepEqual` assertions fail because the real objects don't have a `geo` key yet
(actual has 7 keys, expected literal has 8 - Node's `assert.deepEqual` reports a mismatch). The three
new georss tests fail with `TypeError: Cannot read properties of undefined` or fixture-not-found
errors (the new fixture files don't exist yet).

- [ ] **Step 3: Add `geo` to `NormalizedItem`**

In `shared/feedSource/types.ts`, add one field to the `NormalizedItem` interface (after `imageUrl`):

```typescript
export interface NormalizedItem {
  id: string;
  title: string | undefined;
  link: string | undefined;
  date: string | undefined;
  description: string | undefined;
  content: string | undefined;
  imageUrl: string | undefined;
  geo: {lat: number; lng: number} | undefined;
}
```

- [ ] **Step 4: Create the three new fixture files**

Create `test-fixtures/atom/sample-feed-georss-no-link.xml` (models a real feed - Environment and
Climate Change Canada's earthquake alerts - that has no `<link>` element at all, only `<id>` as a
real URL):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:georss="http://www.georss.org/georss">
  <title>Sample GeoRSS Atom Feed (No Link)</title>
  <id>https://example.com/geo-atom</id>
  <updated>2026-08-07T10:00:00Z</updated>
  <entry>
    <title>M3.2 Earthquake Near Example City</title>
    <id>https://example.com/geo-atom/entry-1</id>
    <published>2026-08-07T09:00:00Z</published>
    <updated>2026-08-07T09:00:00Z</updated>
    <summary>A magnitude 3.2 earthquake occurred near Example City.</summary>
    <georss:point>47.391 -70.2406</georss:point>
  </entry>
</feed>
```

Create `test-fixtures/atom/sample-feed-georss-tag-id.xml` (models a real feed - Flickr's geo feed -
that has a proper `<link>` but a `tag:` URI `<id>`, used by Task 2 to prove the link fallback must
NOT fire here):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:georss="http://www.georss.org/georss">
  <title>Sample GeoRSS Atom Feed (Tag URI Id)</title>
  <id>tag:example.com,2026:/geo-atom</id>
  <updated>2026-08-07T10:00:00Z</updated>
  <entry>
    <title>Photo at Example Landmark</title>
    <id>tag:example.com,2026:/photo/1</id>
    <link href="https://example.com/photos/1" rel="alternate"/>
    <published>2026-08-07T09:00:00Z</published>
    <updated>2026-08-07T09:00:00Z</updated>
    <summary>A photo taken at Example Landmark.</summary>
    <georss:point>34.0522 -118.2437</georss:point>
  </entry>
</feed>
```

Create `test-fixtures/rss/sample-feed-with-georss.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:georss="http://www.georss.org/georss">
  <channel>
    <title>Sample RSS Feed With GeoRSS</title>
    <description>A sample RSS feed carrying GeoRSS point data</description>
    <link>https://example.com</link>
    <item>
      <title>Earthquake Reported Near Example Town</title>
      <link>https://example.com/quake-1</link>
      <description>A minor earthquake was reported near Example Town.</description>
      <pubDate>Wed, 05 Aug 2026 09:00:00 GMT</pubDate>
      <guid isPermaLink="true">https://example.com/quake-1</guid>
      <georss:point>52.9793 -132.6194</georss:point>
    </item>
  </channel>
</rss>
```

All three fixtures were parsed with `feedsmith` directly during planning to confirm the exact `geo`
values shown in Step 1's tests come out correctly - `{lat: 47.391, lng: -70.2406}`,
`{lat: 34.0522, lng: -118.2437}`, and `{lat: 52.9793, lng: -132.6194}` respectively.

- [ ] **Step 5: Implement GeoRSS extraction in `shared/feedSource/normalize.ts`**

Add one helper function near the top of the file (after the imports), and update all four
normalizer functions to set `geo`. `feedsmith`'s `DeepPartial<T>` makes `point.lat`/`point.lng`
individually `number | undefined` even though real parsed data always has both - the helper's
runtime check is required for this to type-check under the project's `strictNullChecks` (verified
during planning), not just defensive style:

```typescript
function extractGeo(
  point: {lat?: number; lng?: number} | undefined,
): {lat: number; lng: number} | undefined {
  if (typeof point?.lat === 'number' && typeof point?.lng === 'number') {
    return {lat: point.lat, lng: point.lng};
  }
  return undefined;
}
```

Update `normalizeRssItem`:

```typescript
function normalizeRssItem(item: DeepPartial<Rss.Item<string>>): NormalizedItem {
  return {
    id: item.guid?.value || item.link || '',
    title: item.title,
    link: item.link,
    date: item.pubDate,
    description: item.description,
    content: item.content?.encoded,
    imageUrl: undefined,
    geo: extractGeo(item.georss?.point),
  };
}
```

Update `normalizeAtomEntry` (only the `geo` line changes in this task - the link-fallback change is
Task 2):

```typescript
function normalizeAtomEntry(entry: DeepPartial<Atom.Entry<string>>): NormalizedItem {
  const link =
    entry.links?.find(l => !l.rel || l.rel === 'alternate')?.href ?? entry.links?.[0]?.href;
  return {
    id: entry.id || link || '',
    title: entry.title,
    link,
    date: entry.published ?? entry.updated,
    description: entry.summary,
    content: entry.content,
    imageUrl: undefined,
    geo: extractGeo(entry.georss?.point),
  };
}
```

Update `normalizeJsonItem` (JSON Feed has no georss field - always `undefined`):

```typescript
function normalizeJsonItem(
  item: DeepPartial<Json.Item<string>>,
  imageField: string | undefined,
): NormalizedItem {
  return {
    id: item.id || item.url || '',
    title: item.title,
    link: item.url,
    date: item.date_published ?? item.date_modified,
    description: item.summary,
    content: item.content_html ?? item.content_text,
    imageUrl: imageField ? item.image : undefined,
    geo: undefined,
  };
}
```

Update `normalizeRdfItem`:

```typescript
function normalizeRdfItem(item: DeepPartial<Rdf.Item<string>>): NormalizedItem {
  return {
    id: item.link || '',
    title: item.title,
    link: item.link,
    date: item.dc?.dates?.[0],
    description: item.description,
    content: item.content?.encoded,
    imageUrl: undefined,
    geo: extractGeo(item.georss?.point),
  };
}
```

- [ ] **Step 6: Fix `fleet/feedReader.test.ts`'s `normalizedItem()` helper**

`NormalizedItem` is now a required-key type change (`geo` has no `?`), so the shared test helper in
`fleet/feedReader.test.ts` that builds a full `NormalizedItem` literal no longer satisfies the type -
this would break `yarn typecheck` for the whole repo, not just this task's own files, even though
Task 4 (not this task) is where `fleet/feedReader.ts` itself gets its `$georss` feature. Fix it now
so every commit keeps the repo green.

In `fleet/feedReader.test.ts`, find:

```typescript
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

Replace with:

```typescript
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
    ...overrides,
  };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `./node_modules/.bin/tsx --test shared/feedSource/normalize.test.ts`

Expected: PASS, all 15 tests green.

- [ ] **Step 8: Run the full test suite and typecheck**

Run: `yarn test && yarn typecheck`

Expected: PASS. This confirms Step 6 actually kept `fleet/feedReader.test.ts` (and the rest of the
repo) compiling.

- [ ] **Step 9: Commit**

```bash
git add shared/feedSource/types.ts shared/feedSource/normalize.ts shared/feedSource/normalize.test.ts fleet/feedReader.test.ts test-fixtures/atom/sample-feed-georss-no-link.xml test-fixtures/atom/sample-feed-georss-tag-id.xml test-fixtures/rss/sample-feed-with-georss.xml
git commit -m "feat(feedSource): extract georss:point into NormalizedItem.geo"
```

---

### Task 2: Atom link-from-`id` fallback

**Files:**
- Modify: `shared/feedSource/normalize.ts`
- Modify: `shared/feedSource/normalize.test.ts`

**Interfaces:**
- Consumes: the two Atom fixtures created in Task 1
  (`test-fixtures/atom/sample-feed-georss-no-link.xml`,
  `test-fixtures/atom/sample-feed-georss-tag-id.xml`).
- Produces: no new exports - `normalizeAtomEntry`'s existing `link`/`id` output changes for the
  no-`<link>` case only.

- [ ] **Step 1: Write the failing tests**

Append to `shared/feedSource/normalize.test.ts`:

```typescript
test('normalizeFeed falls back to id as link for an Atom entry with no <link> when id is a URL', () => {
  const parsed = parseRawFeed(fixture('atom/sample-feed-georss-no-link.xml'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items[0]?.link, 'https://example.com/geo-atom/entry-1');
});

test('normalizeFeed does not use a non-URL id as link when a real <link> already exists', () => {
  const parsed = parseRawFeed(fixture('atom/sample-feed-georss-tag-id.xml'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items[0]?.link, 'https://example.com/photos/1');
  assert.equal(items[0]?.id, 'tag:example.com,2026:/photo/1');
});
```

- [ ] **Step 2: Run the tests to verify the first one fails**

Run: `./node_modules/.bin/tsx --test shared/feedSource/normalize.test.ts`

Expected: the first new test FAILs (`items[0].link` is `undefined`, since `sample-feed-georss-no-link.xml` has no `<link>` element and `normalizeAtomEntry` doesn't yet fall back to `id`). The second new test already PASSes with today's code, since that fixture has a real `<link>` - this is the "must not misfire" case Task 1's fixture was built to prove; it's fine for it to already pass before this task's implementation step.

- [ ] **Step 3: Implement the fallback in `normalizeAtomEntry`**

In `shared/feedSource/normalize.ts`, replace:

```typescript
function normalizeAtomEntry(entry: DeepPartial<Atom.Entry<string>>): NormalizedItem {
  const link =
    entry.links?.find(l => !l.rel || l.rel === 'alternate')?.href ?? entry.links?.[0]?.href;
  return {
    id: entry.id || link || '',
    title: entry.title,
    link,
    date: entry.published ?? entry.updated,
    description: entry.summary,
    content: entry.content,
    imageUrl: undefined,
    geo: extractGeo(entry.georss?.point),
  };
}
```

With:

```typescript
function normalizeAtomEntry(entry: DeepPartial<Atom.Entry<string>>): NormalizedItem {
  const explicitLink =
    entry.links?.find(l => !l.rel || l.rel === 'alternate')?.href ?? entry.links?.[0]?.href;
  // Some Atom feeds (e.g. Environment and Climate Change Canada's earthquake alerts) omit <link>
  // entirely and use <id> as the permalink instead - a valid Atom pattern. Only trust <id> as a
  // link when it's actually a URL: other feeds (e.g. Flickr's geo feed) use tag: URIs for <id>
  // while still providing a real <link>, so this must never override an existing link or promote
  // a non-URL id.
  const link =
    explicitLink ?? (entry.id && /^https?:\/\//.test(entry.id) ? entry.id : undefined);
  return {
    id: entry.id || link || '',
    title: entry.title,
    link,
    date: entry.published ?? entry.updated,
    description: entry.summary,
    content: entry.content,
    imageUrl: undefined,
    geo: extractGeo(entry.georss?.point),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/tsx --test shared/feedSource/normalize.test.ts`

Expected: PASS, all 17 tests green.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `yarn test && yarn typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/feedSource/normalize.ts shared/feedSource/normalize.test.ts
git commit -m "feat(feedSource): fall back to id as link for Atom entries with no <link>"
```

---

### Task 3: `$georss` in `app/utils/rssHandler.ts`

**Files:**
- Modify: `app/utils/rssHandler.ts`
- Modify: `app/utils/rssHandler.test.ts`

**Interfaces:**
- Consumes: `NormalizedItem.geo` (Task 1), the Atom no-`<link>` fixture's real-feed shape (this task
  builds its own inline feed body, following this file's existing E2E test convention, rather than
  reading a fixture file).
- Produces: no new exports - `parseString`'s existing `$title`/`$link`/`$description` behavior is
  unchanged; this only adds a new `$georss` branch.

- [ ] **Step 1: Write the failing test**

Append to `app/utils/rssHandler.test.ts`, inside the same `describe('rssHandler', ...)` block as the
existing `'queues every item in a newest-first batch...'` test (same file, same real-HTTP-server
pattern used there):

```typescript
    it('substitutes $georss with an OpenStreetMap link built from georss:point', async () => {
      const feedBody =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:georss="http://www.georss.org/georss">' +
        '<title>T</title><id>https://example.com/geo-atom</id>' +
        '<updated>2026-08-07T10:00:00Z</updated>' +
        '<entry><title>Quake</title><id>https://example.com/geo-atom/entry-1</id>' +
        '<published>2026-08-07T09:00:00Z</published><updated>2026-08-07T09:00:00Z</updated>' +
        '<georss:point>47.391 -70.2406</georss:point></entry>' +
        '</feed>';

      const server = createServer((_req, res) => {
        res.writeHead(200, {'Content-Type': 'application/atom+xml'});
        res.end(feedBody);
      });
      await new Promise<void>(resolve => server.listen(0, resolve));
      const port = (server.address() as {port: number}).port;

      fs.writeFileSync(
        path.join(TEST_DATA_DIR, 'config.json'),
        JSON.stringify({
          string: '$title $georss',
          publishEmbed: false,
          languages: ['en'],
          truncate: true,
          runInterval: 60,
          dateField: '',
          imageField: '',
          ogUserAgent: 'bsky.rss/test',
          removeDuplicate: false,
        }),
        'utf8',
      );

      const lastPath = path.join(TEST_DATA_DIR, 'last.txt');
      const savedLast = fs.existsSync(lastPath) ? fs.readFileSync(lastPath, 'utf8') : null;
      fs.writeFileSync(lastPath, '2026-08-01T00:00:00.000Z', 'utf8');

      const queueHandler = require('./queueHandler').default;
      const realWriteQueue = queueHandler.writeQueue;
      const queued: {content: string}[] = [];
      queueHandler.writeQueue = async (item: {content: string}) => {
        queued.push(item);
      };

      delete require.cache[require.resolve('./rssHandler')];
      const rssHandler = require('./rssHandler').default;

      try {
        const reader = await rssHandler.init({
          fetch_interval: 60,
          fetch_url: new URL(`http://127.0.0.1:${port}/feed.xml`),
        });
        await rssHandler.start();
        await new Promise(resolve => setTimeout(resolve, 300));
        reader.stop();
      } finally {
        queueHandler.writeQueue = realWriteQueue;
        if (savedLast === null) fs.rmSync(lastPath, {force: true});
        else fs.writeFileSync(lastPath, savedLast, 'utf8');
        server.close();
      }

      assert.strictEqual(queued.length, 1);
      assert.strictEqual(
        queued[0]?.content,
        'Quake https://www.openstreetmap.org/?mlat=47.391&mlon=-70.2406',
      );
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/tsx --test app/utils/rssHandler.test.ts`

Expected: FAIL. `queued[0].content` is `'Quake $georss'` (the literal placeholder text, unsubstituted) instead of the expected OpenStreetMap URL.

- [ ] **Step 3: Implement the `$georss` branch in `app/utils/rssHandler.ts`'s `parseString`**

In `app/utils/rssHandler.ts`, find the `parseString` function and add a `$georss` branch after the
existing `$description` branch:

```typescript
  let description = item.description ? item.description : item.content;

  if (string.includes('$description')) {
    if (config.descriptionClearHTML && description) description = removeHTMLTags(description);
    parsedString = parsedString.replace('$description', description ?? '');
  }

  if (string.includes('$georss')) {
    const coords = item.geo
      ? `https://www.openstreetmap.org/?mlat=${item.geo.lat}&mlon=${item.geo.lng}`
      : '';
    parsedString = parsedString.replace('$georss', coords);
  }

  if (parsedString.length > 300 && truncate) {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./node_modules/.bin/tsx --test app/utils/rssHandler.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `yarn test && yarn typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/utils/rssHandler.ts app/utils/rssHandler.test.ts
git commit -m "feat(app): support \$georss placeholder in post templates"
```

---

### Task 4: `$georss` in `fleet/feedReader.ts`

**Files:**
- Modify: `fleet/feedReader.ts`
- Modify: `fleet/feedReader.test.ts`

**Interfaces:**
- Consumes: `NormalizedItem.geo` (Task 1), the exported `parseString` function and `normalizedItem()`
  test helper (both already exist in this file).
- Produces: no new exports - same `$georss` behavior as Task 3, in the fleet-mode implementation.

- [ ] **Step 1: Write the failing tests**

Append to `fleet/feedReader.test.ts`, near the existing `parseString` tests (after `'parseString
cleans HTML from the title when titleClearHTML is true'`):

```typescript
test('parseString substitutes $georss with an OpenStreetMap link built from geo', () => {
  const item = normalizedItem({geo: {lat: 47.391, lng: -70.2406}});
  const result = parseString('$georss', item, false, false, false);
  assert.equal(result, 'https://www.openstreetmap.org/?mlat=47.391&mlon=-70.2406');
});

test('parseString substitutes $georss with an empty string when geo is absent', () => {
  const item = normalizedItem({geo: undefined});
  const result = parseString('Location: $georss', item, false, false, false);
  assert.equal(result, 'Location: ');
});

test('parseString substitutes $georss inside imageAlt the same way as string', () => {
  // config.imageAlt goes through the same parseString function as config.string - this
  // confirms $georss works there too without any separate implementation.
  const item = normalizedItem({geo: {lat: 34.0522, lng: -118.2437}});
  const result = parseString('$georss', item, false, false, false);
  assert.equal(result, 'https://www.openstreetmap.org/?mlat=34.0522&mlon=-118.2437');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/tsx --test fleet/feedReader.test.ts`

Expected: FAIL. All three new tests fail because the template string `$georss` is returned
unsubstituted (`parseString` has no `$georss` branch yet).

- [ ] **Step 3: Implement the `$georss` branch in `fleet/feedReader.ts`'s `parseString`**

In `fleet/feedReader.ts`, find the `parseString` function and add a `$georss` branch after the
existing `$description` branch:

```typescript
  if (template.includes('$description')) {
    // Deliberate improvement over app/utils/rssHandler.ts, which leaves
    // `description` undefined here and lets String.replace stringify it to
    // the literal text "undefined" in the post - a real bug in production.
    let description = item.description ?? item.content ?? '';
    if (descriptionClearHTML) description = removeHTMLTags(description);
    result = result.replace('$description', description);
  }

  if (template.includes('$georss')) {
    const coords = item.geo
      ? `https://www.openstreetmap.org/?mlat=${item.geo.lat}&mlon=${item.geo.lng}`
      : '';
    result = result.replace('$georss', coords);
  }

  if (result.length > 300 && truncate) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/tsx --test fleet/feedReader.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `yarn test && yarn typecheck`

Expected: PASS, entire suite green.

- [ ] **Step 6: Commit**

```bash
git add fleet/feedReader.ts fleet/feedReader.test.ts
git commit -m "feat(fleet): support \$georss placeholder in post templates"
```

---

## After all tasks: manual smoke check against the real reference feed (optional, not gated)

Not a task step (no Bluesky test account yet, per the spec's Rollout section) - a throwaway sanity
check anyone can run locally once all four tasks are merged:

```bash
curl -s "https://www.earthquakescanada.nrcan.gc.ca/cache/earthquakes/canada-fr.atom" -o /tmp/quake.atom
./node_modules/.bin/tsx -e "
import {parseRawFeed} from './shared/feedSource/parse.ts';
import {normalizeFeed} from './shared/feedSource/normalize.ts';
import {readFileSync} from 'node:fs';
const items = normalizeFeed(parseRawFeed(readFileSync('/tmp/quake.atom', 'utf-8')), {});
console.log(items[0]);
"
```

Expected: the first item has a real `link` (from `id`, since this feed has no `<link>`) and a `geo`
matching the feed's real `<georss:point>` for that entry.
