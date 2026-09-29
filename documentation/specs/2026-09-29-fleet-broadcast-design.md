# Fleet Broadcast Tool — Design

## Problem

The fleet operator sometimes needs to post the same maintenance/support message (with a link)
to every account's followers at once - e.g. "we're aware of an issue with X feed and are
looking into it" or "brief downtime expected tonight for maintenance." Today there's no way to
do this except manually posting from each of the 60 accounts by hand.

## Goal

A manually-run script, edited and invoked directly on the VPS, that queues the same message +
link for every fleet account, reusing the fleet's existing identities, credentials, and posting
infrastructure - without flooding the Bluesky API or bursting all 60 posts into followers'
timelines simultaneously.

## Non-goals

- No CLI argument parsing, no interactive multi-step wizard. The operator edits two constants
  (`MESSAGE`, `LINK`) directly in the script file and runs it - matching how they described
  wanting to use it.
- No broadcast history UI or audit log beyond what's already queryable from `queue_items`
  directly (each row's `enqueued_at`/`published_at` timestamps already serve as an audit trail
  if someone wants to query the SQLite files by hand).
- No per-bot message customization. One message, one link, identical for every targeted account.
- No new throttling/rate-limiting logic. Posting timing is entirely delegated to each bot's
  already-running `BotWorker`/`Scheduler` - the same pacing (`minSpacing`/`maxSpacing`/
  `adaptiveSpacing`) and 429-retry handling every other post already gets.
- No enforcement of `perBotQueueMaxLength` (the running `BotWorker`'s soft per-bot queue cap).
  This script writes to `BotStore` directly, not through a `BotWorker` instance, so that cap
  doesn't apply here. Accepted as a low-probability, non-catastrophic edge case: a queue could
  exceed its soft cap by one item for the duration of a manual broadcast.

## Architecture

### New file: `fleet/broadcast.ts`, run via `yarn fleet:broadcast`

Matches the existing `fleet/status.ts`/`fleet/logControl.ts` shape: small, exported, unit-tested
functions hold the real logic; a thin `main()` (argv/prompt/console output, real `open-graph-scraper`
call) is gated by `import.meta.main` and not directly tested, matching that existing convention.

```typescript
// Operator edits these two constants (and optionally the exclude list) before running.
const MESSAGE = 'Edit this message before running.';
const LINK = 'https://example.com/announcement';
const EXCLUDE_BOT_IDS: string[] = [];
```

### Flow

1. **Load bot configs** via the existing `configLoader.loadFleet()` (the same function
   `runFleet.ts` uses) - gives every bot's `botId`, `identifier`, and `dbPath` with zero new
   config-loading code.
2. **Compute the target list**: every loaded bot's `botId`, minus `EXCLUDE_BOT_IDS`. Exported
   as a pure function (`targetBots(allBots, excludeIds)`) for unit testing.
3. **Scrape Open Graph data for `LINK` once** - a single `open-graph-scraper` call (the exact
   same library already used in `fleet/feedReader.ts`, imported directly here rather than
   refactored out of that file - `feedReader.ts`'s own embed-building logic is tightly coupled
   to per-RSS-item config merging that doesn't apply to a manually-authored message, so
   extracting a shared helper isn't a clean fit; this is a small, self-contained ~15-line call).
   No `SharedLimiters` involved - this is one manual invocation, not concurrent fleet polling.
   Builds one `ParsedEmbed` (`{uri, title, description, imageUrl}`, `type` left `undefined` so
   `bskyClient.post()`'s embed-building falls into its external-link-card branch, not the
   image-post branch). If the scrape fails, falls back to no embed - the message still posts as
   plain text with the link auto-detected into a clickable facet by `RichText.detectFacets()`
   at post time (existing behavior in `bskyClient.ts`'s `post()`, unchanged). Exported as
   `buildBroadcastEmbed(ogResult: OpenGraphResult | undefined, link: string): ParsedEmbed | undefined`
   for unit testing against a fake scrape result.
4. **Compute the dedupeKey**: a SHA-256 hash of `MESSAGE + LINK`, prefixed `broadcast:` to
   namespace it away from RSS-derived dedupe keys (which are URL/date-derived). Deterministic -
   re-running the script with unchanged `MESSAGE`/`LINK` produces the same key for every bot,
   so `BotStore.enqueue()`'s existing `UNIQUE(dedupe_key)` constraint makes a re-run a safe
   no-op per bot. Editing the text changes the hash, so a genuinely different broadcast is a
   genuinely new item. Exported as `broadcastDedupeKey(message: string, link: string): string`.
5. **Print a preview**: the message text, the resolved embed's title (if any), and the full
   list of target bot IDs. Exits here if `--dry-run` was passed.
6. **Require typed confirmation**: prompts `Type BROADCAST to continue:` via `node:readline`:
   anything else aborts with no writes. `--yes` skips the prompt (for a deliberate scripted
   re-run of an already-confirmed broadcast).
7. **For each target bot**: open its `state.sqlite` via the existing `BotStore` and call
   `store.enqueue({title: \`Broadcast: ${MESSAGE.slice(0, 40)}\`, content: MESSAGE, embedJson: embed ? JSON.stringify(embed) : null, languagesJson: null, facetsJson: null, itemDate: new Date().toISOString(), dedupeKey})`
   - the exact same method and `queue_items` table regular RSS items use. `title` is truncated
     the same way `BotWorker`'s own drain-time log line truncates post content (40 chars) - it's
     only ever used as a human-readable label in `QUEUE`-scope log lines, never posted, so
     distinguishing one broadcast from another in the logs is its only job. One bot's failure
     (can't open its store, `enqueue()` throws) is caught, logged, and doesn't stop the rest.
8. **Print a summary**: counts of newly-enqueued / already-queued (duplicate dedupeKey) /
   failed, listing bot IDs for the latter two so the operator can follow up.

From here, nothing new happens: each bot's already-running `BotWorker` drains the row on its
own next tick and posts it through the exact same `Scheduler` pacing and 429-retry handling
every other post already gets - that's the entire rate-limit story, with zero new throttling
code. If the fleet container runs with `DRY_RUN=true`, the eventual `BskyClient.post()` call
already no-ops and logs `[dry-run] would publish...`, so dry-run is respected transitively
without this script needing to know about it.

## Data flow

```
Operator edits MESSAGE/LINK/EXCLUDE_BOT_IDS, runs `yarn fleet:broadcast`
  -> loadFleet() -> target bot list (all minus excluded)
  -> one open-graph-scraper call for LINK -> ParsedEmbed | undefined
  -> preview + typed confirmation (or --dry-run exits here, or --yes skips the prompt)
  -> for each target bot:
       open state.sqlite via BotStore -> enqueue(...) with a deterministic dedupeKey
  -> summary: enqueued / already-queued / failed, per bot

Later, independently, per bot (already-existing, untouched):
  BotWorker's own drain tick -> Scheduler pacing -> BskyClient.post()
    (DRY_RUN-aware, 429-retry-aware, exactly like every other post)
```

## Testing

- `broadcastDedupeKey`: same input -> same key; different message or link -> different key.
- `targetBots`: excludes named bot IDs; empty exclude list returns everyone; excluding a
  nonexistent ID is a no-op (doesn't throw).
- `buildBroadcastEmbed`: a successful OG result produces a `ParsedEmbed` with the scraped
  title/description/image; a failed/undefined OG result returns `undefined` (no embed, not a
  thrown error); `type` is never set to `'image'`.
- The per-bot enqueue step, tested against a fake `BotStore`-shaped object: a normal call
  writes the row; a duplicate dedupeKey (simulating a re-run) is reported as "already queued"
  not an error; a throwing store is caught and reported as "failed" without stopping the loop
  over the remaining bots.
- `main()` itself (argv, the real confirmation prompt, the real `open-graph-scraper` call) is
  not directly unit-tested, matching `fleet/status.ts`/`fleet/logControl.ts`'s existing
  convention for their own thin `main()` functions.

## Documentation

- `documentation/fleet.md`: a new top-level `## Broadcast messages` section (not nested under
  "Operations visibility" - that section is about observing the running fleet, this is a
  one-off manual admin action, a different kind of content) covering what `fleet/broadcast.ts`
  is for, how to edit and run it, the confirmation/`--dry-run`/`--yes` flags, and the fact that
  actual posting timing follows each bot's existing pacing (not instant).
- `CLAUDE.md`'s Fleet mode section: one line naming `fleet/broadcast.ts`, matching how every
  other fleet module is introduced there.
