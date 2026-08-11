# feedSource

Generic RSS/Atom/JSON Feed polling and normalization module.

## Features

- ✅ **Multi-format support**: RSS 2.0, Atom 1.0, JSON Feed, RDF
- ✅ **Configurable image extraction**: `enclosure`, `media:content`, or custom fields
- ✅ **Namespace mapping**: Dublin Core (`dc:creator`), iTunes, Media RSS
- ✅ **GeoRSS support**: Extracts coordinates from GeoRSS and W3C Geo tags
- ✅ **Markdown link syntax**: Parses `[text](url)` in templates with facet generation
- ✅ **Mapped values**: Extract custom feed fields via XPath-like syntax
- ✅ **Error handling**: Distinguishes feed-level vs item-level failures
- ✅ **Polling control**: Prevents overlapping polls, configurable intervals
- ✅ **Type-safe**: Full TypeScript support with exported types

## Quick Start

```typescript
import {createFeedSource} from './shared/feedSource/index.ts';

const feed = createFeedSource(
  new URL('https://example.com/feed.xml'),
  60, // Poll every 60 minutes
  {
    imageField: 'enclosure',
    mappedValues: [{key: 'author', value: 'dc:creator'}],
  }
);

feed.start({
  onItem: async (item) => {
    console.log(`New: ${item.title} - ${item.link}`);
  },
  onItems: (batch) => {
    console.log(`Processed ${batch.length} items`);
  },
  onError: (error) => {
    if (error.scope === 'poll') {
      console.error(`Feed fetch failed: ${error.message}`);
    } else {
      console.error(`Item processing failed: ${error.message}`);
    }
  },
});

// Later: feed.stop();
```

## API Reference

### `createFeedSource(feedUrl, intervalMinutes, config?, options?)`

Creates a new feed poller.

**Parameters:**

- `feedUrl: URL` - The feed URL to poll
- `intervalMinutes: number` - Polling interval in minutes (minimum: 0.002 = 7.2 seconds)
- `config?: FeedSourceConfig` - Optional feed processing configuration
- `options?: PollerOptions` - Optional polling behavior options

**Returns:** `FeedSource`

**Example:**
```typescript
const feed = createFeedSource(
  new URL('https://blog.example.com/rss'),
  30,
  {imageField: 'media:content'},
  {fetchTimeoutMs: 15000}
);
```

---

### `FeedSourceConfig`

Configuration for feed processing.

```typescript
interface FeedSourceConfig {
  imageField?: string;
  mappedValues?: Array<{key: string; value: string}>;
}
```

#### `imageField`

Specifies which field to extract images from:
- `'enclosure'` - Use `<enclosure>` tags (RSS 2.0 standard)
- `'media:content'` - Use `<media:content>` tags (Media RSS extension)
- Custom field name - Extract from any feed field

**Example:**
```typescript
{imageField: 'media:content'}
```

#### `mappedValues`

Extract custom feed fields and map them to template variables.

**Format:**
```typescript
[
  {key: 'author', value: 'dc:creator'},
  {key: 'category', value: 'category'}
]
```

This makes `$author` and `$category` available in post templates, populated from `<dc:creator>` and `<category>` tags respectively.

**Supported namespaces:**
- Dublin Core: `dc:creator`, `dc:date`, `dc:subject`, etc.
- iTunes: `itunes:author`, `itunes:duration`, etc.
- Media RSS: `media:description`, `media:keywords`, etc.
- Standard RSS: `category`, `author`, `pubDate`, etc.

---

### `PollerOptions`

Advanced polling behavior options.

```typescript
interface PollerOptions {
  fetchTimeoutMs?: number;
  fetchBody?: FetchFeedBody;
}
```

#### `fetchTimeoutMs`

HTTP request timeout in milliseconds.

- **Default:** 10000 (10 seconds)
- **Must be positive**

**Example:**
```typescript
{fetchTimeoutMs: 15000} // 15 second timeout
```

#### `fetchBody`

Custom fetch function for testing or special HTTP requirements.

**Type:**
```typescript
type FetchFeedBody = (url: string, timeoutMs: number) => Promise<string>;
```

**Example:**
```typescript
{
  fetchBody: async (url, timeout) => {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: {'User-Agent': 'MyBot/1.0'}
    });
    return response.text();
  }
}
```

---

### `FeedSource`

Returned by `createFeedSource()`. Controls the polling lifecycle.

```typescript
interface FeedSource {
  start(callbacks: FeedSourceCallbacks): void;
  stop(): void;
}
```

#### `start(callbacks)`

Starts polling the feed.

**Callbacks:**

```typescript
interface FeedSourceCallbacks {
  onItem: (item: NormalizedItem) => Promise<void>;
  onItems: (items: NormalizedItem[]) => void;
  onError: (error: FeedSourceError) => void;
}
```

- **`onItem`**: Called once per item, in feed order. Async. If it rejects, the error is caught and passed to `onError` with `scope: 'item'` - the batch continues processing.

- **`onItems`**: Called after all items in a batch have finished processing (success or failure). Receives the full batch (may be empty).

- **`onError`**: Called on fetch/parse failure (`scope: 'poll'`) or when `onItem` rejects (`scope: 'item'`).

**Example:**
```typescript
feed.start({
  onItem: async (item) => {
    await postToBluesky(item.title, item.link);
  },
  onItems: (batch) => {
    console.log(`Processed ${batch.length} items`);
  },
  onError: (error) => {
    if (error.scope === 'poll') {
      // Feed-level failure - might affect health checks
      console.error(`Poll failed: ${error.message}`);
    } else {
      // Single item failed - batch continues
      console.warn(`Item failed: ${error.message}`);
    }
  },
});
```

#### `stop()`

Stops polling. Clears the interval timer.

**Example:**
```typescript
feed.stop();
```

---

### `NormalizedItem`

Normalized feed item structure, regardless of source format.

```typescript
interface NormalizedItem {
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
```

**Fields:**

- `id`: Unique identifier (GUID, link, or generated hash)
- `title`: Item title
- `link`: Item URL
- `date`: Publication date (ISO 8601 string)
- `description`: Short description/summary
- `content`: Full content (from `content:encoded`, `description`, or `summary`)
- `imageUrl`: Image URL (from configured `imageField`)
- `geo`: Geographic coordinates (if GeoRSS/W3C Geo tags present)
- `mappedValues`: Custom extracted values from `config.mappedValues`

**Example:**
```typescript
{
  id: 'https://blog.example.com/post/123',
  title: 'New Release Announcement',
  link: 'https://blog.example.com/post/123',
  date: '2025-01-15T10:30:00.000Z',
  description: 'We just released version 2.0...',
  content: 'We just released version 2.0 with many new features...',
  imageUrl: 'https://blog.example.com/images/release.jpg',
  geo: {lat: 37.7749, lng: -122.4194},
  mappedValues: {
    author: 'John Doe',
    category: 'Releases'
  }
}
```

---

### `FeedSourceError`

Custom error class for feed failures.

```typescript
class FeedSourceError extends Error {
  readonly cause?: unknown;
  readonly scope: 'poll' | 'item';
}
```

**Scope:**

- `'poll'`: Feed fetch or parse failed - the entire poll failed, no items processed
- `'item'`: One item's `onItem` handler rejected - the rest of the batch continued

**Example:**
```typescript
onError: (error) => {
  if (error.scope === 'poll') {
    // Feed health issue - might want to alert or retry
    healthCheck.markUnhealthy();
  } else {
    // Just one item failed - log and continue
    logger.warn(`Item processing failed: ${error.message}`);
  }
}
```

---

## Advanced Usage

### Markdown Links with Facets

The feedSource module supports `[text](url)` markdown syntax in templates and automatically generates Bluesky facets for rich text links.

```typescript
import {
  extractMarkdownLinks,
  finalizeMarkdownLinks,
} from './shared/feedSource/markdownLinks.ts';

const template = 'New post: [$title]($link)';
const item = {
  title: 'Example Post',
  link: 'https://example.com/post',
  // ... other fields
};

// Extract links with placeholder resolution
const extracted = extractMarkdownLinks(template, (placeholder) => {
  if (placeholder === '$title') return item.title;
  if (placeholder === '$link') return item.link;
});

// Finalize to get text + facets
const result = finalizeMarkdownLinks(extracted.text, extracted.pending);

console.log(result.text); // "New post: Example Post"
console.log(result.facets); // [{byteStart: 10, byteEnd: 22, url: 'https://example.com/post'}]
```

### GeoRSS Support

Automatically extracts coordinates from GeoRSS and W3C Geo tags:

```xml
<!-- GeoRSS Simple -->
<georss:point>45.256 -71.92</georss:point>

<!-- W3C Geo -->
<geo:lat>45.256</geo:lat>
<geo:long>-71.92</geo:long>
```

Use in templates:
```typescript
const template = 'Location: $georss';
// Renders as: Location: https://www.openstreetmap.org/?mlat=45.256&mlon=-71.92
```

### Custom Image Resolution

```typescript
{
  imageField: 'media:thumbnail' // Extract from <media:thumbnail url="...">
}
```

### Preventing Overlapping Polls

The poller automatically prevents overlapping polls:

```typescript
const feed = createFeedSource(
  feedUrl,
  5, // Poll every 5 minutes
);
```

If a poll's `onItem` work (Open Graph fetch, image download) takes longer than 5 minutes, the next scheduled poll is skipped - preventing duplicate processing.

---

## Testing

Run feedSource tests:

```bash
yarn test shared/feedSource/**/*.test.ts
```

Test coverage:

```bash
yarn test:coverage shared/feedSource/**/*.test.ts
```

---

## Implementation Notes

### Polling Behavior

- Uses `setInterval()` for polling
- First poll happens immediately on `start()`
- Polls are skipped if previous poll is still running
- `stop()` clears the interval immediately

### Error Handling

- Fetch/parse errors are caught and passed to `onError` with `scope: 'poll'`
- Item handler rejections are caught and passed to `onError` with `scope: 'item'`
- The process never crashes from feed errors

### Feed Format Detection

Automatically detects and parses:
- RSS 2.0 (via `<rss>` root)
- Atom 1.0 (via `<feed>` root with `xmlns="http://www.w3.org/2005/Atom"`)
- JSON Feed (via `version` field)
- RDF (via `<rdf:RDF>` root)

### Memory Safety

- Feed body capped at 20MB (configurable via `MAX_FEED_BODY_BYTES`)
- Image downloads capped at 10MB (in calling code)
- No unbounded arrays or queues

---

## Migration from feedsub/feedme

This module replaces the older `feedsub` + `feedme` stack with a simpler, typed API.

**Key differences:**

- **Unified API**: One `createFeedSource()` instead of separate `feedsub.FeedHub` + `feedme` parser
- **Typed items**: `NormalizedItem` interface instead of arbitrary feed fields
- **Error scopes**: Distinguishes `'poll'` vs `'item'` errors
- **No arbitrary fields**: Only fixed `NormalizedItem` shape - use `mappedValues` for custom fields
- **Markdown facets**: Built-in `[text](url)` support instead of manual parsing

See `documentation/v1-to-v2.md` for full migration guide.

---

## License

MIT (same as parent project)
