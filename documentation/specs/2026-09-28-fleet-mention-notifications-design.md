# Fleet Mention/Reply/Quote Notifications — Design

## Problem

The fleet runs 60 independent Bluesky accounts. When someone replies to, @-mentions, or
quote-posts one of them, there's currently no way to find out short of manually opening each
account in the Bluesky app. The operator (rmdes) has been working around this with a separate
Bluesky feed that scrapes @ mentions across the fleet, but wants something better: real-time
awareness so a reply that needs a response - a complaint, a correction request, a factual
dispute - doesn't sit unseen for days.

## Goal

Poll each fleet account's Bluesky notifications for new replies, mentions, and quotes, and push
a notification to the operator's phone via their existing `ntfy` server the first time each one
is seen - never twice for the same one, even across process restarts.

## Non-goals

- Single-bot mode (`app/`) is out of scope. This is fleet-only, matching the fleet's own
  60-independent-accounts shape - single-bot mode has exactly one account, so "I have no idea
  what's happening across accounts" doesn't apply to it.
- No in-app reply/moderation tooling. This only notifies; taking action still happens in the
  Bluesky app itself.
- No notification history UI. The `notified_items` table exists purely to prevent duplicate
  sends, not to power a dashboard.
- No per-account ntfy topic routing. One shared topic for the whole fleet, matching the existing
  `bsky_queue_monitor.py` precedent of one `NTFY_URL` for fleet-wide alerts.

## Architecture

### Where it runs

Inside the existing fleet process, owned by `BotWorker` (`fleet/botWorker.ts`) rather than
scheduled centrally from `runFleet.ts`. `AuthCoordinator.start()` already activates bots
sequentially - a `for` loop that `await`s `activateBot(spec)` then sleeps `staggerSeconds` before
the next one - so a `setInterval` started inside `BotWorker.start()` (called at the end of each
bot's `activateBot`) is staggered across the fleet for free, the same way the existing posting-drain
interval already is. No separate stagger computation is needed. `BotWorker` already holds the
`bskyClient` reference and the exact `start()`/`stop()`/`shutdown()` lifecycle this needs, so it's
the natural owner rather than a new top-level scheduling concern in `runFleet.ts`.

It reuses each bot's already-authenticated `BskyClient` session - no new login/credential handling,
no new failure mode for the posting pipeline to worry about, since this task is purely read-only
against the Bluesky API.

### New module: `fleet/notificationWatcher.ts`

Pure orchestration logic, separate from `BotWorker` itself - matching the existing split between
`BotWorker` (owns timing/lifecycle) and `freshnessPolicy.ts` (pure decision logic `BotWorker` calls
into). One function, `checkBotNotifications(params: {botId, bskyClient, store, ntfyUrl, logger})`,
called from a second `setInterval` inside `BotWorker.start()` (independent of the existing
posting-drain interval). Responsibilities:

1. Call `bskyClient.listNotifications({reasons: ['reply', 'mention', 'quote']})` (new method on
   `BskyClient`, see below).
2. For each notification returned, in order:
   - Skip it if `store.seenValueExists(notification.uri)` is true (already sent).
   - Otherwise, build the ntfy payload (see Message format) and POST it.
   - Only if that POST succeeds, call `store.writeSeenValue(notification.uri)`.
3. Log a `debug`-level line if the ntfy POST fails (network error, non-2xx), and move on to the
   next notification - one failed send must not block the rest of the batch, and the unsent
   notification stays eligible for retry on the next poll cycle since its `uri` was never
   recorded.

This mirrors `BotWorker.drainOnce()`'s own per-item error isolation (one item's failure doesn't
abort the loop). It deliberately does *not* mirror the identity store's write-before-confirm
pattern (`2026-08-09-fleet-identity-dedup-design.md`): that store marks an item "seen" before
its downstream step is confirmed, specifically to prevent two bot configs sharing an identity
from racing to post the same story. Notifications have no such cross-bot race to guard
against - a reply to `bot-a`'s post is never relevant to `bot-b` - so there's no reason to accept
that tradeoff here. Recording only happens after the ntfy POST actually succeeds, avoiding the
failure mode observed live on 2026-09-28 (an item marked "seen" before its downstream step was
confirmed, permanently losing it when that step failed).

This uses each bot's own per-bot `state.sqlite` (the same file that already holds its session,
cursor, `seen_items`, and `queue_items`) - no involvement of the separate identity-scoped store
at `data/fleet/identities/<identifier>.sqlite`.

### `BskyClient` changes (`fleet/bskyClient.ts`)

One new method:

```typescript
async listNotifications(
  reasons: string[],
  limit = 50,
): Promise<
  | {ok: true; notifications: AppBskyNotificationListNotifications.Notification[]}
  | {ok: false; ratelimit: boolean; retryAfterSeconds: number}
> {
  try {
    const result = await this.agent.app.bsky.notification.listNotifications({reasons, limit});
    return {ok: true, notifications: result.data.notifications};
  } catch (error) {
    this.logger.debug('NOTIFY', `listNotifications failed\n${formatDebugError(error)}`, this.botId);
    return {ok: false, ...classifyPostError(error)};
  }
}
```

Matches `post()`'s existing style: never throws, returns a result the caller branches on. The
raw agent stays private to the class, consistent with the rest of `BskyClient`.

**Rate limits.** Bluesky's documented global limit is 3000 requests/5min per IP (record-creation
limits - 1,666/hour per account - don't apply here since this is a read call); at 60 bots checking
once per 5 minutes, staggered, this adds well under 60 requests/5min fleet-wide, far below that
ceiling. The one thing worth handling deliberately is a 429 (`RateLimitExceeded`) actually
happening - `classifyPostError` (despite its name, generic: it only inspects an `XRPCError`'s
status and `retry-after` header, nothing post-specific) already does exactly this and is reused
verbatim rather than duplicated. On a classified rate limit, `notificationWatcher.ts` logs at
`summary` (not `debug`, unlike other listNotifications failures - a sustained rate limit across the
fleet is worth surfacing) and skips this bot's check for the cycle; the existing 5-minute interval
is already coarser than any observed `retry-after` value, so no separate backoff timer is added.

### `BotStore` changes (`fleet/botStore.ts`)

One new table, added via the same idempotent-migration pattern as `facets_json`
(`CREATE TABLE IF NOT EXISTS` in the constructor is a no-op for already-created databases, so no
separate migration step is needed beyond what's already there):

```sql
CREATE TABLE IF NOT EXISTS notified_items (
  value TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);
```

Identical shape to the existing `seen_items` table. Reuses `writeSeenValue`/`seenValueExists`/
`cleanupOldSeenValues` verbatim by parameterizing those methods' table name (currently hardcoded
to `seen_items`) - the only change needed to the existing methods.

### Scheduling (`fleet/botWorker.ts`)

Each bot's notification check runs on its own 5-minute interval, started inside `BotWorker.start()`
at the moment that bot activates. Since `AuthCoordinator.start()` activates bots sequentially
(sleeping `staggerSeconds` between each), bot *N*'s interval naturally starts `staggerSeconds`
after bot *N-1*'s - no computed offset needed, the existing activation order does the spreading.

### Message format

```
Title: New {reply|mention|quote} on @{bot's handle}
Body: {replier's handle}: "{notification record's text, truncated to ~200 chars}"
```

Headers:
- `X-Click`: `https://bsky.app/profile/{replier's did}/post/{rkey extracted from notification.uri}`
  - the new content itself, so tapping the notification goes straight to it.
- `X-Tags`: `speech_balloon` (reply) / `loudspeaker` (mention) / `repeat` (quote) - one glance at
  the notification list tells you the type without opening it.
- `X-Actions`: a `view` action button labeled "Open original post", linking to
  `https://bsky.app/profile/{did}/post/{rkey}` derived directly from `notification.reasonSubject`'s
  own AT-URI (`at://{did}/{collection}/{rkey}`) - only added when `reasonSubject` is present (it's
  optional in the schema; present for reply/mention referencing a specific post, may be absent for
  some mention shapes). Using the DID embedded in the AT-URI itself means no separate lookup of the
  bot's handle is needed; bsky.app resolves a DID in a profile URL identically to a handle.

### Configuration

New env var, `NTFY_URL` (matching the existing `bsky_queue_monitor.py` convention), e.g.
`https://ntfy.rmendes.net/skyfleet` - a plain `POST` to this URL is all ntfy needs
(`curl -d "Hi" https://ntfy.rmendes.net/skyfleet`), enrichment headers ride alongside the same
request. Read once in `runFleet.ts`'s `main()` and threaded through `buildWorker()` into each
`BotWorker`; if unset, no bot starts a notification-check interval (fleet posting itself is
unaffected - this is purely additive, optional tooling).

## Data flow

```
Every 5 min (staggered per bot, independent of the posting-drain interval):
  BotWorker's own posting cycle  <-- unaffected, entirely separate timer
  notificationWatcher tick for this bot:
    bskyClient.listNotifications(['reply','mention','quote'])
      -> for each notification (newest-to-oldest, as returned):
           already in notified_items? -> skip
           else -> POST to ntfy
                   success? -> record uri in notified_items
                   failure? -> log, leave unrecorded (retried next tick)
```

## Error handling

- `listNotifications` itself failing (network, auth) - logged at `debug`, that bot's check is
  skipped for this cycle, retried on the next one. No different from any other transient network
  failure already tolerated elsewhere in the fleet.
- `listNotifications` classified as rate-limited (429/504, via the same `classifyPostError` logic
  `post()` already uses) - logged at `summary` (worth surfacing if it starts happening across the
  fleet), skipped for this cycle. The existing 5-minute interval already exceeds any observed
  `retry-after` value, so no separate backoff timer is needed.
- ntfy POST failing - per-notification, logged at `debug`, not recorded as sent, retried next
  cycle (see above).
- `NTFY_URL` unset - no bot starts its notification-check interval; one `summary`-level log line
  at fleet startup. Fleet posting is entirely unaffected either way.

## Testing

- `notificationWatcher.test.ts`: unit tests for the dedup logic (skip already-sent, record only
  after a successful ntfy POST, one failed send doesn't block the rest of the batch, a failed send
  is retried on the next call, a rate-limited `listNotifications` is logged and skipped without
  recording anything) using a fake `BskyClient` and fake `fetch` for ntfy, matching this codebase's
  existing fake-based unit test style (`botWorker.test.ts`'s `FakeBskyClient`/`FakeBotStore`).
- `bskyClient.test.ts`: new cases for `listNotifications`'s `{ok: true}` / `{ok: false, ratelimit}`
  branches, matching the existing `post()`/`login()` test coverage style.
- `botStore.test.ts`: confirm `notified_items` behaves identically to `seen_items` (write, read,
  cleanup) once the table-name parameterization lands.
- `botWorker.test.ts`: confirm the notification-check interval starts/stops/clears alongside the
  existing posting-drain interval, and that it's simply absent when `ntfyUrl` is undefined.

## Documentation

This is fleet operator tooling - `documentation/fleet.md`'s "Operations visibility" section
(which already documents `FLEET_LOG_LEVEL` and `yarn fleet:status` in this same style) is where
it belongs, not `CONFIGURATION.md` (that file is for per-bot template/feed config, not
fleet-level operational infrastructure):

- `documentation/fleet.md`, new subsection under "## Operations visibility": what
  `NTFY_URL` is, the 5-minute check interval, what triggers a notification (reply/mention/quote),
  and that it's optional (fleet posting works identically whether it's set or not).
- `CLAUDE.md`'s Fleet mode section: one line alongside the existing `AuthCoordinator`/
  `fleet/status.ts` bullets, naming `fleet/notificationWatcher.ts` and its purpose - matching how
  that section already introduces every other fleet module in one sentence each.

`documentation/DEPLOYMENT.md` doesn't apply - it covers single-bot-mode deployment platforms
(Railway, Render, etc.), not fleet-mode's own env vars, which live entirely in `fleet.md`.
