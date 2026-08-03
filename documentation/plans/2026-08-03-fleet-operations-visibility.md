# Fleet Operations Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task by task with review checkpoints.

**Goal:** Add truthful fleet summaries, a local status CLI, and temporary per-bot verbose/debug logging without changing feed, queue, post, authentication, or deployment behavior.

**Architecture:** Keep observability in the existing fleet process. One shared `BotOperations` object per valid configured bot receives events from `FeedReader` and `BotWorker`; pure aggregation functions turn those facts into interval summaries and a private atomic status snapshot. A shared logger applies the global level plus validated, expiring per-bot overrides loaded from one private JSON control file.

**Tech Stack:** TypeScript, Node.js 24 (`node:test`, `node:fs`), the existing `tsx` runtime, and the existing fleet classes. No new dependency, service, port, database table, or production/template change.

## Global Constraints

- Work only in `bsky.rss`; do not edit `/home/skyfleet-next`, the running container, or `bsky-rss-fleet-template`.
- Preserve current polling, deduplication, cursor, SQLite, freshness, queue, rate-limit, posting, authentication-stagger, and shutdown decisions exactly.
- Do not add an HTTP endpoint, dashboard, metrics database, schema framework, config reload, bot lifecycle control, or cross-restart counters.
- `status.json` and `log-overrides.json` live directly under `FLEET_DATA_ROOT`, are written atomically, and have mode `0600`.
- Status data never contains feed URLs, identifiers/handles, titles, post content, credentials, sessions, tokens, app passwords, or raw errors.
- Summary logs never contain URLs, titles, post content, or raw errors. Debug may contain operational URLs/titles/content, but all debug errors are sanitized and code must never pass credentials, sessions, tokens, app passwords, arbitrary error properties, or complete config objects to the logger. Privacy acceptance audits every runtime sink with literal embedded secrets in messages and stacks.
- Use injected clocks/sinks in tests. Do not wait for real five-minute intervals, one-minute heartbeats, five-second override polls, or the 59-bot authentication stagger.
- The current baseline is 129 passing fleet tests. Standard `yarn typecheck` stops on TypeScript 6 deprecations (`baseUrl`, `moduleResolution=node`). With `--ignoreDeprecations 6.0`, two unrelated baseline errors remain: `fleet/botStore.ts:135` (TS2352) and `fleet/botWorker.test.ts:254` (TS7006). Do not hide or fix these in this feature.
- After every implementation task, run its focused tests and `git diff --check`, then commit only the named paths.

---

## Task 1: Add the shared log-level contract

**Files:**

- Create: `fleet/logging.ts`
- Create: `fleet/logging.test.ts`

### Step 1: Write the failing level/filter/privacy-boundary tests

Cover all of these cases:

- `parseFleetLogLevel(undefined)` returns `summary`.
- `summary`, `verbose`, and `debug` parse; any other value throws an error listing the accepted values.
- A summary-default logger emits only summary calls.
- A verbose-default logger emits summary and verbose, but not debug.
- A debug-default logger emits all three.
- A temporary debug override changes only its bot; a second bot stays at the global level.
- An expired override is ignored using the injected clock.
- `formatDebugError` emits only a sanitized error name, message, and stack; it does not serialize arbitrary properties such as `config`, `headers`, `session`, or `password`. Credential-bearing URL userinfo, Authorization/Bearer material, and secret-like password/app-password/token/access/refresh/session/secret values are redacted from both message and stack.

Use this public contract:

```ts
export type FleetLogLevel = "summary" | "verbose" | "debug";

export interface FleetLogOverride {
  level: FleetLogLevel;
  expiresAt: string;
}

export interface FleetLogRecord {
  level: FleetLogLevel;
  scope: string;
  botId?: string;
  message: string;
}

export class FleetLogger {
  constructor(options: {
    defaultLevel: FleetLogLevel;
    now?: () => Date;
    sink?: (line: string, record: FleetLogRecord) => void;
  });
  replaceOverrides(overrides: ReadonlyMap<string, FleetLogOverride>): void;
  effectiveLevel(botId?: string): FleetLogLevel;
  overrideFor(botId: string): FleetLogOverride | undefined;
  summary(scope: string, message: string, botId?: string): void;
  verbose(scope: string, message: string, botId?: string): void;
  debug(scope: string, message: string, botId?: string): void;
}

export function parseFleetLogLevel(value: string | undefined): FleetLogLevel;
export function formatDebugError(error: unknown): string;
```

The default sink must retain the current recognizable prefix:

```text
[<UTC date>] - [bsky.rss <SCOPE>] [<optional bot id>] <message>
```

### Step 2: Run the test and confirm RED

```bash
TMPDIR=/tmp node node_modules/tsx/dist/cli.mjs --test fleet/logging.test.ts
```

Expected: failure because `fleet/logging.ts` does not exist.

### Step 3: Implement the smallest logger

Use numeric ranks internally (`summary=0`, `verbose=1`, `debug=2`). A record is emitted when its rank is less than or equal to the bot's effective rank. Global records (no `botId`) always use the fleet-wide default. `replaceOverrides` replaces the whole validated active map; it does not read files or log administrative actions.

`formatDebugError` may read `name`, `message`, and `stack` from an `Error`, but must sanitize every returned string. For a non-`Error`, sanitize and return its primitive string form only; never `JSON.stringify` arbitrary objects.

### Step 4: Run GREEN and commit

```bash
TMPDIR=/tmp node node_modules/tsx/dist/cli.mjs --test fleet/logging.test.ts
git diff --check
git add fleet/logging.ts fleet/logging.test.ts
git commit -m "feat(fleet): add scoped log levels"
```

---

## Task 2: Record exact per-bot operational facts

**Files:**

- Create: `fleet/botOperations.ts`
- Create: `fleet/botOperations.test.ts`

### Step 1: Write failing counter/state tests

Use these types and methods:

```ts
export type FeedState = "starting" | "ok" | "failing";
export type FeedFailureCategory =
  | `http-${number}`
  | "timeout"
  | "dns"
  | "tls"
  | "connection"
  | "parse"
  | "other";

export interface BotCounters {
  feedPollSucceeded: number;
  feedPollFailed: number;
  openGraphAttempted: number;
  openGraphSucceeded: number;
  openGraphFallback: number;
  queued: number;
  policySkipped: number;
  postSucceeded: number;
  postUncertain: number;
  postDeferred: number;
  postException: number;
}

export interface BotOperationalSnapshot {
  botId: string;
  feedState: FeedState;
  lastFeedSuccessAt: string | null;
  lastFeedFailureAt: string | null;
  consecutiveFeedFailures: number;
  lastFeedFailureCategory: FeedFailureCategory | null;
  lastPostSuccessAt: string | null;
  counters: BotCounters;
}

export class BotOperations {
  constructor(botId: string, now?: () => Date);
  recordFeedSuccess(): {recoveredFailures: number};
  recordFeedFailure(category: FeedFailureCategory): {
    becameFailing: boolean;
    consecutiveFailures: number;
  };
  recordOpenGraphSuccess(): void;
  recordOpenGraphFallback(): void;
  recordQueued(): void;
  recordPolicySkip(): void;
  recordPostSuccess(): void;
  recordPostUncertain(): void;
  recordPostDeferred(): void;
  recordPostException(): void;
  snapshot(): BotOperationalSnapshot;
}

export function emptyBotCounters(): BotCounters;
export function classifyFeedFailure(error: unknown): FeedFailureCategory;
```

Assert exact counter values after a mixed event sequence. Assert that:

- an Open Graph success increments both `attempted` and `succeeded`;
- an Open Graph fallback increments both `attempted` and `fallback`;
- the first and repeated feed failures return different transition facts;
- a successful poll after three failures reports `recoveredFailures: 3`, resets the consecutive count, and sets `ok`;
- a successful zero-item poll is indistinguishable from any other feed success;
- `lastPostSuccessAt` changes only on confirmed post success;
- snapshots are defensive copies.

Test safe classification from `status`, `statusCode`, common Node error codes/messages, XML/parser errors, and an unknown object. The classifier stores only the category, never the original error or URL.

### Step 2: Run RED

```bash
TMPDIR=/tmp node node_modules/tsx/dist/cli.mjs --test fleet/botOperations.test.ts
```

### Step 3: Implement the in-memory state holder

Keep it synchronous and dependency-free. Do not add persistence or an event emitter. `recordOpenGraphSuccess` and `recordOpenGraphFallback` own the attempted-counter increment so callers cannot forget the denominator.

### Step 4: Run GREEN and commit

```bash
TMPDIR=/tmp node node_modules/tsx/dist/cli.mjs --test fleet/botOperations.test.ts
git diff --check
git add fleet/botOperations.ts fleet/botOperations.test.ts
git commit -m "feat(fleet): track operational outcomes"
```

---

## Task 3: Instrument feed polling and Open Graph fallback

**Files:**

- Modify: `fleet/feedReader.ts`
- Modify: `fleet/feedReader.test.ts`
- Modify: `fleet/benchmarkHarness.ts`

### Step 1: Add failing FeedReader behavior tests

Add a required final constructor argument:

```ts
export interface FeedReaderRuntime {
  operations: BotOperations;
  logger: FleetLogger;
  fetchOpenGraph?: (url: string, userAgent: string, timeoutMs: number) => Promise<unknown>;
}
```

Production uses the existing `open-graph-scraper` call when `fetchOpenGraph` is absent. Tests inject a resolved/rejected function without network access.

Add tests that reach the existing underlying EventEmitter, with an injected clock and captured log records:

- emitting `items` with a non-empty array records one successful poll;
- emitting `items` with `[]` also records one successful poll;
- first `error` records a failure and one summary `Feed unavailable` line with only bot ID and category;
- a repeated `error` increments the count but does not add another summary line;
- `items` after failures records recovery and logs the exact failed-poll count;
- successful OG fetch records success;
- rejected OG fetch records fallback, returns the same `ParsedItem.embed` fallback fields as today, emits no summary line, emits title/URL context only at verbose, and emits formatted error detail only at debug;
- caught image-download failures emit sanitized per-bot debug detail, and OG/image work emits transient debug durations;
- shared OG/image limiter wait/acquire/release or contention detail is visible only for the selected debug bot even when another bot uses the same limiter/logger;
- summary capture does not contain the test URL, title, or raw error text.

### Step 2: Run RED

```bash
TMPDIR=/tmp node node_modules/tsx/dist/cli.mjs --test fleet/feedReader.test.ts
```

### Step 3: Wire the existing signals without changing decisions

- Attach the `items` listener before `read()`/`start()`; it is the only feed-success signal.
- In the `error` listener, call `classifyFeedFailure`, update operations, log only on the failing transition, and use `logger.debug` for `formatDebugError(err)`.
- Preserve the existing per-item rejection isolation, but make its summary message generic and place details at debug.
- Preserve the dedup checks before the OG request.
- Preserve the exact RSS-derived fallback embed construction.
- Replace the swallowed OG rejection with a small result carrying the original error only long enough to write a debug line; never place it in operations or the status snapshot.
- Route OG and image calls through the existing shared limiter with a per-call bot/logger debug context; do not create per-bot limiters or persistent timing state.
- Log sanitized caught image-download errors and transient OG/image durations at debug.
- Use verbose for missing-date, duplicate/freshness, and fallback item context.

Update all `new FeedReader(...)` calls in the benchmark harness and tests to supply a `BotOperations` and `FleetLogger`. The benchmark logger should use a no-op sink so benchmark output stays focused.

### Step 4: Run focused and existing feed tests, then commit

```bash
TMPDIR=/tmp node node_modules/tsx/dist/cli.mjs --test fleet/feedReader.test.ts fleet/sharedLimiters.test.ts
git diff --check
git add fleet/feedReader.ts fleet/feedReader.test.ts fleet/benchmarkHarness.ts
git commit -m "feat(fleet): distinguish feed failures from fallbacks"
```

---

## Task 4: Instrument queue/post outcomes and route runtime logs

**Files:**

- Modify: `fleet/botWorker.ts`
- Modify: `fleet/botWorker.test.ts`
- Modify: `fleet/bskyClient.ts`
- Modify: `fleet/bskyClient.test.ts`
- Modify: `fleet/authCoordinator.ts`
- Modify: `fleet/authCoordinator.test.ts`
- Modify: `fleet/processSafety.ts`
- Modify: `fleet/processSafety.test.ts`
- Modify: `fleet/benchmarkHarness.ts`
- Modify: `fleet/verifyDuplicateDetection.ts`

### Step 1: Add failing outcome and level tests

Extend `BotWorkerOptions` with required `operations: BotOperations` and `logger: FleetLogger`, and expose:

```ts
readonly botId: string;
operationalSnapshot(): BotOperationalSnapshot;
```

Update the worker test factory to return its operations and captured records. Assert:

- a successful new enqueue increments `queued`; duplicate and capacity-drop paths do not;
- both freshness skip paths increment `policySkipped` once per row;
- confirmed success, uncertain skip, rate-limit defer, and thrown post exception increment their own counters exactly once;
- confirmed success and uncertain outcomes remain counted when the following local SQLite status mutation throws;
- image-upload failure returns a distinct `upload-failure` pre-record deferral, leaves the row queued, stops draining, and sets the existing 30-second scheduler deadline without claiming rate limiting; actual 429/504 behavior remains unchanged;
- rate-limit and thrown-exception rows remain queued, while uncertain rows remain skipped, exactly as before;
- queue/title/content lines appear at verbose but not summary;
- uncertain, rate-limit, and unexpected-post summaries contain no item content or raw error;
- debug contains sanitized thrown error detail for only that bot.
- caught session-resume, image-upload, and classified create-record failures plus external-call durations are emitted only for the selected debug bot.

Change `BskyClient` to require a `FleetLogger`. Test that login and dry-run/current post messages follow the levels without including account handles at summary. Keep `classifyPostError` and record creation unchanged; add only the distinct pre-record upload-failure deferral reason. `BotWorker`, not `BskyClient`, owns outcome counters.

Add `logger: FleetLogger` to `AuthCoordinatorOptions`. Assert successful/failed activation uses summary, sanitized activation details use debug, and failure storage still retains the existing string for internal status counts.

Change `installProcessSafetyNet` to require the logger. Its summary record names the process exception class only; debug records `formatDebugError`. Keep the one-install guard and non-exiting behavior.

### Step 2: Run RED

```bash
TMPDIR=/tmp node node_modules/tsx/dist/cli.mjs --test fleet/botWorker.test.ts fleet/bskyClient.test.ts fleet/authCoordinator.test.ts fleet/processSafety.test.ts
```

### Step 3: Implement logging/counter calls at existing branch points

Do not move branches or change status mutations. Record interpreted external success/uncertain outcomes immediately before their fallible local queue-status mutation; keep scheduler, cursor, retry, and drain decisions in their existing order. Replace direct runtime `console.log` calls in the named files with the shared logger. Do not change standalone diagnostic CLI output beyond supplying a debug logger where constructors now require one.

### Step 4: Run GREEN and commit

```bash
TMPDIR=/tmp node node_modules/tsx/dist/cli.mjs --test fleet/botWorker.test.ts fleet/bskyClient.test.ts fleet/authCoordinator.test.ts fleet/processSafety.test.ts fleet/freshnessPolicy.test.ts fleet/scheduler.test.ts
git diff --check
git add fleet/botWorker.ts fleet/botWorker.test.ts fleet/bskyClient.ts fleet/bskyClient.test.ts fleet/authCoordinator.ts fleet/authCoordinator.test.ts fleet/processSafety.ts fleet/processSafety.test.ts fleet/benchmarkHarness.ts fleet/verifyDuplicateDetection.ts
git commit -m "feat(fleet): count and level queue and post logs"
```

---

## Task 5: Write and render the private status snapshot

**Files:**

- Create: `fleet/atomicJson.ts`
- Create: `fleet/atomicJson.test.ts`
- Create: `fleet/statusSnapshot.ts`
- Create: `fleet/statusSnapshot.test.ts`
- Create: `fleet/status.ts`
- Create: `fleet/status.test.ts`

### Step 1: Test the atomic private writer

Public contract:

```ts
export function writePrivateJsonAtomic(path: string, value: unknown): void;
```

The function creates the parent directory, writes a complete sibling temp file with a PID/random suffix, `chmod`s it to `0600`, and renames it over the destination. On error it attempts to unlink only its own resolved temp path and rethrows. Test replacement content, final mode `0600`, no leftover temp file, and a write failure that does not damage an existing destination.

### Step 2: Define and test snapshot aggregation

Use this status shape:

```ts
export type FleetPhase = "starting" | "running" | "stopping";
export type ActivationState = "pending" | "active" | "failed";

export interface FleetBotStatus extends BotOperationalSnapshot {
  activationState: ActivationState;
  queueDepth: number | null;
  effectiveLogLevel: FleetLogLevel;
  logOverrideExpiresAt: string | null;
}

export interface FleetStatusSnapshot {
  schemaVersion: 1;
  phase: FleetPhase;
  startedAt: string;
  heartbeatAt: string;
  bots: {
    configured: number;
    active: number;
    activationFailed: number;
    configInvalid: number;
    feedsStarting: number;
    feedsOk: number;
    feedsFailing: number;
  };
  totals: BotCounters & {queueDepth: number};
  memory: {rssBytes: number; heapUsedBytes: number};
  botStates: FleetBotStatus[];
}
```

Create a pure `buildFleetStatusSnapshot(...)` receiving the phase, start/current time, all valid-bot `BotOperations`, active workers by bot ID, activation-failure IDs, config-error count, logger, and memory usage. It must:

- count `configured` as valid enabled bots (`operations.size`); disabled bots remain excluded;
- count config-invalid directories separately;
- set inactive queue depth to `null` and sum exact queue depth only from active workers;
- sort `botStates` by bot ID for deterministic CLI/test output;
- aggregate counters from defensive snapshots;
- expose only safe categories and timestamps, never activation error strings.

The 59-bot test constructs 59 operations objects and marks a subset active/failed without starting a coordinator or waiting. Assert exact pending/active/failed and feed-state counts.

### Step 3: Test the status CLI formatter and loader

Export pure functions from `fleet/status.ts`:

```ts
export function readFleetStatus(path: string): FleetStatusSnapshot;
export function formatFleetStatus(
  snapshot: FleetStatusSnapshot,
  options: {showBots: boolean; now?: Date}
): string;
export function statusPath(dataRoot: string): string;
```

The executable entry point reads `FLEET_DATA_ROOT ?? "./data/fleet"` and accepts only optional `--bots`; unknown flags exit non-zero with usage.

Tests cover missing, malformed, wrong `schemaVersion`, current, stale, current-stopping, and stale-stopping files. A heartbeat older than 150 seconds is stale for every phase; stale output preserves the last phase, and stale/final stopping uptime is capped at `heartbeatAt`. Zero denominators print `n/a`, never `NaN` or `Infinity`. The default format contains no bot rows. `--bots` rows exactly match the approved allowlist and exclude activation state and last-failure timestamp. Posts use `successful / (successful + uncertain) terminal outcomes`; deferred and exception counts are separate because those rows remain queued.

### Step 4: Run RED, implement, run GREEN, and commit

```bash
TMPDIR=/tmp node node_modules/tsx/dist/cli.mjs --test fleet/atomicJson.test.ts fleet/statusSnapshot.test.ts fleet/status.test.ts
```

Implement only the contracts above, then:

```bash
TMPDIR=/tmp node node_modules/tsx/dist/cli.mjs --test fleet/atomicJson.test.ts fleet/statusSnapshot.test.ts fleet/status.test.ts
git diff --check
git add fleet/atomicJson.ts fleet/atomicJson.test.ts fleet/statusSnapshot.ts fleet/statusSnapshot.test.ts fleet/status.ts fleet/status.test.ts
git commit -m "feat(fleet): expose private status snapshots"
```

---

## Task 6: Add expiring per-bot log override control

**Files:**

- Create: `fleet/logOverrides.ts`
- Create: `fleet/logOverrides.test.ts`
- Create: `fleet/logControl.ts`
- Create: `fleet/logControl.test.ts`

### Step 1: Test strict all-or-nothing override loading

Use this contract:

```ts
export type LogOverrideDocument = Record<string, FleetLogOverride>;

export function overridesPath(dataRoot: string): string;
export function parseDuration(value: string): number;
export function readValidOverrides(
  path: string,
  knownBotIds: ReadonlySet<string>,
  now: Date
): ReadonlyMap<string, FleetLogOverride>;
export function writeOverrides(path: string, overrides: ReadonlyMap<string, FleetLogOverride>): void;

export class LogOverrideWatcher {
  constructor(options: {
    path: string;
    knownBotIds: ReadonlySet<string>;
    logger: FleetLogger;
    now?: () => Date;
  });
  poll(): void;
}
```

Test duration suffixes `s`, `m`, and `h`; reject zero, negative, fractional, missing-unit, overflow, and unknown-unit values. Validate every entry's structure, level, and timestamp first, then prune expired entries, then validate active entries against authoritative bot IDs. A structurally valid expired entry for a removed bot is discarded; an invalid expired entry or any active unknown-bot entry rejects the entire replacement.

Watcher tests must prove:

- valid set is detected on the next `poll()` without touching worker/config state;
- only the selected bot's effective level changes;
- expiry automatically returns it to the global level and logs once;
- valid clear logs once;
- repeated polls do not repeat administrative lines;
- a malformed/partial rewrite logs one warning, preserves the last valid in-memory overrides, and does not warn again until a valid file has been observed;
- preserved overrides still expire on schedule while the on-disk file remains malformed;
- operational filesystem errors such as `EACCES`/`EISDIR` are rethrown to `FleetOperationsRuntime` rather than labeled malformed;
- absence means an empty valid document, allowing file deletion to clear overrides;
- activating debug logs the privacy warning once.

### Step 2: Test control-command parsing and mutation

Export a testable function:

```ts
export function runLogControl(
  args: string[],
  options: {dataRoot: string; now?: () => Date}
): string;
```

The executable supports exactly:

```text
set <bot-id> summary|verbose|debug --for <positive duration>
list
clear <bot-id>
```

Allow all three valid levels so an individual bot can also be lowered below a more verbose global setting. `list`, `set`, and `clear` each read `status.json` and the override document once; all use status-backed bot IDs and document keys never self-authorize. `list` filters expired entries and prints bot ID, level, expiry, and remaining duration. All mutations prune expired entries and call `writeOverrides`, which delegates to `writePrivateJsonAtomic`. An active unknown entry causes no mutation and requires manual repair or waiting for its valid expiry.

Test set/list/clear, expired removed-bot pruning, active unknown rejection, authoritative/coherent list reads, missing/malformed status, invalid level/duration, exact expiry, mode `0600`, and no file mutation on any rejected command.

### Step 3: Run RED, implement, run GREEN, and commit

```bash
TMPDIR=/tmp node node_modules/tsx/dist/cli.mjs --test fleet/logOverrides.test.ts fleet/logControl.test.ts
```

Then:

```bash
TMPDIR=/tmp node node_modules/tsx/dist/cli.mjs --test fleet/logging.test.ts fleet/logOverrides.test.ts fleet/logControl.test.ts fleet/status.test.ts
git diff --check
git add fleet/logOverrides.ts fleet/logOverrides.test.ts fleet/logControl.ts fleet/logControl.test.ts
git commit -m "feat(fleet): control temporary per-bot logging"
```

---

## Task 7: Add five-minute delta summaries and wire the runtime

**Files:**

- Create: `fleet/fleetSummary.ts`
- Create: `fleet/fleetSummary.test.ts`
- Create: `fleet/fleetOperationsRuntime.ts`
- Create: `fleet/fleetOperationsRuntime.test.ts`
- Modify: `fleet/runFleet.ts`
- Modify: `fleet/memoryLog.ts`
- Modify: `fleet/memoryLog.test.ts`

### Step 1: Test pure aggregation and interval formatting

Export:

```ts
export function sumBotCounters(states: readonly BotOperationalSnapshot[]): BotCounters;
export function subtractBotCounters(current: BotCounters, previous: BotCounters): BotCounters;
export function formatFleetIntervalSummary(input: {
  delta: BotCounters;
  queueDepth: number;
  feedsFailing: number;
  rssBytes: number;
}): string;
```

Test exact deltas, zero attempts (`n/a`), and the approved compact wording. Feed success denominator is successful plus failed polls; OG denominator is attempted; terminal post denominator is successful plus uncertain. Include deferred and exception counts only when non-zero. Reuse/export the existing byte-to-MB formatter from `memoryLog.ts` instead of duplicating it.

### Step 2: Implement a testable runtime controller

Create `FleetOperationsRuntime` in `fleet/fleetOperationsRuntime.ts` with injected timers, clock, memory reader, paths, logger, operations map, and coordinator accessors. It owns only these actions:

```ts
export class FleetOperationsRuntime {
  constructor(options: FleetOperationsRuntimeOptions);
  start(): void;
  markRunning(): void;
  markStopping(): void;
  stop(): void;
}
```

`FleetOperationsRuntimeOptions` contains only the dependencies named above plus `configInvalidCount`; it must not receive bot configs, secrets, feed URLs, or post data.

- write an immediate snapshot, then every 60 seconds;
- poll overrides immediately, then every 5 seconds;
- log delta summary every 5 minutes and replace the previous counter baseline only after successful emission;
- change phase from `starting` to `running` after `coordinator.start()` resolves;
- write `stopping` before `shutdownAll()`;
- clear all three timers on shutdown;
- catch snapshot/override/summary observer errors, log one safe warning plus sanitized debug detail, retain summary deltas after collection or emission failure, and never throw into bot execution.

Fake-timer tests prove the immediate startup snapshot exists before activation finishes, 59-bot starting counts are visible, each cadence fires only its own action, failed queue/memory collection or summary emission retains every delta, and stopping is written before the fake worker shutdown resolves. No real signals, sleeps, authentication, feeds, or posts.

### Step 3: Wire one shared object graph in `main()`

Make these concrete edits:

1. Parse `FLEET_LOG_LEVEL` before loading bot secrets and construct one `FleetLogger`.
2. Call `installProcessSafetyNet(logger)`.
3. Create one `BotOperations` per valid enabled `BotSpec` before constructing `AuthCoordinator`.
4. Pass that same object and logger through `buildWorker` to `BskyClient`, `FeedReader`, and `BotWorker`.
5. Give `AuthCoordinator` the logger.
6. Start operations timers before awaiting the sequential `coordinator.start()`.
7. Remove `FLEET_MEMORY_LOG_INTERVAL_MS` and the separate one-minute memory interval; memory now appears in status and the five-minute summary.
8. On config errors, summary logs only `[bot-id] Config invalid`; debug logs sanitized stored detail. Never log the loaded `BotSpec` or secrets object.
9. At global debug startup, emit one privacy warning.
10. Route top-level startup rejection through a generic logger summary and sanitized debug detail, including invalid bootstrap/log-level failures; never use raw `console.error` there.
11. Suppress `Fleet started` if shutdown began during the authentication stagger.
12. Preserve existing PID-lock acquisition/release, no-active-bots exit, signal ordering, bounded shutdown, and dry-run behavior.

### Step 4: Run focused tests and commit

```bash
TMPDIR=/tmp node node_modules/tsx/dist/cli.mjs --test fleet/fleetSummary.test.ts fleet/fleetOperationsRuntime.test.ts fleet/memoryLog.test.ts fleet/authCoordinator.test.ts fleet/botWorker.test.ts fleet/feedReader.test.ts
git diff --check
git add fleet/fleetSummary.ts fleet/fleetSummary.test.ts fleet/fleetOperationsRuntime.ts fleet/fleetOperationsRuntime.test.ts fleet/runFleet.ts fleet/memoryLog.ts fleet/memoryLog.test.ts
git commit -m "feat(fleet): publish status and interval summaries"
```

---

## Task 8: Document the operator commands

**Files:**

- Modify: `package.json`
- Modify: `documentation/fleet.md`

### Step 1: Add stable local scripts

Add:

```json
"fleet:status": "NODE_NO_WARNINGS=1 tsx ./fleet/status.ts",
"fleet:log": "NODE_NO_WARNINGS=1 tsx ./fleet/logControl.ts"
```

Do not add dependencies or change the fleet start command.

### Step 2: Add a focused “Operations visibility” section

Document only current feature behavior:

- `FLEET_LOG_LEVEL=summary|verbose|debug`, with `summary` default;
- summary/verbose/debug contents and the debug privacy warning;
- debug error sanitization and transient caught-error/timing/limiter detail;
- `yarn fleet:status` and `yarn fleet:status --bots`;
- `yarn fleet:log set <bot-id> debug --for 15m`;
- `yarn fleet:log set <bot-id> verbose --for 30m`;
- `yarn fleet:log list` and `yarn fleet:log clear <bot-id>`;
- snapshot/override locations and `0600` mode;
- process-lifetime counters reset on restart;
- a feed in `failing` state is an upstream/feed fact, while OG fallback is counted separately and can still lead to a successful post;
- upload failure is a non-rate-limit 30-second deferral that keeps the row queued;
- active unknown override entries require manual correction/removal or waiting for expiry, while expired removed-bot entries are pruned;
- no restart/config reload/process control is performed by the log CLI.

Do not add dashboard, migration, rollback, deployment, or production-adoption instructions in this task.

### Step 3: Verify and commit

```bash
yarn fleet:status || true
git diff --check
git add package.json documentation/fleet.md
git commit -m "docs: explain fleet visibility commands"
```

The command may exit non-zero if no local status file exists; that is acceptable only if it prints the explicit missing-status message and does not create a file.

---

## Task 9: Full regression and scope acceptance

**Files:**

- Modify only files required to fix regressions introduced by Tasks 1–8.

### Step 1: Run the complete fleet suite

```bash
TMPDIR=/tmp node node_modules/tsx/dist/cli.mjs --test fleet/*.test.ts
```

Expected: all original 129 tests plus the new tests pass; no real network authentication or publishing occurs.

### Step 2: Check compiler drift without hiding the baseline

```bash
node node_modules/typescript/bin/tsc --noEmit --ignoreDeprecations 6.0
yarn typecheck
```

Expected first command: only the two recorded baseline errors remain (`fleet/botStore.ts:135` TS2352 and the pre-existing callback at `fleet/botWorker.test.ts:254` TS7006, with its line allowed to shift). Expected second command: the two TypeScript 6 configuration deprecation errors remain visible. Any error in a newly created/modified feature line must be fixed before continuing.

### Step 3: Prove the privacy and repository boundary mechanically

```bash
rg -n "appPassword|password|session|token|identifier|feedUrl|content|title" fleet/statusSnapshot.ts fleet/status.ts
rg -n "console\.(error|warn)|logger\.debug|formatDebugError" fleet/runFleet.ts fleet/processSafety.ts fleet/authCoordinator.ts fleet/botWorker.ts fleet/bskyClient.ts fleet/feedReader.ts fleet/fleetOperationsRuntime.ts
rg -n "HTTP|listen\(|createServer|express|prometheus|sqlite|DatabaseSync" fleet/statusSnapshot.ts fleet/status.ts fleet/logOverrides.ts fleet/logControl.ts fleet/fleetSummary.ts
git status --short
git diff --check main...HEAD
```

Expected: the status search finds no serialized private fields (type/import names in tests must be inspected, not blindly accepted); every runtime error sink is inspected for generic summaries plus `formatDebugError`, with literal embedded-secret message/stack tests; the server search finds no server, metrics service, or persistence addition; only `bsky.rss` implementation/docs paths are changed.

### Step 4: Review against every approved acceptance point

Check each item explicitly:

- feed success includes an empty successful poll;
- first failure/repeat suppression/recovery are correct;
- OG fallback remains a fallback, not a post failure;
- upload failure remains queued with a truthful non-rate-limit deferral reason while 429/504 behavior is unchanged;
- exact process-lifetime counters and five-minute deltas use the correct denominators;
- known external post outcomes survive local queue-mutation failure, and interval baselines advance only after successful emission;
- default logs are summary-only and no one-minute memory spam remains;
- full verbose/debug remains available with sanitized caught-error, duration, and limiter detail isolated per bot;
- one bot can change level without restarting or affecting the other bots;
- set/detect/expire/list/clear, two-pass expiry/authority reconciliation, one-read status-backed list, malformed retention, and operational I/O distinction work;
- snapshot/override atomic replacement and `0600` are tested;
- starting/current/stale/current-stopping/stale-stopping status cases and stable final uptime are explicit;
- shutdown during activation does not publish a stale `Fleet started` summary;
- no dashboard, deployment, template, migration, or production mutation entered the diff.

### Step 5: Commit only if acceptance required a correction

If acceptance required a correction, stage each corrected feature file by its exact path (never `git add -A`) and commit it with `git commit -m "fix(fleet): close visibility acceptance gaps"`. If no correction was needed, do not create an empty commit. Stop for review; production and fleet-template adoption remain separate follow-up decisions.
