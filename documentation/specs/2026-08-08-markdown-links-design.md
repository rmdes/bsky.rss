# Markdown-Style Link Syntax for Post Templates

**Date:** 2026-08-08

**Status:** Approved for implementation

## Purpose

`config.string`/`config.imageAlt` templates today produce plain text, and any link in that text
(a bare `$link` or `$georss` URL) gets auto-linkified by `@atproto/api`'s `RichText.detectFacets()`
- which only regex-matches bare URLs, `@mentions`, `#tags`, and `$cashtags` in the final post text.
This means every link renders as its full raw URL, which is long, ugly, and eats into the 300-char
budget. Bluesky's underlying data model (`app.bsky.richtext.facet`) supports arbitrary display text
mapped to a link - a facet is just `{byteStart, byteEnd, uri}` over any span of the post text - but
nothing today lets a bot operator use that.

**`@atproto/api` does not parse Markdown.** Verified by reading
`node_modules/@atproto/api/src/rich-text/detection.ts` directly: `detectFacets()` only recognizes
bare URLs/mentions/tags/cashtags via regex. Posting the literal text `[link](https://example.com)`
today does nothing useful - the bracket text stays as literal characters, and only the bare URL
substring inside the parens gets auto-linkified. This spec makes bsky.rss parse `[text](url)`
syntax itself in its own template layer and hand-build the underlying facets - "Markdown-style
syntax as a bsky.rss template convention," not native Bluesky/AT Protocol behavior.

## Goals

- `[displayText](urlPlaceholder)` syntax usable in `config.string`/`config.imageAlt`, alongside the
  existing `$title`/`$link`/`$description`/`$georss`/`mappedValues` placeholders.
- Both sides may contain `$placeholders`: `[$title]($link)` renders the item's real title as
  clickable text pointing at its link; `[Map]($georss)` renders static text "Map" pointing at the
  OpenStreetMap coordinates link.
- Multiple `[...](...)` spans per template are supported.
- The url side accepts any known placeholder - built-in (`$link`, `$georss`) or a `mappedValues`
  key - not a closed list. If the resolved value isn't a real URL, the span degrades to plain,
  non-clickable text rather than erroring, matching the project's existing graceful-degradation
  convention (`imageField`, `mappedValues`).
- Fully operator-controlled, fully backward compatible: a bot's `config.string` that never uses
  `[...](...)` syntax behaves identically to today. There is no default or implied behavior that
  turns any existing placeholder into a link automatically - not even `$title`. An operator chooses
  per-bot, per-template, whether to use whole-content-as-link (`[$title]($link)`) or short static
  trailing links left of the untouched body text (`$title\n[Link]($link) [Map]($georss)`), or
  anything in between.

## Non-goals

- **No embed interaction.** `publishEmbed`/`embedType` continue to build the embed from the feed
  item's own `$link` exactly as they do today, completely independent of what appears in the
  template text. Using `[text](url)` syntax has zero effect on embed selection.
- **No escape syntax.** An operator who wants a literal `[text](url)`-shaped string that is *not*
  meant as this syntax has no way to opt out inline. No known real use case forces this; not
  building it.
- **Feed-supplied content is never scanned for this syntax.** If a feed's title literally contains
  `"Deal signed [details](confidential)"`, that text is never parsed as a link - see Architecture.

## Architecture

```
config.string (operator's raw template)
  -> markdownLinks.ts: scan template for [text](url) spans, resolve placeholders inside each span
  -> parseString (app/utils/rssHandler.ts, fleet/feedReader.ts):
       existing $title/$link/$description/$georss/mappedValues substitution runs on what's left
  -> bskyHandler.ts: merge hand-built facets with detectFacets()'s own auto-detected facets
  -> post
```

### Why the template, not the resolved content, must be scanned

This project already hit this exact bug class with `mappedValues` (a JSON Feed item resolving
`mappedValues: {}` instead of per-key `''`, letting an unresolved `$key` leak through as literal
text - fixed in `946c951`/`711941a`). The equivalent risk here: if `[text](url)` were detected in
the *final*, feed-content-substituted post text, a feed's own title or description containing
bracket-paren-shaped text would get misparsed as link syntax. `markdownLinks.ts` therefore scans
**`config.string`/`config.imageAlt` themselves** - the operator's own authored template, before any
feed content is substituted in - never the resolved output. Feed content flowing through `$title`,
`$description`, etc. cannot trigger this syntax no matter what it contains.

### `shared/feedSource/markdownLinks.ts` (new file)

One function, mirroring `mappedValues.ts`'s and `imageResolver.ts`'s shape - small, single-purpose,
no new abstraction beyond what those two already established:

```typescript
export interface MarkdownLinkResult {
  text: string; // template with [text](url) spans replaced by their resolved display text
  facets: Array<{byteStart: number; byteEnd: number; uri: string}>; // byte offsets into `text`
}

export function resolveMarkdownLinks(
  template: string,
  resolve: (placeholder: string) => string | undefined, // looks up $title/$link/$georss/mappedValues keys
): MarkdownLinkResult
```

`resolve()` receives the literal `$`-prefixed token exactly as captured from the template (e.g.
`"$title"`, `"$link"`, `"$duration"`), not a stripped bare name - matching how the token appears
verbatim in `[$title]($link)`, so the caller in `parseString` can pass its own existing
substitution-table lookup unchanged rather than reformatting keys for this one call site.

- Regex: `/\[([^\]]*)\]\(([^)]*)\)/g` over `template`.
- For each match: resolve `$placeholder` tokens inside both the bracket text and the paren text via
  the same `resolve()` callback `parseString` already uses for every other placeholder (no
  duplicated resolution logic - `markdownLinks.ts` is handed a resolver function, not a copy of the
  substitution table).
- If the resolved paren-side value matches `/^https?:\/\//` (same convention already used by
  `normalize.ts`'s Atom id-as-link fallback - reused here for consistency, not reinvented): replace
  the whole `[...](...)` span with just the resolved display text, and record a facet at that span's
  byte position in the growing output.
- If the resolved paren-side value is empty, unresolved, or not `http(s)://`: replace the span with
  just the resolved display text (post still reads cleanly) but record no facet - plain,
  non-clickable text.
- If the resolved display text is empty (e.g. `[]($link)`): the span disappears entirely, no
  zero-length facet is built (a zero-length clickable span is pointless).
- Spans that don't match the regex (malformed brackets, e.g. an unmatched `[` or missing `)`) are
  left completely untouched as literal text - no error, no special handling.

### `parseString` changes (both files)

Call `resolveMarkdownLinks()` first, before the existing `$title`/`$link`/`$description`/`$georss`/
`mappedValues` substitution loop, passing a `resolve` closure backed by the same lookups that loop
already performs. The existing loop then runs on `resolveMarkdownLinks()`'s output `text` exactly as
it does today - any placeholder outside a matched span is untouched by this change and substitutes
normally. `parseString`'s return value grows a `facets` field alongside the existing text/content,
threaded through `queueHandler.writeQueue()`'s queue item into the object `bskyHandler.post()`
receives.

### Truncation interaction

The existing 300-char truncate step runs *after* markdown-link resolution (unchanged position in
`parseString`) - bracket syntax shortens text (a stripped 60-char URL becomes a few words), so
truncation triggers less often once this ships, not more. If the 277-char cutoff falls inside a
facet's byte range, that facet is dropped entirely - no half-cut link with a `byteEnd` past the
truncated string's length. Matches the project's degrade-gracefully convention rather than emitting
an invalid facet.

### `bskyHandler.ts` change: merging facet sources

`RichText.detectFacets()`/`detectFacetsWithoutResolution()` both **overwrite** `this.facets`, per
their own JSDoc ("Overwrites the existing facets with auto-detected facets") - confirmed by reading
`node_modules/@atproto/api/src/rich-text/rich-text.ts` directly. Calling `detectFacets()` on a
`RichText` that already carries the hand-built markdown-link facets would silently discard them.
Current code:

```typescript
const bskyText = new RichText({text: content});
await bskyText.detectFacets(bskyAgent);
```

New code: run auto-detection on a throwaway `RichText` over the same final content, then construct
the real `RichText` with both facet sources merged. No manual sort needed - the `RichText`
constructor already sorts (and filters negative-length) facets whenever `facets` is passed in
(`rich-text.ts:159-161`, using the identical `byteStart` comparator):

```typescript
const autoDetect = new RichText({text: content});
await autoDetect.detectFacets(bskyAgent);
const bskyText = new RichText({
  text: content,
  facets: [...markdownFacets, ...(autoDetect.facets ?? [])],
});
```

No overlap between the two sources is possible: a markdown-link span's raw URL text is stripped out
of `content` by `resolveMarkdownLinks()` before `content` ever reaches this function, so
`detectFacets()` re-scanning the same final text cannot rediscover a URL that's no longer there as
literal text.

## Testing

- `shared/feedSource/markdownLinks.test.ts` (new): span extraction, placeholder resolution on both
  sides, non-URL degradation (empty facet, text still renders), empty display text (span vanishes,
  no zero-length facet), malformed brackets left untouched, multiple spans in one template.
- `rssHandler.test.ts`/`feedReader.test.ts`: integration-level - a real template through the full
  `parseString` flow, confirming the returned facets have correct byte offsets against the final
  text and that non-bracket placeholders elsewhere in the same template still substitute normally.
- `bskyHandler.test.ts`: a case proving hand-built markdown-link facets survive the merge (not
  overwritten) and that an auto-detected facet elsewhere in the same text (e.g. a bare `$georss`
  used without brackets) still gets added alongside them.
- Truncation: a template whose facet byte range crosses the 277-char cutoff verifies that facet is
  dropped, not corrupted.

## Rollout

No production bot config uses `[text](url)` syntax today - purely additive, zero risk to existing
bots (nothing changes for a template that never uses the syntax). `documentation/CONFIGURATION.md`
gains a subsection under `string`/`imageAlt` (not a new top-level config key, since this is template
syntax at the same tier as `$title`/`$georss`) with both worked examples from this design
(whole-title-as-link and static-trailing-links styles) and the fallback-behavior bullets, matching
`mappedValues`' documentation treatment.
