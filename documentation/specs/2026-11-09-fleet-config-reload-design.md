# Fleet Per-Bot Config Reload Design

**Date:** 2026-11-09

**Status:** Approved for implementation

## Purpose

Fleet mode reads every bot's configuration once, at startup (`loadFleet()` in `fleet/runFleet.ts`). Changing one bot, even just its feed URL, means restarting the whole 60-bot fleet, which re-activates every bot one by one over roughly 30 minutes.

This design lets the operator change, add, enable, disable, or remove a single bot while the fleet keeps running. It reverses the "no bot configuration reload" non-goal of `2026-08-03-fleet-operations-visibility-design.md`. That non-goal scoped the earlier work; it was not a technical constraint, and that same design already introduced the file-based control-channel pattern this one reuses.

## Goals

- A changed `bot.json`, `config.json`, or a bot's own secret is applied automatically within about 10 seconds, without touching any other bot.
- A new bot directory, or a bot switched to `enabled: true`, starts without a restart.
- A bot switched to `enabled: false`, or whose directory is removed, stops without a restart.
- `yarn fleet:reload <bot-id> | --all` forces a reload through the same path.
- A bad edit never takes a running bot down.

## Non-goals

- Reloading `fleet.json` (stagger, run interval, freshness, shared limiters, queue length) or the process environment (`DRY_RUN`, `NTFY_*`, log level). These still need a restart.
- Filesystem event watching. Polling is used instead (see Approach).
- Automatically handing a shared account's notification role to a sibling config (see Notifications).
- Changing the cursor, queue, dedup, freshness, or posting semantics.

## Approach

A polling reconciler inside the fleet process. Every 10 seconds it fingerprints each bot's configuration and compares it with what is running, then starts, stops, or restarts only the bots that differ. The reload command writes a request file that the same loop consumes, so detection and the command share one code path.

Rejected alternatives:

- **Filesystem events (`fs.watch`/inotify).** Editors save by writing a temp file and renaming it, and Docker bind mounts do not reliably deliver those events, so changes could be missed silently and polling would be needed as a backup anyway.
- **A signal (`SIGHUP`) to re-read everything.** Explicit but not automatic, and it cannot target one bot.

Polling 60 small directories every 10 seconds costs nothing measurable, and a few seconds' delay is irrelevant for feeds polled every 5 minutes.

## Components

### `fleet/botFingerprint.ts`

A pure function. Given the config root, the parsed secrets map, and a bot id, it returns either `{enabled, hash, fields}` or `{error}`.

- `hash` covers exactly what defines the bot: the raw bytes of `bot.json`, the raw bytes of `config.json`, and the bot's own secret (looked up by its `secretKey`). Rotating a bot's password is a change; editing another bot's secret is not.
- `fields` holds the parsed top-level objects, kept only to name which fields changed in log lines.
- Unreadable files or invalid JSON produce `{error}`, never an exception.

### `fleet/reloadRequests.ts`

The command's channel: `<FLEET_DATA_ROOT>/reload-requests.json`, holding a list of bot ids or `*` for all bots.

- Written atomically with mode `0600`, mirroring `fleet/logOverrides.ts`.
- Requests are consumed once the reconciler has acted on them.
- A malformed file is reported once and ignored; it never throws into the fleet.

### `fleet/configReconciler.ts`

The loop. It holds, per running bot, the fingerprint it was started with, plus the last rejected fingerprint per bot (to avoid repeating a rejection log every tick).

Each tick it:

1. Reads the secrets file. If it cannot be read or parsed, it treats every bot as unchanged, logs once, and ends the tick.
2. Lists the bot directories and fingerprints each one.
3. Consumes pending reload requests.
4. Builds a plan:
   - **start**: a directory not running whose bot is enabled.
   - **stop**: a running bot now disabled, or whose directory has been missing on **two consecutive ticks**.
   - **restart**: a running bot whose fingerprint changed, or that has a pending reload request.
5. Executes the plan one action at a time.

Starting and stopping go through injected `startBot(botId)` and `stopBot(botId)` functions, so the loop is testable without real bots. Only one tick runs at a time; if a tick is still running when the next is due, the next is skipped. The reconciler starts only after the initial staggered activation finishes, so it never competes with startup.

### `fleet/reloadControl.ts` and `yarn fleet:reload`

A CLI that writes a request, following `fleet/logControl.ts` and `yarn fleet:log`.

- `yarn fleet:reload <bot-id>` accepts any existing bot directory, including one not yet running.
- `yarn fleet:reload --all` requests every bot.
- It prints `reload requested; applied within ~10s` and exits. The outcome appears in the logs and in `yarn fleet:status`.

### Changes to existing code

- `AuthCoordinator` gains `addWorker(worker)` and `removeWorker(botId)`, so `activeWorkers()`, `shutdownAll()`, and the status snapshot see the reconciler's changes.
- `fleet/runFleet.ts` wires `startBot`/`stopBot` from the existing `loadOneBot` and `buildWorker`, keeps the per-bot `BotOperations` map in step (add on start, remove on stop), and maintains the notifier claims (see Notifications).
- `fleet/status.ts` shows each bot's "config loaded at" time and its last reload outcome.

## Behaviour

### Restarting a bot

1. **Load the new config** with `loadOneBot`, reading the secrets file fresh. If this fails, the old worker keeps running untouched, and `[CONFIG] <bot> reload rejected: <reason>` is logged once per distinct rejected fingerprint.
2. **Stop the old worker** with its existing `shutdown(timeout)`. An in-flight post finishes first. The queue, cursor, dedup history, and session remain in the bot's SQLite store.
3. **Build the new worker** with `buildWorker` on the same store. It resumes the saved session, so no password login happens unless the identifier or password changed.
4. **If the new worker fails to start**, the reconciler starts the previous spec again and logs both failures at the default level. Nothing is retried until the files change again or a reload is requested.

The old worker is always stopped before the new one starts, never in parallel: two workers on the same store and account could double-post.

The cursor is kept. After a feed URL change, items newer than the bot's last post are eligible, and the existing freshness policy still limits them to the newest `maxCatchupItems` within `maxItemAgeMinutes`, so a new feed's backlog cannot flood the account. Items in the new feed dated before the cursor are ignored, exactly as after a full restart today.

### Starting a bot

Same as a restart without the stop step. A `BotOperations` entry is created for it.

### Stopping a bot

Its worker is shut down and its `BotOperations` entry removed. Its data directory stays on disk, so re-enabling it resumes where it left off.

### Notifications

Only one config per Bluesky account polls that account's notifications (`shouldAssignNotifier`). When the config holding that role stops or restarts, the claim is released; the next config for that account that starts or restarts claims it. Until then, that account's notifications pause, and this is logged. Handing the role to a running sibling automatically would mean restarting that sibling unprompted, so it is deliberately not done.

### Shutdown

Fleet shutdown stops the reconciler first and waits for any reload in progress, then shuts down all workers as today.

## Failure rules

- **A broken secrets file never stops bots.** The tick is skipped and logged once.
- **A missing directory stops its bot only after two consecutive ticks** (about 10 to 20 seconds), so a directory that briefly disappears during `git pull`, `rsync`, or an editor save does not kill the bot.
- **Overlapping ticks are skipped**, not stacked.
- **A restarting bot's queue waits**; no post is dropped or duplicated.

## Visibility

Log lines at the default `summary` level, scope `CONFIG`:

- `<bot> reloaded: feedUrl, string changed`
- `<bot> started` / `<bot> stopped (disabled)` / `<bot> stopped (directory removed)`
- `<bot> reload rejected: invalid bot.json`
- `<bot> reload failed, previous config restored`
- `<bot> notifications paused: notifier config stopped`

Changed-field lists name top-level field names only, never values, so feed tokens and passwords never reach logs. A changed secret is logged as `secret changed`.

## Testing

Unit tests in the project's `node:test` style:

- `botFingerprint`: identical files give identical hashes; editing `bot.json`, editing `config.json`, or changing this bot's secret changes the hash; changing another bot's secret does not; invalid JSON returns an error result.
- `reloadRequests`: atomic `0600` writes; read-and-consume; `*` means all; a malformed file is reported, not thrown.
- `configReconciler`, with fake `startBot`/`stopBot` recording calls:
  - start on a new directory and on `enabled: false → true`;
  - stop on `enabled: true → false`, and on a directory missing for two ticks but not one;
  - restart on a changed fingerprint and on a forced reload with no change;
  - a rejected config keeps the old bot running and logs once;
  - a failed restart starts the previous spec again;
  - a broken secrets file stops nothing;
  - actions run one at a time and overlapping ticks are skipped;
  - shutdown waits for an in-flight reload;
  - changed-field log lines contain names, never values.
- `AuthCoordinator`: `addWorker`/`removeWorker` keep `activeWorkers()` and `shutdownAll()` correct.
- Notifier claims: released when the holder stops, claimed by the next sibling that starts.

One integration test with a real `BotWorker`: rebuild a bot on the same SQLite store (session already present, `BskyClient` stubbed) and check that queued items, cursor, and dedup history survive the swap.

Production check after deploy: edit `skyfleet-en`'s `bot.json` and confirm `skyfleet-en reloaded: feedUrl changed` appears within about 10 seconds while the other bots continue untouched.
