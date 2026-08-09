# Fleet Mode Identity-Scoped Duplicate Detection — Design

## Problem

Fleet mode runs many independent bot configs, each with its own SQLite `state.sqlite`
(`fleet/botStore.ts`), keyed by `bot.id` (`fleet/configLoader.ts`). Production has 9 real
Bluesky identities each shared across multiple bot configs with different feed URLs and
different `botId`/`secretKey` values — e.g. `trumpwatch.skyfleet.blue` is shared by
`trumpwatch-en`, `trumpnews-en`, `trump-tweets-en`, and `jan6-en`; `euwatch.live` by 7 bot
configs. This is deliberate: separate FreshRSS category exports feeding one logical Bluesky
account.

Because each bot's dedup state (`seen_items`, date cursor) is entirely private to that bot,
two bot configs sharing an identity have zero shared knowledge of what's already been posted
to that account. The same story appearing in two category feeds gets posted twice to the same
account. The old pre-fleet deployment avoided this by literally pointing multiple bot
containers at the same data directory, sharing one `db.txt`; the fleet architecture never
rebuilt an equivalent.

A backstop already landed (commit `a435f52`, merged to `main`): `fleet/dedupeKey.ts`'s
`computeDedupeKey(identifier, url)` is scoped by `identifier` instead of `botId`, so two bots
sharing an identity compute the same AT-Proto `rkey` for the same URL — a genuine cross-bot
duplicate now collides at the PDS's own atomic per-`rkey` uniqueness constraint. This is
correctly a backstop, not a fix: it only catches the duplicate *after* wasted work (OG scrape,
image fetch, a real failed post attempt), it depends on `isAlreadyExistsError`
(`fleet/bskyClient.ts`) — a hardcoded `return false` stub pending real-world PDS error-shape
verification — happening to route into the right generic error bucket, and it produces no
clean observability (a real duplicate logs identically to an unrelated unknown error).

This design adds an explicit, positive, early duplicate check, scoped by identity, so a
genuine cross-bot duplicate is skipped *before* any OG/image work or post attempt — not
discovered after a failed one. The `a435f52` fix stays in place as defense-in-depth for the
race window where two bots discover the same story within the same poll cycle before either
has posted yet.

## Architecture

One new file, `fleet/identityStore.ts`, exporting an `IdentityStore` class — a thin
`node:sqlite`-backed store, structurally mirroring `BotStore`'s existing
`seenValueExists`/`writeSeenValue`/`cleanupOldSeenValues` shape (the same shape single-bot
mode's `app/utils/dbHandler.ts` already established for this exact kind of "have we seen this
URL" tracking). One `IdentityStore` instance exists per distinct Bluesky `identifier` — not
per bot config — built once at fleet startup and shared by every `FeedReader` whose bot config
publishes to that identity.

`fleet/feedReader.ts`'s `handleItem()` gains one new unconditional check, placed immediately
after the existing `computeDedupeKey()` call and before the `publishEmbed` block — i.e. before
any network work, and regardless of a bot's own `publishEmbed`/`removeDuplicate` settings:

```ts
const dedupeKey = computeDedupeKey(this.identifier, item.link || item.id);

if (this.identityStore.publishedExists(dedupeKey)) {
  this.runtime.logger.verbose(
    'FEED',
    `Skipping cross-bot duplicate: ${item.title ?? '(untitled)'} (${itemUrl ?? item.id})`,
    this.botId,
  );
  return;
}
this.identityStore.writePublished(dedupeKey);

const lastCursor = this.store.readCursor();
// ...existing publishEmbed / removeDuplicate / staleness logic, unchanged...
```

This check runs unconditionally rather than mirroring the existing nested placement, so it
also incidentally closes a pre-existing gap: bots configured with `publishEmbed: false`
currently get no link-based dedup at all (only date-cursor comparison), and will now get
identity-scoped protection like every other bot.

The existing per-bot `removeDuplicate`/staleness logic inside `publishEmbed` is untouched —
this is a second, earlier, identity-scoped gate layered in front of it, not a replacement.

## Storage

`data/fleet/identities/<identifier>/published.sqlite`. Bluesky identifiers (e.g.
`trumpwatch.skyfleet.blue`) are already safe path segments — the same assumption
`configLoader.ts` already makes for `bot.id` when building `dbPath`; no sanitization needed.

```sql
CREATE TABLE IF NOT EXISTS published_items (
  dedupe_key TEXT PRIMARY KEY,
  recorded_at TEXT NOT NULL
)
```

Keyed by the same `dedupeKey` produced by `fleet/dedupeKey.ts`'s `computeDedupeKey(identifier,
url)` — one canonical definition of "this identity has published this URL," reused rather than
redefined, so the identity store and the AT-Proto `rkey` backstop can never disagree about what
counts as a duplicate.

`IdentityStore` public API:

```ts
class IdentityStore {
  constructor(dbPath: string);
  publishedExists(dedupeKey: string): boolean;
  writePublished(dedupeKey: string): void;
  cleanupOldPublished(maxAgeHours: number): void;
  close(): void;
}
```

`cleanupOldPublished` uses the same 96-hour convention already established by
`dbHandler.cleanupOldValues()` and `BotStore.cleanupOldSeenValues()`, and — unlike
`BotStore`'s existing (never-called) equivalent — is actually wired up: called from
`fleet/botWorker.ts`'s drain cycle. Multiple `BotWorker`s sharing one `IdentityStore` will each
call it once per cycle — harmless, since it's a plain `DELETE ... WHERE recorded_at < cutoff`
against an indexed primary key, not a correctness concern to dedupe.

## Wiring

`fleet/runFleet.ts`'s `main()`, immediately after `loadFleet()` returns `bots`: build
`const identityStores = new Map<string, IdentityStore>()`, populating it lazily while
iterating `bots` — one `IdentityStore` constructed per distinct `spec.identifier`, reused for
every subsequent bot config sharing that identifier. `buildWorker` gains an `identityStore:
IdentityStore` parameter, threaded straight into `new FeedReader(...)`. On shutdown, every
`IdentityStore` in the map is closed alongside the existing per-bot `store.close()` calls.

`fleet/benchmarkHarness.ts` (synthetic bots, each with an independent identity today) and
`fleet/feedReader.test.ts` (8 `FeedReader` construction call sites) need the same mechanical
constructor-arg threading the `a435f52` `identifier` fix already required — a new required
`IdentityStore` argument, backed by a throwaway in-memory or tmp-file instance in tests.

## Backfill

None. The store starts empty for every identity, including the 9 already-shared production
identities. This accepts a short transition window where a story already posted under the old
per-bot scheme could, in principle, still be seen as "new" by a second sharing bot once — but
the `a435f52` `rkey`-collision backstop already catches that case. After the transition window
(bounded by the 96-hour cleanup horizon), all future items are covered by the new store from
first sight. No migration script, no judgment calls about which existing per-bot table counts
as "already published" for a given identity.

## Testing

- `fleet/identityStore.test.ts` (new): `publishedExists`/`writePublished` round-trip,
  `cleanupOldPublished` removes only entries past the age cutoff (mirroring
  `botStore.test.ts`'s existing `cleanupOldSeenValues` test).
- `fleet/feedReader.test.ts`: two `FeedReader` instances constructed with the same `identifier`
  but different `botId`s and different feed URLs — posting the same URL through the first
  marks it published in the shared `IdentityStore`; the second, given the same URL, must skip
  it via the new early check. A second regression test proves two different identifiers do
  *not* cross-block each other on the same URL.

## Out of scope

`BotStore.cleanupOldSeenValues()` is implemented and tested but never called from any fleet
mode production code path today — the per-bot `seen_items` table already grows unboundedly.
Noted during this design; tracked as a separate follow-up, not fixed here.
