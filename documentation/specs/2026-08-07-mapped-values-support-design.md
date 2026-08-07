# General Namespace Field Mapping: `mappedValues`

**Date:** 2026-08-07

**Status:** Approved for implementation

## Purpose

`app/utils/rssHandler.ts` (single-bot mode) and `fleet/feedReader.ts` (fleet mode) build post
text via a `$placeholder` template that today supports a fixed set of built-in variables:
`$title`, `$link`, `$description`, `$georss`. Real feeds this project depends on carry richer
per-item data than that - byline/creator information via Dublin Core, and podcast metadata
(duration, episode/season number) via the iTunes namespace - that `feedsmith` already parses but
`shared/feedSource/normalize.ts` currently discards entirely.

This mirrors the design direction the upstream maintainer and a reporter already sketched in
[`milanmdev/bsky.rss#277`](https://github.com/milanmdev/bsky.rss/issues/277) (the same issue that
originated the `$georss` work): a `mappedValues: [{key, value}]` config array, where `value` names
a specific feed field and `key` becomes a new `$key` template placeholder. `$georss` shipped ahead
of this as a fixed, single-purpose placeholder because that round scoped deliberately to GeoRSS
only; this is where the general mechanism it was deferred from becomes real.

## Real feeds used to validate scope

Ten real feeds from the production fleet were fetched and inspected during design (a mix of
FreshRSS-aggregated, Inoreader-aggregated, euwatch-aggregated, and two fully direct/unmediated
publisher feeds):

- **`dc:creator` is real and present**: `actudroit-fr`, `medias-fr`, `elpais-en`, `afsca-fr` all
  carry it today, with genuine values (e.g. `"Pod Save America"`, `"New York Times Opinion"` on
  `podfeed-fr`, an aggregated podcast feed).
- **`itunes:*` is confirmed absent** from every feed checked, including `podfeed-fr` itself (a real
  podcast aggregation) - FreshRSS's RSS export strips iTunes-namespace tags even when the
  underlying source podcast feeds carry them. Validating `itunes:*` therefore requires pointing a
  bot directly at one real podcast feed, bypassing that aggregation layer.
- **`prism:`, `slash:`, `thr:` had zero occurrences** across all ten feeds, including the two
  direct/unmediated ones (so this isn't just an aggregator artifact for those two) - none are in
  scope for this round; each is deferred to its own future issue once a real feed carrying it
  turns up, the same treatment already given to GeoRSS-GML
  ([`rmdes/bsky.rss#7`](https://github.com/rmdes/bsky.rss/issues/7)).

## Goals

- A bot's `config.json` can declare `mappedValues: [{key, value}]`; each entry makes `$key`
  available in `config.string`/`config.imageAlt`, resolving to the named feed field's value on
  each item (or empty string if that item lacks it).
- Initial recognized `value` strings: `dc:creator`, `dc:date`, `dc:subject`, `dc:publisher`,
  `itunes:duration`, `itunes:episode`, `itunes:season`, `itunes:explicit`, `itunes:author`.
- `mappedValues` gets a full top-level documentation section (Type/Default/examples), matching
  `imageField`'s treatment - it is a real `config.json` key, not a template variable like
  `$title`/`$georss`, which are documented in the "Available variables" list instead.

## Non-goals

- **`prism`, `slash`, `thr`.** No real feed available to validate against; each gets its own future
  issue once one turns up, matching GeoRSS-GML's precedent.
- **`media:thumbnail` support.** A real, separate gap (confirmed during design: `resolveImageUrl`
  never reads `item.media?.thumbnails`), but it belongs to the existing `imageField` mechanism, not
  this one - tracked as its own follow-up, not part of this spec.
- **Free-form/arbitrary path access.** `value` must be one of the fixed recognized strings above,
  the same closed-list philosophy `imageField` already uses (`"enclosure"`/`"media:content"`), not
  a generic deep-path walker into `feedsmith`'s internals. Keeps end-user config decoupled from
  `feedsmith`'s exact internal shape, and keeps per-field formatting (see Architecture) possible.
- **JSON Feed support.** JSON Feed has no namespace/extension concept, so `mappedValues` resolves
  to empty string for every key on JSON Feed items, same restriction `$georss`'s `geo` field
  already has.

## Architecture

```
feedsmith parse
  -> item.dc?.creators / item.itunes?.duration / etc.  (already structured, RSS/Atom/RDF only)
  -> normalizeFeed (shared/feedSource/normalize.ts)
       -> resolveMappedValues(item, config.mappedValues) -> NormalizedItem.mappedValues: Record<string, string>
  -> app/utils/rssHandler.ts parseString()      \  both read NormalizedItem.mappedValues,
  -> fleet/feedReader.ts parseString()          /  both substitute $key for each entry
```

### Recognized value → extraction mapping

One function per recognized `value` string, mirroring `resolveImageUrl`'s explicit if-chain
(easy to extend, each addition isolated, unrecognized values degrade gracefully rather than error):

| `value` | Source field | Type | Formatting |
|---|---|---|---|
| `dc:creator` | `item.dc?.creators` | `string[]` | Joined with `", "` - DC fields are legitimately repeatable (feedsmith's own type marks the singular `dc.creator` deprecated in favor of the array). A feed with two co-authors should show both, not silently drop one. |
| `dc:date` | `item.dc?.dates` | `TDate[]` | First value, as-is (a string already, matching how `date` elsewhere in `NormalizedItem` is left unparsed) |
| `dc:subject` | `item.dc?.subjects` | `string[]` | Joined with `", "`, same repeatability reasoning as `dc:creator` |
| `dc:publisher` | `item.dc?.publishers` | `string[]` | Joined with `", "` |
| `itunes:duration` | `item.itunes?.duration` | `number` (seconds) | `String(value)` - raw seconds. A future formatter (e.g. `H:MM:SS`) is not in scope here; ship the raw value first, since no real podcast feed has been fetched yet to confirm the number is actually in seconds (feedsmith's type says `number` but the real-world value needs confirming against Testing's real feed before promising a specific format) |
| `itunes:episode` | `item.itunes?.episode` | `number` | `String(value)` |
| `itunes:season` | `item.itunes?.season` | `number` | `String(value)` |
| `itunes:explicit` | `item.itunes?.explicit` | `boolean` | `String(value)` (`"true"`/`"false"`) |
| `itunes:author` | `item.itunes?.author` | `string` | as-is |

All nine only apply to RSS/Atom/RDF (`feedsmith`'s JSON Feed item type has neither `dc` nor
`itunes` fields at all - no namespace concept in that format).

### Duplicate `key` handling

If a config's `mappedValues` array has two entries with the same `key`, the last one wins - the
extraction function builds `NormalizedItem.mappedValues` by assigning into a plain object in array
order (`result[entry.key] = ...`), so a later entry's assignment naturally overwrites an earlier
one's. No startup error for this case, unlike the reserved-word collision above - a same-key
duplicate is very unlikely to be a real config bug (accidentally reusing `title`/`link` as a key
name is a bug; a bot author copy-pasting their own array and forgetting to change a `key` is a
mistake, but not one worth failing startup over).

### `NormalizedItem` change

```typescript
export interface NormalizedItem {
  // ...existing fields unchanged...
  mappedValues: Record<string, string>;
}
```

Always present (empty object `{}` when a bot's config sets no `mappedValues`, or when none of the
requested fields exist on a given item) - matches the existing convention of every other
`NormalizedItem` field being a required key, never `optional?:`.

### `FeedSourceConfig` change

```typescript
export interface FeedSourceConfig {
  imageField?: string;
  mappedValues?: Array<{key: string; value: string}>;
}
```

### Config-load validation (both `app/utils/rssHandler.ts` and `fleet/feedReader.ts`)

At startup, before any feed is polled: reject a `mappedValues` entry whose `key` collides with a
reserved placeholder name (`title`, `link`, `description`, `georss`) with a clear error - a
config that silently let a mapped value shadow built-in template behavior would be confusing to
debug. This is a fail-fast startup check, not a per-item runtime check.

### `parseString` change (both files, same shape as the `$georss` addition)

```typescript
for (const [key, value] of Object.entries(item.mappedValues)) {
  const placeholder = `$${key}`;
  if (template.includes(placeholder)) {
    template = template.replace(placeholder, value);
  }
}
```

Placed after the existing `$georss` branch, before truncation. Single `.replace()` (first
occurrence only), matching the existing `$title`/`$link`/`$description`/`$georss` convention
exactly - not `.replaceAll()`, no new behavior introduced.

## Testing

- **`dc:creator`/`dc:date`/`dc:subject`/`dc:publisher`**: fixtures derived from the real feeds
  confirmed to carry `dc:creator` during design (`elpais-en`, `medias-fr`), trimmed to 2-3 entries,
  following the existing `test-fixtures/` convention. Cases: single creator, multiple creators
  (join behavior), field absent (empty-string fallback).
- **`itunes:*`**: fixtures derived from whichever real podcast feed is hand-picked for the
  standalone rollout test (see Rollout) - not synthesized blind, since the exact shape of a real
  podcast feed's iTunes tags (e.g. whether `duration` is genuinely in seconds) needs confirming
  against real data, not just feedsmith's type declaration.
- **Reserved-key collision**: a config with `{"key": "title", "value": "dc:creator"}` must fail
  startup with a clear error, for both `app/utils/rssHandler.ts` and `fleet/feedReader.ts`.
- **Unrecognized `value`**: a config entry with an unrecognized `value` string resolves that key to
  empty string, consistent with `imageField`'s existing "unrecognized degrades gracefully" behavior
  - not a startup error, since a not-yet-supported value shouldn't block an otherwise-valid config.

## Rollout

No production bot config uses `mappedValues` today - purely additive, zero risk to existing bots.

`dc:creator` can be validated end-to-end immediately against a real existing fleet account already
confirmed to carry it (no new account needed). `itunes:*` needs a real podcast feed picked by hand
and tested via a throwaway container/account, the same pattern used for `seismes-fr`'s standalone
GeoRSS validation - `podfeed-fr`'s own feed can't be used directly since it aggregates many
podcasts through FreshRSS, which strips the very tags being tested.
