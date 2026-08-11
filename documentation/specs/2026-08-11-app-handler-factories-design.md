# app/ Handler Factories Design

Closes session tasks #74 (refactor app/'s handlers off module-level singleton state) and #81
(fix cross-file test-isolation race in app/utils/*.test.ts).

## Problem

The [2026-08-11 ESM migration](2026-08-10-esm-migration-design.md) needed to reset module-level
state between tests in 4 of `app/utils/`'s test files. Its interim fix — dynamic
`import('./x.ts?t=' + crypto.randomUUID())` to force a fresh ES module instance, replacing CJS's
`delete require.cache[...]` + re-`require()` — was explicitly scoped as interim, not the real fix
(see that spec's Changes section and the implementation plan's Task 3/4 notes). The user approved
deferring the real fix to be done after the migration ("can we do 3 after we do the rest of the
refactoring?").

The real issue predates the ESM migration: `app/`'s four handlers (`dbHandler.ts`,
`bskyHandler.ts`, `queueHandler.ts`, `rssHandler.ts`) hold their state in module-level `let`
variables and export a `default {...}` object of functions closing over that state — a true
singleton, constructed once at module-evaluation time, indistinguishable from any other import of
the same file. There is no way to get a second, independent instance short of forcing the module
system to re-evaluate the file from scratch, which is what the cache-busting hack does.

`dbHandler.ts` has a second, deeper problem: every file path is hardcoded as
`import.meta.dirname + '/../../data/<file>'` — there is no `dataRoot` parameter at all. Even a
genuinely fresh module instance still resolves to the exact same physical directory. This is why
the ESM migration's final whole-branch review found a real operational hazard: `app/utils/*.test.ts`
tests read and write the actual `./data` directory as fixtures (`data/config.json`, `data/last.txt`,
`data/db.txt`, `data/persist.json`), with no per-file isolation. `node:test` runs test files in
parallel child processes, so these race — confirmed via a git-worktree comparison against the
pre-migration baseline: the race does not reproduce on old code (0/3 runs) but does on migrated code
(2/3 runs), because switching `beforeEach` hooks from synchronous `require()` to
`await import(...)` widened the interleaving window. Independent of the race, simply running the
test suite has already overwritten a real local `data/config.json` with test fixture content and
rewound `data/last.txt` — a hazard regardless of whether the race triggers on any given run.

## Non-goals

- No change to `fleet/`'s handler classes (`BotStore`, `BskyClient`, `FeedReader`, `BotWorker`,
  `AuthCoordinator`) — they already solve the N-independent-instances problem correctly, are not
  part of this bug, and are out of scope.
- No change to posting/dedup/rate-limit/pacing *behavior* anywhere. This is a construction-and-wiring
  change only; every function's internal logic is carried over unchanged.
- No change to the real, single production data directory path or its contents' format.

## Design

### Factory functions, not classes

Each of `app/utils/{dbHandler,bskyHandler,queueHandler,rssHandler,healthHandler}.ts` changes from

```ts
let someState: T = ...;
async function doThing() { /* reads/writes someState */ }
export default {doThing};
```

to

```ts
export function createXHandler(deps): XHandler {
  let someState: T = ...;
  async function doThing() { /* reads/writes someState */ }
  return {doThing};
}
```

Every exported function name and signature is unchanged; only where the state lives changes (module
scope → closure scope), and construction becomes an explicit call instead of an implicit
module-import side effect. This keeps the "plain object of functions" shape CLAUDE.md documents for
`app/` — call sites (`db.readLast()`, `bsky.post(...)`, etc.) are unaffected. Classes were considered
(matching `fleet/`'s convention) and rejected: the state genuinely doesn't need inheritance,
polymorphism, or private-field enforcement across multiple implementations, and factories are the
smaller conceptual jump from what's there today. `app/`'s and `fleet/`'s handlers now share the
same *capability* (constructible, independent state) via two different idioms suited to each mode's
actual needs — `fleet/` truly runs N instances per process in production; `app/` runs exactly one,
always, and the factory only exists to make that one instance's state real and testable rather than
implicit.

### Per-handler shape

**`dbHandler.ts`** — `createDbHandler(dataRoot: string): DbHandler`. `dataRoot` replaces every
`import.meta.dirname + '/../../data'` computation; every function reads/writes
`${dataRoot}/<file>` instead. `appConfig` moves from a module-level `let` into the closure.

**`bskyHandler.ts`** — `createBskyHandler(db: DbHandler): BskyHandler`. `bskyAgent` moves into the
closure. The existing `if (bskyAgent) throw new Error('Bluesky agent already initialized.')` guard
in `init()` is kept as-is — it protects against calling `init()` twice on the *same* handler
instance (which would leak the first `BskyAgent` and leave its `persistSession` callback racing
the second one's writes to `db.writePersistDate`), a real invariant independent of whether the
state lives at module or closure scope.

**`queueHandler.ts`** — `createQueueHandler(bsky: BskyHandler, db: DbHandler, health:
HealthHandler): QueueHandler`. `queue`, `rateLimited`, `queueRunning`, `queueSnapshot`,
`lastPostTimestamp`, `config` all move into the closure.

**`rssHandler.ts`** — `createRssHandler(queue: QueueHandler, db: DbHandler): RssHandler`. `reader`,
`lastDate`, `batchMax`, `config` move into the closure.

**`healthHandler.ts`** — `createHealthHandler(): HealthHandler`. No constructor dependencies. Binds
one real OS port per instance (`process.env.HEALTH_CHECK_PORT || 8080`); both `app/index.ts` and
`fleet/runFleet.ts` construct exactly one instance per process, same as today's one-singleton-per-
process behavior, just via an explicit call instead of a shared module import. The existing
`reset()` export (already a de facto "reset for testing" escape hatch on the old singleton) is
kept as an instance method — it's testing-only same as before, just now scoped to one constructed
server instance instead of the whole module.

### Wiring

`app/index.ts` builds the real chain explicitly, replacing today's independent top-level imports of
`bsky`/`reader`/`queue`/`health`:

```ts
const db = createDbHandler(join(import.meta.dirname, '../data'));
const health = createHealthHandler();
const bsky = createBskyHandler(db);
const queue = createQueueHandler(bsky, db, health);
const reader = createRssHandler(queue, db);
```

`join(import.meta.dirname, '../data')` resolves to the exact same real directory
`dbHandler.ts`'s hardcoded paths point at today (`app/utils/../../data` = `<project-root>/data`) —
no behavior change for real deployments.

`fleet/runFleet.ts` replaces `import health from '../app/utils/healthHandler.ts'` with its own
`const health = createHealthHandler();` constructed once in `main()`, alongside its other
per-process singletons. No other part of `fleet/` changes.

### Test isolation

Each of the 5 `.test.ts` files' `beforeEach` (or equivalent per-test setup) creates a fresh
directory via `fs.mkdtempSync(path.join(os.tmpdir(), 'bsky-rss-test-'))` and constructs that test's
handler(s) with `createDbHandler(testDataDir)` (and whatever else needs a fresh instance for that
test). `afterEach`/`after` removes it with `fs.rmSync(testDataDir, {recursive: true, force: true})`.
The real `./data` directory is never read or written by any test again — this removes both the race
(no shared physical resource left to race on) and the operational hazard (a test crash or a stray
path bug can no longer reach real local state) in one change.

All 27 `crypto.randomUUID()`-cache-busting `import('./x.ts?t=' + ...)` call sites across
`bskyHandler.test.ts`, `queueHandler.test.ts`, `rssHandler.test.ts`, `dbHandler.test.ts` are deleted
— a fresh handler instance is now `createXHandler(...)`, a plain function call, not a forced module
re-evaluation. `healthHandler.test.ts` did not use the cache-busting pattern (it already used
`reset()` on the shared singleton) and needs a smaller edit: construct one `createHealthHandler()`
instance in `before()`, same as today's one-server-for-the-whole-suite shape, just via the factory
instead of the shared default export.

### CLAUDE.md

The "Conventions already in the code" section's line — `` `module-level `let` variables hold state
(e.g. `bskyAgent`, `queue`, `appConfig`)` `` — needs a one-line correction once this lands: state
moves from module scope to per-instance closure scope, constructed once in `app/index.ts` (and once
more in `fleet/runFleet.ts` for `healthHandler` specifically). The "plain objects, not classes" part
of the convention is unchanged and still holds.

## Testing

- Every existing test in all 5 files continues to assert the same behavior; only construction
  changes (`createXHandler(...)` instead of cache-busted `import()`, `testDataDir` instead of the
  real `./data`).
- `yarn typecheck`, `yarn test:app`, `yarn test:fleet` (for the `runFleet.ts` wiring change), and
  targeted `npx eslint <touched files>` (full-repo `yarn lint`/`eslint .` is known to hang in this
  sandbox, unrelated to this change — lint touched files individually, per the ESM migration's
  established workaround).
- Manual verification that `yarn test` run repeatedly (5+ times) no longer shows any variance in
  pass/fail results, confirming the race is gone, not just less likely.
- Manual smoke check that the real `./data` directory is untouched (`git status`/`ls -la data/`
  unchanged) after a full `yarn test` run.

## Rollout

Single commit sequence on `main`, same as the ESM migration (no feature branch has been used all
session for this kind of change). No config format change, no deploy-time behavior change — this is
purely an internal construction/wiring refactor. Deploy is not required to land this (it doesn't
change runtime behavior), but the next regular fleet/single-bot deploy will carry it.
