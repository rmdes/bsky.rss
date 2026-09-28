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

Inside the existing fleet process (`fleet/runFleet.ts`), as a new periodic task alongside the
already-existing hourly identity-store cleanup interval. It reuses each bot's already-authenticated
`BskyClient` session - no new login/credential handling, no new failure mode for the posting
pipeline to worry about, since this task is purely read-only against the Bluesky API.

### New module: `fleet/mentionWatcher.ts`

One function, `checkBotNotifications(botId, bskyClient, store, ntfyUrl, logger)`, called on a
per-bot timer. Responsibilities:

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
  | {ok: false}
> {
  try {
    const result = await this.agent.app.bsky.notification.listNotifications({reasons, limit});
    return {ok: true, notifications: result.data.notifications};
  } catch (error) {
    this.logger.debug('NOTIFY', `listNotifications failed\n${formatDebugError(error)}`, this.botId);
    return {ok: false};
  }
}
```

Matches `post()`'s existing style: never throws, returns a result the caller branches on. The
raw agent stays private to the class, consistent with the rest of `BskyClient`.

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

### Scheduling (`fleet/runFleet.ts`)

Each bot's notification check runs on its own 5-minute interval, staggered across that 5-minute
window the same way `AuthCoordinator` staggers logins - bot *N* (0-indexed) of 60 starts its
first check at `(N / 60) * 300` seconds after fleet startup, then repeats every 300 seconds. This
spreads 60 accounts' worth of `listNotifications` calls evenly instead of firing them all in the
same instant every 5 minutes.

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
  `https://bsky.app/profile/{bot's handle}/post/{rkey extracted from notification.reasonSubject}`
  - only added when `reasonSubject` is present (it's optional in the schema; present for
  reply/mention referencing a specific post, may be absent for some mention shapes).

### Configuration

New env var, `NTFY_URL` (matching the existing `bsky_queue_monitor.py` convention), e.g.
`https://ntfy.rmendes.net/skyfleet` - a plain `POST` to this URL is all ntfy needs
(`curl -d "Hi" https://ntfy.rmendes.net/skyfleet`), enrichment headers ride alongside the same
request. Read once at fleet startup; if unset, the notification watcher logs a summary line and
does not start (fleet posting itself is unaffected - this is purely additive, optional tooling).

## Data flow

```
Every 5 min (staggered per bot):
  BotWorker's own posting cycle  <-- unaffected, entirely separate timer
  mentionWatcher tick for this bot:
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
- ntfy POST failing - per-notification, logged at `debug`, not recorded as sent, retried next
  cycle (see above).
- `NTFY_URL` unset - watcher doesn't start at all, one `summary`-level log line at fleet startup.
  Fleet posting is entirely unaffected either way.

## Testing

- `mentionWatcher.test.ts`: unit tests for the dedup logic (skip already-sent, record only after
  a successful ntfy POST, one failed send doesn't block the rest of the batch, a failed send is
  retried on the next call) using a fake `BskyClient` and fake `fetch` for ntfy, matching this
  codebase's existing fake-based unit test style (`botWorker.test.ts`'s `FakeBskyClient`/
  `FakeBotStore`).
- `bskyClient.test.ts`: a couple of new cases for `listNotifications`'s `{ok: true/false}`
  branches, matching the existing `post()`/`login()` test coverage style.
- `botStore.test.ts`: confirm `notified_items` behaves identically to `seen_items` (write, read,
  cleanup) once the table-name parameterization lands.

## Documentation

This is fleet operator tooling - `documentation/fleet.md`'s "Operations visibility" section
(which already documents `FLEET_LOG_LEVEL` and `yarn fleet:status` in this same style) is where
it belongs, not `CONFIGURATION.md` (that file is for per-bot template/feed config, not
fleet-level operational infrastructure):

- `documentation/fleet.md`, new subsection under "## Operations visibility": what
  `NTFY_URL` is, the 5-minute check interval, what triggers a notification (reply/mention/quote),
  and that it's optional (fleet posting works identically whether it's set or not).
- `CLAUDE.md`'s Fleet mode section: one line alongside the existing `AuthCoordinator`/
  `fleet/status.ts` bullets, naming `fleet/mentionWatcher.ts` and its purpose - matching how that
  section already introduces every other fleet module in one sentence each.

`documentation/DEPLOYMENT.md` doesn't apply - it covers single-bot-mode deployment platforms
(Railway, Render, etc.), not fleet-mode's own env vars, which live entirely in `fleet.md`.
