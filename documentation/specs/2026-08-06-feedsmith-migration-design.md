# Feed Parser Migration: feedsub → feedsmith

**Date:** 2026-08-06

**Status:** Approved for implementation

## Purpose

`app/utils/rssHandler.ts` (single-bot mode) and `fleet/feedReader.ts` (fleet mode, 59 live
bots) both depend on `feedsub`, which wraps `feedme` for XML parsing. `feedsub` was last
published 2022-06-18 and is effectively unmaintained. `feedme`'s output is untyped and
attribute-dependent - a tag with attributes (e.g. RSS `<guid isPermaLink="false">`) comes
back as an object, a plain tag as a string - and both files carry hand-rolled workarounds
for this (`textOf()`, the `typeof item.link === 'object'` checks, forced `any` typing on the
reader with a comment explaining why).

This migrates feed parsing to `feedsmith` (actively maintained, pushed same-day as this
spec's writing, 612 stars, MIT, 2 dependencies: `entities` and `fast-xml-parser`), which
gives real per-format types and native support for RSS enclosures and Media RSS namespace
fields that today's code re-implements by hand via the `imageField` config walk.

`feedsmith` is a pure parse/generate library - no HTTP fetch, no polling, no event emitter.
This is not a drop-in swap: it replaces `feedsub`'s parsing *and* requires a small
replacement for the polling/fetch/event layer `feedsub` currently also provides.

## Goals

- Replace `feedsub`/`feedme` with `feedsmith` for feed parsing (RSS, Atom, JSON Feed, RDF).
- Consolidate the currently-duplicated feed-reading logic in `app/utils/rssHandler.ts` and
  `fleet/feedReader.ts` into one shared module both depend on.
- Preserve all existing config-driven behavior with zero required changes to the 59 live
  bot config files on the VPS, in particular `imageField` (49 bots set `media:content`,
  2 set `enclosure`, 8 leave it empty) and `dateField` (all 59 bots leave it empty).
- Remove the async-inside-EventEmitter workaround in `fleet/feedReader.ts` (manually
  `.catch()`-wrapping an async listener to prevent an unhandled rejection from crashing
  the whole fleet process) by using an interface where this bug class is structurally
  impossible.
- Verify real-world parsing behavior against all 59 live bot feeds before cutover, not
  just fixture-based unit tests.

## Non-goals

- No change to `dbHandler`/`BotStore` cursor/dedup semantics, queueing, posting, rate
  limiting, or any bot-facing behavior beyond how a feed item's fields are extracted.
- No redesign of the `imageField`/`dateField` config schema. `imageField` keeps its current
  string values; the mapping from string to feedsmith's typed structure is internal.
- No requirement to support every feedsmith-covered RSS namespace on day one. Only
  `enclosures` and the Media RSS `media:content` field are implemented now, since those are
  the only two non-empty `imageField` values in production today. The mapping is designed
  to be extended (one new entry) when a future bot needs a different tag.
- No dashboard, metrics, or persistent comparison tooling beyond the one-time pre-cutover
  shadow-run script.

## Background: why `imageField` must stay flexible

`imageField` is not a fixed enum in practice. Some bots consume a FreshRSS "User Query"
feed that merges several source feeds into one folder-level feed for a themed bot account;
FreshRSS's generated output uses `media:content` for images regardless of what the original
source feeds used. Other bots point directly at a single source feed, and the value was set
by manually inspecting that feed to see how *it* proposes images - `enclosure` in two known
cases today, but this is feed-specific and not guaranteed to stay a two-value set as new
bots are added. The design must keep this genuinely extensible, not hardcode a closed
switch statement.

## Architecture

A new shared module at `lib/feedSource/` (named to avoid colliding with the existing
`fleet/feedReader.ts` class, which keeps its name and becomes a consumer) replaces
`feedsub` entirely, owning three responsibilities `feedsub` used to bundle into one opaque
dependency:

1. **Polling** - interval-based fetch using `axios` (already a dependency), matching
   `feedsub`'s `interval`/`emitOnStart` behavior.
2. **Parsing** - `feedsmith.parseFeed(rawBody)`, returning a typed
   `{format: 'rss'|'atom'|'rdf'|'json', feed}` result.
3. **Normalization** - per-format adapters mapping each format's native feedsmith shape to
   one common `NormalizedItem`.

Both `app/utils/rssHandler.ts` and `fleet/feedReader.ts` keep their existing
responsibilities (Open Graph fetch, embed-building, queueing/posting) but consume
`NormalizedItem` instead of raw feedme output. This also deletes some current defensive
code - e.g. `typeof item.link === 'object' ? item.link.href : item.link` becomes
unnecessary, since `NormalizedItem.link` is always a plain string by construction.

The interface is async-callback based, not EventEmitter:

```ts
const source = createFeedSource(feedUrl, intervalMinutes);
source.start(
  async (item: NormalizedItem) => { /* per-item handling */ },
  (err: FeedSourceError) => { /* fetch/parse failure */ },
);
source.stop();
```

## Components

- **`lib/feedSource/poller.ts`** - interval fetch scheduler. Deliberately has no
  cursor/dedup logic of its own: it hands back *every* parsed item on every poll, the same
  way `feedsub`'s `'item'` event fires for every item regardless of position. This is a
  real simplification, not just a stylistic choice - both current files already re-check
  `date <= lastDate` themselves and don't fully rely on `feedsub`'s internal filtering
  (documented in a comment in `feedReader.ts` today), so the "is this item new" decision is
  already effectively owned by the callers via `dbHandler`/`BotStore`. Making that explicit
  removes a redundant, partially-trusted filtering layer instead of reimplementing it.
- **`lib/feedSource/parse.ts`** - thin wrapper around `feedsmith.parseFeed()`, normalizing
  its thrown errors into this module's own `FeedSourceError` type.
- **`lib/feedSource/normalize.ts`** - per-format adapters: `normalizeRssItem`,
  `normalizeAtomEntry`, `normalizeJsonItem`, `normalizeRdfItem`, dispatched by the format
  `parse.ts` detected.
- **`lib/feedSource/imageResolver.ts`** - the extensible `imageField` → typed-location
  mapping. Given `imageField` and a parsed item, resolves an image URL by checking the
  location the config value names:
  - `"enclosure"` → `item.enclosures?.[0]?.url` (RSS `Enclosure[]`, or the Atom/JSON Feed
    equivalent field once those are added).
  - `"media:content"` → `item.media?.contents?.[0]?.url` (feedsmith's typed Media RSS
    namespace field, also checking `item.media?.groups?.[].contents` since `media:content`
    can appear inside a `media:group`).
  - Unset/empty → no field-driven image; the existing Open Graph fallback still applies
    unchanged.
  - Unrecognized value → treated as unset (logged at debug level), not a hard error - a
    bot with a value the resolver doesn't yet know about should fall back to Open Graph
    rather than break, and adding real support is a one-entry addition to this file.
- **`lib/feedSource/types.ts`** - `NormalizedItem`, `FeedSourceConfig`, `FeedSourceError`.
- **`lib/feedSource/index.ts`** - `createFeedSource()`, the public entrypoint.

## Data flow

One poll cycle:

1. `poller.ts` timer fires → `axios.get(feedUrl)` → raw body string.
2. `parse.ts` → `feedsmith.parseFeed(body)` → `{format, feed}`. A thrown error (network
   failure already surfaced by axios, or feedsmith rejecting unparseable content) becomes
   a call to the caller's `onError`, matching today's `reader.on('error', ...)` path -
   the caller does not need to distinguish "couldn't reach it" from "reached it but it's
   not a feed."
3. `normalize.ts` dispatches on `format` → `NormalizedItem[]`, resolving the image field
   via `imageResolver.ts` where `config.imageField` is set.
4. `poller.ts` calls `await onItem(item)` for each item in feed order, inside a per-item
   try/catch - a rejection from one bad item (missing title/link, etc.) is caught right
   there, logged, and the loop continues. This is the structural replacement for
   `fleet/feedReader.ts`'s current manual `.catch()`-wrapping of an async EventEmitter
   listener: the async-callback interface makes "one bad item can't crash the process"
   true by construction instead of by every caller remembering to guard it.
5. The caller (`rssHandler.ts` / `fleet/feedReader.ts`) does what it does today: cursor/dedup
   check against `dbHandler`/`BotStore`, Open Graph fetch, embed-building, then
   queue/post.

## Verification before cutover

A one-time shadow-run script, `fleet/verifyFeedMigration.ts`, following the existing
`fleet/verifyDuplicateDetection.ts` pattern: for each configured bot's real feed URL (read
from the live VPS config), fetch once, run both the old path (`feedsub`/`feedme` parse) and
the new path (`feedsmith` parse + normalize) against the same raw body, and diff the
resulting title/link/date/description/image per item. Run against all 59 real bot feeds on
the VPS before any production cutover; any unexplained divergence blocks the deploy until
understood.

## Testing

- **Unit tests** for `lib/feedSource/`: `parse.ts` and `normalize.ts` against real fixture
  feeds per format, extending the existing `test-fixtures/rss/` pattern with new fixtures
  for Atom, JSON Feed, and RDF. `imageResolver.ts` tests cover the two real production
  cases (`media:content`, `enclosure`), the empty/unset case, and an unrecognized value
  falling back to Open Graph rather than erroring.
- **Existing suites** (`app/utils/rssHandler.test.ts`, `fleet/feedReader.test.ts`,
  `fleet/botWorker.test.ts`, etc.) updated to exercise `lib/feedSource/` instead of mocking
  `feedsub`.
- Full `yarn test` (both `app/` and `fleet/` suites) plus `yarn typecheck` and `yarn lint`
  must pass before the shadow-run step.

## Dependency changes

- Remove `feedsub` from `package.json` (drops `feedme`, `miniget`, `newsemitter`,
  `tiny-typed-emitter` transitively - none of these are used anywhere else in the repo).
- Add `feedsmith`.

## Rollout

Once the full test suite is green and the shadow-run script shows no unexplained
divergence across all 59 real bot feeds, deploy with the same rigor already established for
production changes in this repo: merge to `main`, bump version and tag a release, `git
pull` + rebuild/pull the image on the VPS, `docker compose up -d --force-recreate`, watch
the staggered 59-bot reactivation and `/health` endpoint the same way prior deploys in this
repo have been verified. No separate dry-run phase is needed beyond the shadow-run, since
posting/queueing/rate-limiting behavior is unchanged - only how a feed item's fields are
extracted changes.

## Config compatibility summary

| Config field | Current values in production | Behavior after migration |
|---|---|---|
| `imageField` | `"media:content"` (49 bots), `"enclosure"` (2 bots), `""` (8 bots) | Unchanged - same string values, resolved via `imageResolver.ts` instead of a raw feedme property walk. Zero bot config files need editing. |
| `dateField` | `""` (all 59 bots) | Stays supported as-is. Not removed - it's cheap to keep and removing a still-functional, if currently unused, option buys nothing. |
