# Fleet Operations Visibility Design

**Date:** 2026-08-03

**Status:** Approved for implementation

## Purpose

The 59-bot production fleet is stable and productive. In the retained production log window, 867 of 868 terminal post outcomes succeeded. Most feed errors came from one upstream feed returning HTTP 500 on every poll, while Open Graph failures used the existing RSS fallback and did not prevent posting.

The operational problem is visibility: current logs make recoverable fallbacks look like fleet failures, repeat persistent errors on every poll, and do not expose the success denominators needed to judge fleet performance.

This design adds clear summaries, an on-demand CLI, and temporary per-bot verbose/debug logging. It does not redesign fleet execution.

## Goals

- Show whether the fleet is running and making useful progress.
- Distinguish feed failures, Open Graph fallbacks, policy skips, and post failures.
- Report exact process-lifetime counts and percentages.
- Make one persistently failing feed visible without flooding logs.
- Allow temporary verbose/debug logging for one bot without restarting the fleet.
- Preserve all current queue, persistence, scheduling, authentication, posting, and fallback behavior.

## Non-goals

- No dashboard, HTTP endpoint, public API, metrics service, or event database.
- No persistent analytics or cross-restart counters.
- No bot configuration reload or process control.
- No change to production, the fleet template, or deployment procedures in this work.
- No changes to feed, queue, post, retry, freshness, or SQLite semantics.

The future public/admin dashboard is explicitly out of scope. The status snapshot is an internal interface for the matching runtime and CLI release, not a promised dashboard API.

## Architecture

Observability stays inside the existing fleet process.

- `FeedReader` records poll and Open Graph outcomes.
- `BotWorker` records queue and post outcomes.
- `runFleet.ts` aggregates worker state before, during, and after sequential activation.
- The process writes one status snapshot under `FLEET_DATA_ROOT` every minute.
- A read-only status CLI renders aggregate output and optional per-bot details.
- A separate control CLI writes temporary per-bot log-level overrides under `FLEET_DATA_ROOT`.
- The running process notices override changes within a few seconds.

There is no new package, port, service, background process, or database table.

## Runtime facts

### Bot feed state

Each configured bot has one of three feed states:

- `starting`: no poll has completed.
- `ok`: the latest poll succeeded, including a successful poll with zero new items.
- `failing`: the latest poll failed.

FeedSub already emits `items` after every successful poll, even when the array is empty. That event supplies the success signal; no second poller is introduced.

A failing bot does not make the fleet globally unhealthy. Aggregate output reports how many bots are starting, okay, or failing.

### Counters

Counters begin at process start and reset on restart.

- Feed polls: successful and failed.
- Open Graph: attempted, successful, and fallback used.
- Queue: newly queued, current depth, and policy-skipped.
- Posting: successful, uncertain, deferred, and exception. Deferred includes
  both actual rate limits and safe pre-record image-upload failures, with a
  distinct reason so the latter is never reported as rate limiting.
- Activation: configured, active, failed, and invalid configuration.

Per-bot state also records the last successful poll, last failed poll, consecutive feed failures, last successful post, current queue depth, and effective log level.

Feed errors use small operational categories: `http-<status>`, `timeout`, `dns`, `tls`, `connection`, `parse`, or `other`.

## Status snapshot

The process writes `<FLEET_DATA_ROOT>/status.json` every minute.

- Write a complete temporary file, set mode `0600`, then atomically rename it.
- Include process start time and heartbeat time.
- Include aggregate facts plus administrator-facing per-bot facts.
- Exclude feed URLs, account handles, titles, post content, credentials, sessions, and raw errors.
- Mark the snapshot `stopping` before graceful worker shutdown.

A snapshot-write failure logs one operational warning and never stops or blocks a bot. After an unexpected exit, the final complete snapshot remains but becomes stale because its heartbeat stops advancing. Staleness applies to every phase, including `stopping`; stale output preserves the last reported phase, and stale or final `stopping` uptime is capped at `heartbeatAt` rather than growing with CLI wall time.

## Status CLI

The default CLI output is aggregate-only:

```text
Fleet running 4d 3h · heartbeat 18s ago
Bots       59 active · 58 feeds ok · 1 feed failing
Feed polls 10,630 / 10,818 successful (98.26%)
OpenGraph  737 / 990 successful (74.44%) · 253 RSS fallbacks
Posts      867 / 868 terminal outcomes successful (99.88%) · 1 uncertain
Queue      14 waiting · 111 policy-skipped
Memory     241 MB RSS
```

The CLI handles missing, malformed, current, stale, current-`stopping`, and stale-`stopping` snapshots explicitly. Zero denominators render as unavailable rather than `NaN`.

`--bots` adds one row per bot containing only:

- bot ID;
- feed state and last successful poll;
- consecutive failures and safe error category;
- last successful post;
- queue depth and process-lifetime counters; and
- effective log level and override expiry.

Activation state and the last-failure timestamp remain internal snapshot facts; they are not part of the exact `--bots` output allowlist.

## Log levels

`FLEET_LOG_LEVEL` sets the fleet-wide startup default. Accepted values are `summary`, `verbose`, and `debug`. The default is `summary`; an invalid value fails startup through the generic safe startup-failure summary without echoing the supplied value or a raw stack.

### `summary`

- Startup, activation, configuration failures, shutdown, and process exceptions.
- First feed-unavailable transition and subsequent recovery.
- Rate-limit, upload-failure deferral, uncertain-post, and unexpected posting events.
- One aggregate interval summary every five minutes.
- No per-item queue, post, duplicate, or Open Graph lines.
- No separate one-minute memory lines; memory is part of the summary.

Example:

```text
[FLEET] 5m: feeds 1059/1062 ok · OG 80/114 ok, 34 fallbacks · posts 95/95 ok · 10 policy-skipped · queue 14 · 1 feed failing · RSS 241MB
```

The first failed poll logs `Feed unavailable: <bot-id> (<category>)`. Repeated failures increment counters silently. The next successful poll logs `Feed recovered: <bot-id> after <count> failed polls`.

### `verbose`

Includes `summary` plus each queued, duplicate, policy-skipped, successfully posted, and Open Graph fallback event. It provides operational context comparable to today's logs.

### `debug`

Includes `verbose` plus sanitized external error details and stack traces, transient durations, and shared-limiter wait/acquire/release activity needed for diagnosis. Debug output may contain private feed URLs, titles, and post text, so startup or override activation prints a privacy warning.

Credential-bearing URL userinfo, Authorization/Bearer material, and secret-like password, app-password, token, access, refresh, session, and secret values are redacted from debug messages and stacks. Credentials, sessions, tokens, app passwords, arbitrary error properties, and complete configuration objects are never passed through as logger data at any level.

## Temporary per-bot log overrides

Changing the global environment requires a restart and a long full-fleet re-authentication cycle. Per-bot overrides therefore use a small file-based control channel.

The control CLI atomically writes `<FLEET_DATA_ROOT>/log-overrides.json` with mode `0600`. The fleet checks it every few seconds. A temporary override changes only the selected bot; the other bots keep the global level.

Example commands inside the running container:

```bash
node --import tsx fleet/logControl.ts set <bot-id> debug --for 15m
node --import tsx fleet/logControl.ts set <bot-id> verbose --for 30m
node --import tsx fleet/logControl.ts list
node --import tsx fleet/logControl.ts clear <bot-id>
```

Rules:

- `set` requires a positive duration so elevated logging cannot be forgotten indefinitely.
- Unknown bot IDs, invalid levels, and invalid durations make no change.
- Every entry's structure, level, and timestamp is validated first. Expired entries are then pruned before bot authority is checked, so an expired override for a removed bot is discarded while an active unknown-bot entry invalidates the whole document.
- `list`, `set`, and `clear` each read the override document once and use the current `status.json` bot IDs as authority; document keys never authorize themselves.
- Expired overrides automatically fall back to `FLEET_LOG_LEVEL`.
- Enable, expire, and clear actions produce one administrative log line.
- A malformed manual edit is ignored with one warning; the last valid in-memory state remains until it expires or a valid file replaces it.
- Operational filesystem failures such as permission errors or a directory at the file path are not labeled malformed; they reach the runtime's safe observer warning and sanitized debug detail.
- An active unknown-bot entry requires manual removal/correction, or waiting until that structurally valid entry expires. Until then the all-or-nothing document remains invalid and the watcher retains its last valid in-memory state.
- The control channel changes logging only. It cannot reload configuration, start or stop bots, or change publishing behavior.

## Lifecycle and failure isolation

Status timers start before `AuthCoordinator.start()` completes so the CLI remains useful throughout the long staggered activation period.

Every minute, the process writes current state. Every five minutes, it logs deltas since the previous successfully emitted summary rather than misleading lifetime totals. Queue/memory observation and summary-sink failures are isolated, emit a safe warning plus sanitized debug detail where possible, and do not advance the counter baseline, so the next successful summary retains the whole interval.

Observability code must not write queue rows, cursors, sessions, or bot configuration. It must not influence feed polling, scheduling, freshness selection, posting, retry decisions, or shutdown ordering.

## Testing

All behavior changes use focused tests before implementation.

### Feed and counter tests

- Successful poll with items and successful poll with zero items.
- First failure, repeated failure suppression, and recovery.
- Safe feed-error classification.
- Exact feed, Open Graph, queue, skip, and posting counters.
- Confirmed-success and uncertain post counters are recorded before fallible local queue mutations, so known external outcomes remain exact even if SQLite mutation fails.
- Open Graph fallback still produces the same post input.
- Image-upload failure keeps the row queued, stops draining, and defers for 30 seconds without claiming a rate limit; real 429/504 handling is unchanged.
- Interval summaries use deltas, handle zero attempts, retain deltas after observation/emission failure, and advance their baseline only after successful emission.

### Logging tests

- `summary`, `verbose`, and `debug` include exactly their intended messages.
- Summary output excludes URLs, titles, content, and raw errors.
- Embedded credentials are redacted from both error messages and stacks, and every runtime error sink is audited rather than relying only on object-property filtering.
- Caught session-resume, image-upload, classified create-record, Open Graph, and image-download failures emit sanitized debug detail and duration.
- Shared limiter contention emits wait/acquire/release diagnostics through the existing limiter path.
- One debug bot does not increase caught-error, timing, or limiter logging for the other 58 synthetic bots.

### Snapshot and CLI tests

- Atomic replacement and mode `0600`.
- Missing, malformed, current, stale, current-`stopping`, and stale-`stopping` snapshots, including stable final uptime.
- Aggregate default output and the exact privacy-limited `--bots` allowlist.
- Accurate 59-bot startup counts using injected time rather than a real stagger delay.
- Shutdown during authentication staggering does not emit `Fleet started` after shutdown has begun.

### Override tests

- Set, detect, expire, list, and clear without restart.
- Only the selected bot changes level.
- Expired unknown bots prune before authority validation, while active unknown bots invalidate the document without mutation.
- `list` uses status-backed authority and one coherent override read.
- Malformed and partial files do not affect publishing or replace valid in-memory state; operational filesystem errors remain distinct.
- Injected time tests expiry without real waiting.

### Regression acceptance

- All existing 129 fleet tests continue passing.
- Queue, cursor, SQLite, authentication staggering, scheduling, deduplication, posting, fallback, and shutdown behavior remain unchanged.
- No real Bluesky authentication or publishing occurs.
- No dashboard, HTTP endpoint, persistent metrics store, or production deployment is introduced.

The existing TypeScript 6 configuration errors remain separately visible; this work does not hide them or expand into an unrelated compiler migration.

## Delivery boundary

Implementation belongs in focused, reviewed commits in `bsky.rss`. Production and fleet-template adoption are separate follow-up decisions after local tests and review. No implementation step authorizes changing the running fleet.
