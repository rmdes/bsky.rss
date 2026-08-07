# GeoRSS Support: `$georss` Placeholder

**Date:** 2026-08-07

**Status:** Approved for implementation

## Purpose

`app/utils/rssHandler.ts` (single-bot mode) and `fleet/feedReader.ts` (fleet mode) both build post
text via a `$placeholder` template (`config.string`, `config.imageAlt`) that today supports
`$title`, `$link`, and `$description`. Some feeds - notably geolocation feeds like Environment and
Climate Change Canada's earthquake alerts - carry per-item coordinates via the GeoRSS namespace
(`<georss:point>lat lon</georss:point>`) that this templating has no way to surface.

This mirrors upstream issue [`milanmdev/bsky.rss#277`](https://github.com/milanmdev/bsky.rss/issues/277),
filed against the same real feed used to validate this design.

`feedsmith` (adopted in the
[feedsub-to-feedsmith migration](2026-08-06-feedsmith-migration-design.md)) already parses GeoRSS
natively into structured `{lat, lng}` data - confirmed by parsing the real feeds below. No new XML
handling is needed; the gap is entirely in `shared/feedSource/normalize.ts` discarding the field and
`parseString` having no placeholder for it.

The same investigation surfaced a second, related gap: the reference feed has no `<link>` element on
any entry, only `<id>` doubling as the permalink - a valid Atom pattern, but one the current
`normalizeAtomEntry` doesn't fall back to, making that feed unusable today with `publishEmbed: true`
or any `$link` in the template (both hard-require `item.link`).

## Feeds used to validate this design

All three were fetched and parsed with `feedsmith` directly during design:

1. **`https://www.earthquakescanada.nrcan.gc.ca/cache/earthquakes/canada-fr.atom`** (Atom) - 241
   entries, 241 with `georss:point` (100% coverage). No `<link>` element on any entry; `<id>` is a
   real `https://` URL on every entry.
2. **`https://api.flickr.com/services/feeds/geo/?g=322338@N20&lang=en-us&format=feed-georss`**
   (Atom) - 13 entries, 13 with `georss:point` (100% coverage). Also carries the redundant W3C Basic
   Geo namespace (`<geo:lat>`/`<geo:long>`) for the same coordinate, which this design ignores in
   favor of `georss:point`. Has a proper `<link rel="alternate">` on every entry; `<id>` is a
   `tag:flickr.com,...` URI, not a URL.
3. **`https://weather.im/iembot-rss/room/abqchat.xml`** (RSS) - 41 items, 0 with any GeoRSS tag.
   Confirms GeoRSS coverage is an all-or-nothing property of a feed in practice, not something that
   varies item-to-item within one feed.

## Goals

- A bot's `config.string` or `config.imageAlt` template can include `$georss`, which renders as an
  OpenStreetMap link built from the item's `georss:point` coordinates.
- An Atom entry with no `<link>` falls back to `<id>` as the link, automatically, when `<id>` is a
  real `http(s)://` URL - zero config required, and proven safe against a real feed (Flickr) where
  `<id>` is present but must NOT be treated as a link.

## Non-goals

- **General namespace field-mapping** (a `mappedValues`-style mechanism exposing arbitrary
  `dc:`/`media:`/`itunes:`/etc. fields via config). Real and useful per the broader feedsmith
  capability inventory done alongside this design, but explicitly out of scope for this round -
  GeoRSS only. May return as its own future spec.
- **An explicit `linkField` config override.** Without the general field-mapping mechanism above,
  `NormalizedItem` has no other raw fields for it to point at - it would be a config option with no
  real use case yet. The automatic `id`-as-URL fallback covers the concrete need.
- **`georss:elev`, `georss:line`, `georss:polygon`, `georss:box`.** Only `georss:point` is in scope -
  it's what the reference feeds carry and what was asked for.
- **JSON Feed support for `$georss`.** The JSON Feed spec has no namespace/extension concept, so
  `item.geo` is simply never set for JSON Feed items; `$georss` resolves to empty string there, same
  as any other feed/item lacking a point.

## Architecture

```
feedsmith parse
  -> entry.georss?.point: {lat, lng}   (already structured, all formats except JSON Feed)
  -> normalizeFeed (shared/feedSource/normalize.ts)
       -> NormalizedItem.geo?: {lat: number; lng: number}
  -> app/utils/rssHandler.ts parseString()      \  both read NormalizedItem.geo,
  -> fleet/feedReader.ts parseString()          /  both render the same $georss text
```

## Components

### `shared/feedSource/types.ts`

`NormalizedItem` gains one optional field:

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

### `shared/feedSource/normalize.ts`

Each of `normalizeRssItem`, `normalizeAtomEntry`, and `normalizeRdfItem` reads `item.georss?.point`
(or `entry.georss?.point` for Atom) and sets `geo` from it directly - the shape feedsmith produces
(`{lat: number; lng: number}`) already matches `NormalizedItem.geo` with no transformation needed.
`normalizeJsonItem` always sets `geo: undefined` (JSON Feed has no georss field to read).

`normalizeAtomEntry` also gains the automatic link fallback:

```typescript
function normalizeAtomEntry(entry: DeepPartial<Atom.Entry<string>>): NormalizedItem {
  const explicitLink =
    entry.links?.find(l => !l.rel || l.rel === 'alternate')?.href ?? entry.links?.[0]?.href;
  // Some Atom feeds (e.g. Environment Canada's earthquake feed) omit <link> entirely and use
  // <id> as the permalink instead - a valid Atom pattern. Only trust <id> as a link when it's
  // actually a URL: other feeds (e.g. Flickr's) use tag: URIs for <id> while still providing a
  // real <link>, so this must never override an existing link or promote a non-URL id.
  const link = explicitLink ?? (entry.id && /^https?:\/\//.test(entry.id) ? entry.id : undefined);
  return {
    id: entry.id || link || '',
    title: entry.title,
    link,
    date: entry.published ?? entry.updated,
    description: entry.summary,
    content: entry.content,
    imageUrl: undefined,
    geo: entry.georss?.point,
  };
}
```

### `app/utils/rssHandler.ts` and `fleet/feedReader.ts` (`parseString`)

Both gain the same `$georss` branch, placed alongside the existing `$description` handling:

```typescript
if (template.includes('$georss')) {
  const coords = item.geo ? `https://www.openstreetmap.org/?mlat=${item.geo.lat}&mlon=${item.geo.lng}` : '';
  result = result.replace('$georss', coords);
}
```

No `throw` on a missing point - unlike `$title`/`$link`, a missing point does not disqualify the
item. Matches `$description`'s existing "substitute empty string when absent" behavior. Real-world
GeoRSS coverage is all-or-nothing per feed (see Feeds section above), so this only matters as a
safety net for a single malformed entry or a future upstream feed change, not routine operation.

## Testing

Fixtures derived from the three feeds fetched during design (trimmed to 2-3 entries each, following
the existing `test-fixtures/` convention):

- **Atom, no `<link>`, `<id>` is a URL, `georss:point` present** (earthquakes-canada shape) - `geo`
  is set, `link` falls back to `id`.
- **Atom, `<link>` present, `<id>` is a `tag:` URI, `georss:point` present** (Flickr shape) - `geo`
  is set, `link` comes from `<link>` (fallback never triggers, confirming it doesn't misfire).
- **Atom, no `georss:point`** - `geo` is `undefined`, `$georss` renders as empty string, item still
  posts.
- **RSS, `georss:point` present** - synthetic fixture (GeoRSS is equally valid in RSS 2.0; no real
  feed of this shape was fetched during design) - `geo` is set via the RSS normalizer.
- **`$georss` in `imageAlt`** - same substitution path, since both `config.string` and
  `config.imageAlt` go through the same `parseString`.

## Rollout

Purely additive - no production bot config references `$georss` today, and the Atom link fallback
only activates when no `<link>` exists at all (never overrides one). Zero risk to the 59 live bots.

End-to-end validation against a real Bluesky account is deferred until a test account is available;
at that point, testing may use a new fleet bot pointed at the earthquakes-canada or Flickr feed.
