# mappedValues Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bot's `config.json` can declare `mappedValues: [{key, value}]`; each entry makes `$key`
available in `config.string`/`config.imageAlt`, resolving to a named Dublin Core (`dc:*`) or
iTunes/Podcast (`itunes:*`) field's value on each item.

**Architecture:** `feedsmith` already parses `dc`/`itunes` namespace fields for RSS/Atom/RDF; a new
`shared/feedSource/mappedValues.ts` module (mirroring the existing `imageResolver.ts` pattern - one
function, an explicit if-chain over a closed list of recognized `value` strings) resolves them into
`NormalizedItem.mappedValues: Record<string, string>`. Both `app/utils/rssHandler.ts` and
`fleet/feedReader.ts` read that map in their own `parseString` and substitute `$key` for each entry,
the same shape as the existing `$georss` addition.

**Tech Stack:** TypeScript, `feedsmith` (already a dependency), Node's built-in test runner.

## Global Constraints

- Spec: `documentation/specs/2026-08-07-mapped-values-support-design.md` (approved, commit
  `9ece979`).
- Recognized `value` strings (closed list, matching `imageField`'s
  `"enclosure"`/`"media:content"` philosophy - not a generic path walker): `dc:creator`, `dc:date`,
  `dc:subject`, `dc:publisher`, `itunes:duration`, `itunes:episode`, `itunes:season`,
  `itunes:explicit`, `itunes:author`. An unrecognized `value` resolves that key to empty string -
  never a startup error.
- `dc:creator`/`dc:subject`/`dc:publisher` are repeatable in real feeds (feedsmith gives
  `string[]`, and marks the deprecated singular form in favor of the array) - join multiple values
  with `", "`. `dc:date` takes the first value only, as-is (a string, unparsed - matches how `date`
  is handled elsewhere in `NormalizedItem`).
- No startup validation for a `key` colliding with a built-in placeholder name (`title`, `link`,
  `description`, `georss`) - verified during design review that `parseString`'s substitution order
  (built-ins first) makes a colliding key structurally inert; adding a check for it would guard
  against something that cannot happen.
- Duplicate `key` values within one `mappedValues` array: last one wins (plain object assignment in
  array order) - no startup error for this case either.
- `mappedValues` only resolves for RSS/Atom/RDF - JSON Feed has no namespace concept, so every key
  resolves to empty string for JSON Feed items (same restriction `$georss`'s `geo` field already
  has).
- `mappedValues` gets a full top-level `### mappedValues` documentation section (Type/Default/
  examples), matching `imageField`'s treatment - it is a real `config.json` key, not a template
  variable like `$title`/`$georss` (which live in the "Available variables" list instead).
- `feedsmith`'s package `exports` map only publishes `"."` and `"./types"` - `DcNs`/`ItunesNs`
  namespace types are not importable by path. Use a structural/duck-typed interface instead
  (verified during planning via a real `tsc --noEmit` run against the project's actual strict
  tsconfig - zero errors), the same approach `imageResolver.ts`'s `ImageResolvableItem` and
  `extractGeo`'s parameters already use.
- Real field shapes verified during planning against real data (not guessed): `dc:creator` against
  `elpais-en`'s live feed (confirmed `string[]`, including a genuine two-creator item -
  `["Andrés Rodríguez", "Isaías Alvarado"]`); `itunes:duration`/`itunes:explicit` against NPR's
  Planet Money feed (confirmed `duration: 2416` - a real number in seconds, and `explicit: false` -
  feedsmith correctly normalizes the raw XML text `"no"` into a real boolean, not a string).
- The spec's Sequencing section calls for `itunes:*` as a "distinct, later step" gated on fetching a
  real podcast feed, so its formatting isn't finalized on guesswork. That verification already
  happened during planning (see above) - both `dc:*` and `itunes:*` are backed by real fetched data
  before Task 1 exists. Task 1 therefore implements both together rather than as two temporally
  separate tasks; this satisfies the spec's actual intent (no unverified formatting shipped) without
  the artificial split the spec assumed would be necessary before that verification had happened.

---

### Task 1: `mappedValues` resolution and `NormalizedItem` field

**Files:**
- Create: `shared/feedSource/mappedValues.ts`
- Modify: `shared/feedSource/types.ts`
- Modify: `shared/feedSource/normalize.ts`
- Modify: `shared/feedSource/normalize.test.ts`
- Create: `test-fixtures/rss/sample-feed-with-dc.xml`
- Create: `test-fixtures/rss/sample-feed-podcast.xml`

**Interfaces:**
- Produces: `NormalizedItem.mappedValues: Record<string, string>`, populated by `normalizeFeed` for
  RSS/Atom/RDF (always `{}` for JSON Feed). `resolveMappedValues(item, mappedValues)` exported from
  the new module, taking a duck-typed `{dc?: {...}, itunes?: {...}}` shape and the bot's config
  array, returning the resolved map. Task 2 and Task 3 both read `NormalizedItem.mappedValues` and
  pass `config.mappedValues` through to `createFeedSource`.

- [ ] **Step 1: Write the failing tests in `shared/feedSource/normalize.test.ts`**

Every existing `assert.deepEqual` in this file compares against an object literal that will be
missing a required key (`mappedValues`) once Step 3 changes the type - update those in the same
step as the new tests, not left broken. Replace the whole file:

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
    mappedValues: {},
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
    mappedValues: {},
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
    mappedValues: {},
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
    mappedValues: {},
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

test('normalizeFeed falls back to geo:lat/geo:long when georss:point is absent', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-w3c-geo.xml'));
  const items = normalizeFeed(parsed, {});

  assert.deepEqual(items[0]?.geo, {lat: 32.682, lng: 130.722});
});

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

test('normalizeFeed resolves dc:creator for a single-creator RSS item', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-dc.xml'));
  const items = normalizeFeed(parsed, {mappedValues: [{key: 'author', value: 'dc:creator'}]});

  assert.equal(items[0]?.mappedValues.author, 'Ianko López');
});

test('normalizeFeed joins multiple dc:creator values with ", "', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-dc.xml'));
  const items = normalizeFeed(parsed, {mappedValues: [{key: 'author', value: 'dc:creator'}]});

  assert.equal(items[1]?.mappedValues.author, 'Andrés Rodríguez, Isaías Alvarado');
});

test('normalizeFeed resolves dc:creator to empty string when the item has no creator', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-dc.xml'));
  const items = normalizeFeed(parsed, {mappedValues: [{key: 'author', value: 'dc:creator'}]});

  assert.equal(items[2]?.mappedValues.author, '');
});

test('normalizeFeed resolves itunes:duration and itunes:explicit for a real podcast item', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-podcast.xml'));
  const items = normalizeFeed(parsed, {
    mappedValues: [
      {key: 'duration', value: 'itunes:duration'},
      {key: 'explicit', value: 'itunes:explicit'},
    ],
  });

  assert.equal(items[0]?.mappedValues.duration, '2416');
  assert.equal(items[0]?.mappedValues.explicit, 'false');
});

test('normalizeFeed resolves mappedValues to empty string for an item missing every requested field', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-podcast.xml'));
  const items = normalizeFeed(parsed, {
    mappedValues: [{key: 'duration', value: 'itunes:duration'}],
  });

  assert.equal(items[1]?.mappedValues.duration, '');
});

test('normalizeFeed resolves an unrecognized mappedValues entry to empty string', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-dc.xml'));
  const items = normalizeFeed(parsed, {
    mappedValues: [{key: 'unknown', value: 'nope:not-a-real-field'}],
  });

  assert.equal(items[0]?.mappedValues.unknown, '');
});

test('normalizeFeed leaves mappedValues empty when the config sets none', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-dc.xml'));
  const items = normalizeFeed(parsed, {});

  assert.deepEqual(items[0]?.mappedValues, {});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/tsx --test shared/feedSource/normalize.test.ts`

Expected: FAIL. The pre-existing `deepEqual` assertions fail (missing `mappedValues` key on the
real objects vs. the expected literals). The new `mappedValues`-specific tests fail with
`Cannot read properties of undefined (reading 'author')` (or similar) - `items[N].mappedValues` is
`undefined` since the field doesn't exist yet, and the two new fixture files don't exist yet either.

- [ ] **Step 3: Add `mappedValues` to `NormalizedItem` and `FeedSourceConfig`**

In `shared/feedSource/types.ts`:

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
  mappedValues: Record<string, string>;
}

export interface FeedSourceConfig {
  imageField?: string;
  mappedValues?: Array<{key: string; value: string}>;
}
```

- [ ] **Step 4: Create the two new fixture files**

Both derived from real feeds fetched during planning and verified against real `feedsmith` output
(`dc.creators` shape and the two-creator case confirmed against `elpais-en`'s live feed;
`itunes.duration`/`itunes.explicit` confirmed against NPR's Planet Money feed - `duration: 2416`
seconds, `explicit: false` correctly normalized from raw text `"no"`).

Create `test-fixtures/rss/sample-feed-with-dc.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Sample RSS Feed With Dublin Core</title>
    <description>A sample RSS feed carrying dc:creator, including a multi-creator item</description>
    <link>https://example.com</link>
    <item>
      <title>Why have Hollywood blockbusters become so gray?</title>
      <link>https://english.elpais.com/culture/2026-08-07/why-have-hollywood-blockbusters-become-so-gray.html</link>
      <description>A single-creator article.</description>
      <pubDate>Fri, 07 Aug 2026 09:00:00 GMT</pubDate>
      <guid isPermaLink="true">https://english.elpais.com/culture/2026-08-07/why-have-hollywood-blockbusters-become-so-gray.html</guid>
      <dc:creator>Ianko López</dc:creator>
    </item>
    <item>
      <title>Washington strikes the CJNG on all fronts</title>
      <link>https://english.elpais.com/international/2026-08-06/washington-strikes-the-cjng-on-all-fronts.html</link>
      <description>A two-creator article.</description>
      <pubDate>Thu, 06 Aug 2026 09:00:00 GMT</pubDate>
      <guid isPermaLink="true">https://english.elpais.com/international/2026-08-06/washington-strikes-the-cjng-on-all-fronts.html</guid>
      <dc:creator>Andrés Rodríguez</dc:creator>
      <dc:creator>Isaías Alvarado</dc:creator>
    </item>
    <item>
      <title>Item with no creator</title>
      <link>https://example.com/no-creator</link>
      <description>An article with no dc:creator at all.</description>
      <pubDate>Wed, 05 Aug 2026 09:00:00 GMT</pubDate>
      <guid isPermaLink="true">https://example.com/no-creator</guid>
    </item>
  </channel>
</rss>
```

Create `test-fixtures/rss/sample-feed-podcast.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Sample Podcast Feed</title>
    <description>A sample RSS feed carrying real itunes:* fields</description>
    <link>https://example.com</link>
    <itunes:author>Sample Network</itunes:author>
    <item>
      <title>Sand heists and property rights in the Caribbean (Summer School)</title>
      <link>https://www.npr.org/2026/08/05/nx-s1-5913981/summer-school-caribbean-property-rights-sand-heist</link>
      <description>A real podcast episode.</description>
      <pubDate>Tue, 05 Aug 2026 09:00:00 GMT</pubDate>
      <guid isPermaLink="false">08584965-fc01-4cb2-bc20-65c8f85576f0</guid>
      <itunes:duration>2416</itunes:duration>
      <itunes:explicit>no</itunes:explicit>
      <itunes:episodeType>full</itunes:episodeType>
    </item>
    <item>
      <title>Item with no itunes fields</title>
      <link>https://example.com/no-itunes</link>
      <description>An episode with no itunes:* tags at all.</description>
      <pubDate>Mon, 04 Aug 2026 09:00:00 GMT</pubDate>
      <guid isPermaLink="true">https://example.com/no-itunes</guid>
    </item>
  </channel>
</rss>
```

- [ ] **Step 5: Create `shared/feedSource/mappedValues.ts`**

```typescript
// mappedValues is a closed list of recognized `value` strings by design (see
// documentation/specs/2026-08-07-mapped-values-support-design.md) - a single if-chain,
// matching imageResolver.ts's resolveImageUrl exactly, not a generic path walker into
// feedsmith's internals. An unrecognized value resolves to empty string, never an error,
// the same "unrecognized degrades gracefully" convention imageField already uses.
interface MappedValuesSource {
  dc?: {
    creators?: string[];
    dates?: string[];
    subjects?: string[];
    publishers?: string[];
  };
  itunes?: {
    duration?: number;
    episode?: number;
    season?: number;
    explicit?: boolean;
    author?: string;
  };
}

function resolveMappedValue(item: MappedValuesSource, value: string): string {
  if (value === 'dc:creator') return item.dc?.creators?.join(', ') ?? '';
  if (value === 'dc:date') return item.dc?.dates?.[0] ?? '';
  if (value === 'dc:subject') return item.dc?.subjects?.join(', ') ?? '';
  if (value === 'dc:publisher') return item.dc?.publishers?.join(', ') ?? '';
  if (value === 'itunes:duration') {
    return typeof item.itunes?.duration === 'number' ? String(item.itunes.duration) : '';
  }
  if (value === 'itunes:episode') {
    return typeof item.itunes?.episode === 'number' ? String(item.itunes.episode) : '';
  }
  if (value === 'itunes:season') {
    return typeof item.itunes?.season === 'number' ? String(item.itunes.season) : '';
  }
  if (value === 'itunes:explicit') {
    return typeof item.itunes?.explicit === 'boolean' ? String(item.itunes.explicit) : '';
  }
  if (value === 'itunes:author') return item.itunes?.author ?? '';
  return '';
}

export function resolveMappedValues(
  item: MappedValuesSource,
  mappedValues: Array<{key: string; value: string}> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of mappedValues ?? []) {
    result[entry.key] = resolveMappedValue(item, entry.value);
  }
  return result;
}
```

- [ ] **Step 6: Wire `resolveMappedValues` into `normalizeFeed`**

In `shared/feedSource/normalize.ts`, add the import:

```typescript
import {resolveMappedValues} from './mappedValues.ts';
```

`normalizeRssItem`, `normalizeAtomEntry`, and `normalizeRdfItem` do NOT take `config` today (only
`normalizeFeed` receives it, applying `imageField`-derived `imageUrl` afterward via a spread
override) - follow that exact existing pattern rather than threading config into the per-format
functions. In `normalizeFeed`, change each of the three non-JSON branches to also spread in
`mappedValues`:

```typescript
export function normalizeFeed(
  parsed: ParsedFeedResult,
  config: FeedSourceConfig,
): NormalizedItem[] {
  if (parsed.format === 'rss') {
    return (parsed.feed.items ?? []).map(item => ({
      ...normalizeRssItem(item),
      imageUrl: resolveImageUrl(item, config.imageField),
      mappedValues: resolveMappedValues(item, config.mappedValues),
    }));
  }
  if (parsed.format === 'atom') {
    // Atom entries carry the same Media RSS namespace shape as RSS/RDF items, so
    // imageField resolution applies here too.
    return (parsed.feed.entries ?? []).map(entry => ({
      ...normalizeAtomEntry(entry),
      imageUrl: resolveImageUrl(entry, config.imageField),
      mappedValues: resolveMappedValues(entry, config.mappedValues),
    }));
  }
  if (parsed.format === 'json') {
    return (parsed.feed.items ?? []).map(item => normalizeJsonItem(item, config.imageField));
  }
  return (parsed.feed.items ?? []).map(item => ({
    ...normalizeRdfItem(item),
    imageUrl: resolveImageUrl(item, config.imageField),
    mappedValues: resolveMappedValues(item, config.mappedValues),
  }));
}
```

`normalizeRssItem`/`normalizeAtomEntry`/`normalizeRdfItem` each need a placeholder `mappedValues:
{}` added to their own return object (it gets overridden by the spread above immediately after, but
the object literal must satisfy the now-required `NormalizedItem.mappedValues` key at the point
it's constructed) - add `mappedValues: {},` to each, right after the existing `geo: ...,` line in
all three functions.

`normalizeJsonItem` (no `feedsmith` `dc`/`itunes` fields exist for JSON Feed - always empty) also
needs the same key added directly, no spread-override needed since nothing will ever fill it: add
`mappedValues: {},` right after its existing `geo: undefined,` line.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `./node_modules/.bin/tsx --test shared/feedSource/normalize.test.ts`

Expected: PASS, all 24 tests green.

- [ ] **Step 8: Run the full test suite and typecheck**

Run: `yarn test && yarn typecheck`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add shared/feedSource/mappedValues.ts shared/feedSource/types.ts shared/feedSource/normalize.ts shared/feedSource/normalize.test.ts test-fixtures/rss/sample-feed-with-dc.xml test-fixtures/rss/sample-feed-podcast.xml
git commit -m "feat(feedSource): resolve dc/itunes fields into NormalizedItem.mappedValues"
```

---

### Task 2: `mappedValues` in `app/utils/rssHandler.ts`

**Files:**
- Modify: `app/utils/rssHandler.ts`
- Modify: `app/utils/rssHandler.test.ts`
- Modify: `app/types/index.d.ts`

**Interfaces:**
- Consumes: `NormalizedItem.mappedValues` (Task 1).
- Produces: no new exports - `parseString`'s existing `$title`/`$link`/`$description`/`$georss`
  behavior is unchanged; this adds dynamic `$key` substitution for whatever the bot's own
  `mappedValues` config declares. `createFeedSource` now also receives `mappedValues` so
  `normalizeFeed` actually resolves the requested fields.

- [ ] **Step 1: Write the failing test**

Append to `app/utils/rssHandler.test.ts`, inside the same `describe('rssHandler', ...)` block as the
existing `$georss` E2E test, following that exact real-HTTP-server pattern:

```typescript
    it('substitutes $key placeholders from mappedValues with real dc:creator data', async () => {
      const feedBody =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        '<channel><title>T</title><description>D</description><link>https://example.com</link>' +
        '<item><title>Article</title><link>https://example.com/article</link>' +
        '<guid>https://example.com/article</guid>' +
        '<pubDate>Wed, 05 Aug 2026 09:00:00 GMT</pubDate>' +
        '<dc:creator>Jane Doe</dc:creator></item>' +
        '</channel></rss>';

      const server = createServer((_req, res) => {
        res.writeHead(200, {'Content-Type': 'application/rss+xml'});
        res.end(feedBody);
      });
      await new Promise<void>(resolve => server.listen(0, resolve));
      const port = (server.address() as {port: number}).port;

      fs.writeFileSync(
        path.join(TEST_DATA_DIR, 'config.json'),
        JSON.stringify({
          string: '$title by $author',
          publishEmbed: false,
          languages: ['en'],
          truncate: true,
          runInterval: 60,
          dateField: '',
          imageField: '',
          ogUserAgent: 'bsky.rss/test',
          removeDuplicate: false,
          mappedValues: [{key: 'author', value: 'dc:creator'}],
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
      assert.strictEqual(queued[0]?.content, 'Article by Jane Doe');
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/tsx --test app/utils/rssHandler.test.ts`

Expected: FAIL. `queued[0].content` is `'Article by $author'` (unsubstituted) - `mappedValues` isn't
threaded through to `createFeedSource` yet, and `parseString` has no dynamic-key substitution loop.

- [ ] **Step 3: Add `mappedValues` to the global `Config` type**

In `app/types/index.d.ts`, add one field to the `Config` interface (after `imageField`):

```typescript
interface Config {
  string: string;
  publishEmbed?: boolean;
  embedType?: string;
  languages: string[];
  truncate?: boolean;
  runInterval: number;
  dateField?: string;
  publishDate?: boolean;
  imageField?: string;
  mappedValues?: Array<{key: string; value: string}>;
  ogUserAgent: string;
  descriptionClearHTML?: boolean;
  forceDescriptionEmbed?: boolean;
  imageAlt?: string;
  removeDuplicate?: boolean;
  titleClearHTML?: boolean;
  adaptiveSpacing?: boolean;
  spacingWindow?: number;
  minSpacing?: number;
  maxSpacing?: number;
}
```

- [ ] **Step 4: Thread `mappedValues` through to `createFeedSource`, and implement the `parseString` substitution**

In `app/utils/rssHandler.ts`, find:

```typescript
  reader = createFeedSource(fetch_url, fetch_interval, {imageField: config.imageField});
```

Replace with:

```typescript
  reader = createFeedSource(fetch_url, fetch_interval, {
    imageField: config.imageField,
    mappedValues: config.mappedValues,
  });
```

Find the `$georss` branch and add the dynamic `$key` loop right after it, before truncation:

```typescript
  if (string.includes('$georss')) {
    const coords = item.geo
      ? `https://www.openstreetmap.org/?mlat=${item.geo.lat}&mlon=${item.geo.lng}`
      : '';
    parsedString = parsedString.replace('$georss', coords);
  }

  for (const [key, value] of Object.entries(item.mappedValues)) {
    const placeholder = `$${key}`;
    if (parsedString.includes(placeholder)) {
      parsedString = parsedString.replace(placeholder, value);
    }
  }

  if (parsedString.length > 300 && truncate) {
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `./node_modules/.bin/tsx --test app/utils/rssHandler.test.ts`

Expected: PASS.

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `yarn test && yarn typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/utils/rssHandler.ts app/utils/rssHandler.test.ts app/types/index.d.ts
git commit -m "feat(app): support mappedValues \$key placeholders in post templates"
```

---

### Task 3: `mappedValues` in `fleet/feedReader.ts`

**Files:**
- Modify: `fleet/feedReader.ts`
- Modify: `fleet/feedReader.test.ts`

**Interfaces:**
- Consumes: `NormalizedItem.mappedValues` (Task 1), the exported `parseString` function and
  `normalizedItem()` test helper (both already exist in this file).
- Produces: no new exports - same dynamic `$key` behavior as Task 2, in the fleet-mode
  implementation. `FeedReaderConfig` gains `mappedValues`, threaded through to `createFeedSource`.

- [ ] **Step 1: Write the failing tests**

Append to `fleet/feedReader.test.ts`, near the existing `$georss` `parseString` tests:

```typescript
test('parseString substitutes a $key placeholder from mappedValues', () => {
  const item = normalizedItem({mappedValues: {author: 'Jane Doe'}});
  const result = parseString('By $author', item, false, false, false);
  assert.equal(result, 'By Jane Doe');
});

test('parseString substitutes multiple $key placeholders from mappedValues', () => {
  const item = normalizedItem({mappedValues: {author: 'Jane Doe', duration: '2416'}});
  const result = parseString('$author - $duration seconds', item, false, false, false);
  assert.equal(result, 'Jane Doe - 2416 seconds');
});

test('parseString leaves a template placeholder with no matching mappedValues key untouched', () => {
  const item = normalizedItem({mappedValues: {}});
  const result = parseString('$unmapped stays literal', item, false, false, false);
  assert.equal(result, '$unmapped stays literal');
});
```

Update the `normalizedItem()` helper (used by every test in this file, including the ones above) to
include the new required field:

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
    mappedValues: {},
    ...overrides,
  };
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/tsx --test fleet/feedReader.test.ts`

Expected: FAIL. The three new tests fail because `parseString` has no dynamic-key substitution
loop yet - `$author`/`$duration` are returned unsubstituted. (The third test - "leaves an unmapped
placeholder untouched" - actually already passes with today's code, since there's nothing to
substitute it with either way; it's a real behavioral guarantee worth locking in now, not a
regression risk introduced by this task.)

- [ ] **Step 3: Add `mappedValues` to `FeedReaderConfig`, thread it through, implement the substitution**

In `fleet/feedReader.ts`, find the `FeedReaderConfig` interface:

```typescript
export interface FeedReaderConfig {
  string: string;
  publishEmbed?: boolean;
  embedType?: string;
  languages?: string[];
  truncate?: boolean;
  dateField?: string;
  imageField?: string;
  imageAlt?: string;
  ogUserAgent?: string;
  descriptionClearHTML?: boolean;
  forceDescriptionEmbed?: boolean;
  removeDuplicate?: boolean;
  titleClearHTML?: boolean;
}
```

Add `mappedValues`:

```typescript
export interface FeedReaderConfig {
  string: string;
  publishEmbed?: boolean;
  embedType?: string;
  languages?: string[];
  truncate?: boolean;
  dateField?: string;
  imageField?: string;
  mappedValues?: Array<{key: string; value: string}>;
  imageAlt?: string;
  ogUserAgent?: string;
  descriptionClearHTML?: boolean;
  forceDescriptionEmbed?: boolean;
  removeDuplicate?: boolean;
  titleClearHTML?: boolean;
}
```

Find the constructor's `createFeedSource` call:

```typescript
    this.reader = createFeedSource(
      feedUrl,
      fetchIntervalMinutes,
      {imageField: config.imageField},
      {fetchTimeoutMs: sharedLimiters.httpTimeoutMs},
    );
```

Replace with:

```typescript
    this.reader = createFeedSource(
      feedUrl,
      fetchIntervalMinutes,
      {imageField: config.imageField, mappedValues: config.mappedValues},
      {fetchTimeoutMs: sharedLimiters.httpTimeoutMs},
    );
```

Find the `$georss` branch in `parseString` and add the dynamic `$key` loop right after it, before
truncation:

```typescript
  if (template.includes('$georss')) {
    const coords = item.geo
      ? `https://www.openstreetmap.org/?mlat=${item.geo.lat}&mlon=${item.geo.lng}`
      : '';
    result = result.replace('$georss', coords);
  }

  for (const [key, value] of Object.entries(item.mappedValues)) {
    const placeholder = `$${key}`;
    if (result.includes(placeholder)) {
      result = result.replace(placeholder, value);
    }
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
git commit -m "feat(fleet): support mappedValues \$key placeholders in post templates"
```

---

### Task 4: Documentation

**Files:**
- Modify: `documentation/CONFIGURATION.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: nothing (docs only, no code dependency) - can run any time after Task 1 confirms the
  recognized-value list is final.

- [ ] **Step 1: Add a full `### mappedValues` section to `documentation/CONFIGURATION.md`**

Find the `### imageField` section and insert a new section immediately after it (matching that
section's Type/Default/Requires/examples structure):

```markdown
### `mappedValues`

**Type:** `Array<{key: string; value: string}>`
**Default:** `[]` (empty)

**What it does:** Maps specific Dublin Core or iTunes/Podcast feed fields into new `$key`
template placeholders, usable in `string` and `imageAlt` alongside `$title`/`$link`/`$description`/
`$georss`.

**Recognized `value` strings:**
- `dc:creator` - item author/byline (joined with `, ` if a feed lists more than one)
- `dc:date` - item's Dublin Core date (first value if repeated)
- `dc:subject` - item's Dublin Core subject (joined with `, ` if more than one)
- `dc:publisher` - item's Dublin Core publisher (joined with `, ` if more than one)
- `itunes:duration` - podcast episode duration in seconds
- `itunes:episode` - podcast episode number
- `itunes:season` - podcast season number
- `itunes:explicit` - `"true"` or `"false"`
- `itunes:author` - podcast episode/show author

**Example:**
```json
{
  "string": "$title by $author",
  "mappedValues": [{"key": "author", "value": "dc:creator"}]
}
```

**Fallback behavior:**
- An unrecognized `value` resolves that `$key` to an empty string - never an error
- A `value` whose field is absent on a given item resolves to an empty string for that item
- `mappedValues` only resolves for RSS/Atom/RDF feeds - JSON Feed has no namespace concept, so
  every `$key` resolves to empty string there
```

- [ ] **Step 2: Add `mappedValues` to README's Configuration File section**

Find the `$georss` line in the "Available variables" list and add `mappedValues` as a new top-level
bullet right after the existing `imageField` bullet (matching how `imageField` is documented there
today - a short one-line pointer, full detail lives in CONFIGURATION.md):

```markdown
- `mappedValues`: Maps specific `dc:*`/`itunes:*` feed fields into new `$key` template placeholders. See [CONFIGURATION.md](documentation/CONFIGURATION.md#mappedvalues) for the full recognized-value list and examples.
```

- [ ] **Step 3: Add a CHANGELOG entry**

In `CHANGELOG.md`, find the `## [Unreleased]` section (currently holds the `$georss` W3C Basic Geo
fallback entry) and add:

```markdown
- `mappedValues` config option - maps `dc:creator`/`dc:date`/`dc:subject`/`dc:publisher` and
  `itunes:duration`/`itunes:episode`/`itunes:season`/`itunes:explicit`/`itunes:author` feed fields
  into new `$key` template placeholders
```

- [ ] **Step 4: Commit**

```bash
git add documentation/CONFIGURATION.md README.md CHANGELOG.md
git commit -m "docs: document mappedValues config option"
```
