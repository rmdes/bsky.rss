# Fleet Per-Bot Config Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change, add, enable, disable, or remove one fleet bot while the fleet keeps running, automatically within ~10 s or on demand via `yarn fleet:reload`.

**Architecture:** A polling `ConfigReconciler` (every 10 s) fingerprints each bot's `bot.json`, `config.json`, and own secret, compares with what is running, and starts/stops/restarts only the differing bots one at a time through a `BotLifecycle` that builds workers with the existing `buildWorker` and registers them with `AuthCoordinator`. A `reload-requests.json` file (written by a CLI) forces reloads through the same loop.

**Tech Stack:** TypeScript run by tsx, Node 26 (`node:test`, `node:sqlite`, `node:crypto`), yarn 4. Spec: `documentation/specs/2026-11-09-fleet-config-reload-design.md`.

## Global Constraints

- Poll interval: **10 seconds**. A missing bot directory stops its bot only after **two consecutive ticks**.
- The old worker is always stopped before the new one starts; never two workers for one bot.
- A broken secrets file never stops a bot.
- Cursor, queue, dedup, freshness, and posting semantics are unchanged; the cursor is kept across reloads.
- Log lines use scope `CONFIG` at `summary` level and name changed **top-level field names only, never values**; a changed secret is logged as `secret`. Parser error text is never logged (it can contain file content).
- `fleet.json` and environment variables are not reloadable.
- Request file: `<FLEET_DATA_ROOT>/reload-requests.json`, shape `{"requests": ["<bot-id>" | "*", ...]}`, written atomically with mode `0600` via `writePrivateJsonAtomic` (`fleet/atomicJson.ts`).
- No new dependencies.
- Follow the file's existing style: fleet mode uses classes and plain functions, `node:test` + `node:assert/strict`, 2-space indent, single quotes, `{a, b}` braces without spaces. Run `npx eslint --fix <files>` before each commit.
- Verify each task with `yarn typecheck`, `yarn lint`, and the task's test file(s) via `npx tsx --test <file>`. If port 8080 is taken locally, run the full suite as `HEALTH_CHECK_PORT=18080 yarn test`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `fleet/botFingerprint.ts` | create | List bot directories; fingerprint one bot (`enabled`, hash, field digests); name changed fields |
| `fleet/reloadRequests.ts` | create | Path, add, and atomically take reload requests |
| `fleet/notifierClaims.ts` | create | Which bot config holds the notification role per Bluesky account |
| `fleet/configReconciler.ts` | create | The 10 s loop: diff, plan, execute start/stop/restart with rollback and log-once rules |
| `fleet/botLifecycle.ts` | create | `build`/`startBot`/`stopBot` over coordinator, operations map, notifier claims |
| `fleet/reloadControl.ts` | create | CLI behind `yarn fleet:reload` |
| `fleet/authCoordinator.ts` | modify | `addWorker`, `removeWorker`, `recordFailure`, `forgetFailure` |
| `fleet/botOperations.ts` | modify | Record config-loaded time and last config outcome |
| `fleet/status.ts` | modify | Accept and show the new per-bot fields |
| `fleet/logOverrides.ts`, `fleet/fleetOperationsRuntime.ts` | modify | Log overrides accept bots added after startup |
| `fleet/configLoader.ts` | modify | Export `loadOneBot` |
| `fleet/runFleet.ts` | modify | Wire lifecycle, claims, reconciler, shutdown order; drop `shouldAssignNotifier` |
| `package.json`, `documentation/fleet.md`, `CHANGELOG.md` | modify | Script and docs |

---

### Task 1: Bot fingerprints

**Files:**
- Create: `fleet/botFingerprint.ts`
- Test: `fleet/botFingerprint.test.ts`

**Interfaces:**
- Produces:
  - `type BotFingerprint = {ok: true; botId: string; enabled: boolean; hash: string; fields: Record<string, string>} | {ok: false; botId: string; error: string}`
  - `listBotIds(configRoot: string): string[]` (sorted directory names under `<configRoot>/bots`; throws if unreadable)
  - `fingerprintBot(configRoot: string, secrets: Readonly<Record<string, string>>, botId: string): BotFingerprint`
  - `changedFields(before: Record<string, string>, after: Record<string, string>): string[]` (sorted)

- [ ] **Step 1: Write the failing tests**

```ts
// fleet/botFingerprint.test.ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {changedFields, fingerprintBot, listBotIds} from './botFingerprint.ts';

function configTree(t: {after(callback: () => void): void}): string {
  const root = mkdtempSync(join(tmpdir(), 'fingerprint-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}

function writeBot(root: string, botId: string, bot: object, config: object | string = {string: '$title'}): void {
  const dir = join(root, 'bots', botId);
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'bot.json'), JSON.stringify(bot));
  writeFileSync(join(dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
}

const bot = (overrides: object = {}) => ({
  id: 'a',
  enabled: true,
  identifier: 'a.bsky.social',
  instanceUrl: 'https://bsky.social',
  feedUrl: 'https://example.test/feed.xml?token=FEEDTOKEN',
  secretKey: 'a',
  fetchIntervalMinutes: 5,
  ...overrides,
});

test('listBotIds returns sorted bot directory names', t => {
  const root = configTree(t);
  writeBot(root, 'b', bot({id: 'b'}));
  writeBot(root, 'a', bot());
  writeFileSync(join(root, 'bots', 'not-a-dir.txt'), 'x');
  assert.deepEqual(listBotIds(root), ['a', 'b']);
});

test('identical files and secret give the identical hash', t => {
  const root = configTree(t);
  writeBot(root, 'a', bot());
  const first = fingerprintBot(root, {a: 'pw'}, 'a');
  const second = fingerprintBot(root, {a: 'pw'}, 'a');
  assert.ok(first.ok && second.ok);
  assert.equal(first.hash, second.hash);
  assert.equal(first.enabled, true);
});

test('bot.json, config.json, and this bot’s own secret each change the hash', t => {
  const root = configTree(t);
  writeBot(root, 'a', bot());
  const base = fingerprintBot(root, {a: 'pw', other: 'x'}, 'a');
  writeBot(root, 'a', bot({feedUrl: 'https://example.test/new.xml'}));
  const botChanged = fingerprintBot(root, {a: 'pw', other: 'x'}, 'a');
  writeBot(root, 'a', bot(), {string: '$title $link'});
  const configChanged = fingerprintBot(root, {a: 'pw', other: 'x'}, 'a');
  writeBot(root, 'a', bot());
  const secretChanged = fingerprintBot(root, {a: 'new-pw', other: 'x'}, 'a');
  const otherSecretChanged = fingerprintBot(root, {a: 'pw', other: 'y'}, 'a');
  assert.ok(base.ok && botChanged.ok && configChanged.ok && secretChanged.ok && otherSecretChanged.ok);
  assert.notEqual(botChanged.hash, base.hash);
  assert.notEqual(configChanged.hash, base.hash);
  assert.notEqual(secretChanged.hash, base.hash);
  assert.equal(otherSecretChanged.hash, base.hash);
});

test('changedFields names fields, never values, and reports a secret change as "secret"', t => {
  const root = configTree(t);
  writeBot(root, 'a', bot());
  const before = fingerprintBot(root, {a: 'pw'}, 'a');
  writeBot(root, 'a', bot({feedUrl: 'https://example.test/feed.xml?token=NEWTOKEN'}), {string: '$link'});
  const after = fingerprintBot(root, {a: 'new-pw'}, 'a');
  assert.ok(before.ok && after.ok);
  const changed = changedFields(before.fields, after.fields);
  assert.deepEqual(changed, ['feedUrl', 'secret', 'string']);
  assert.ok(!JSON.stringify(after.fields).includes('new-pw'));
});

test('a disabled bot fingerprints with enabled false', t => {
  const root = configTree(t);
  writeBot(root, 'a', bot({enabled: false}));
  const fingerprint = fingerprintBot(root, {a: 'pw'}, 'a');
  assert.ok(fingerprint.ok);
  assert.equal(fingerprint.enabled, false);
});

test('invalid or unreadable JSON is an error result naming the file, without parser text', t => {
  const root = configTree(t);
  writeBot(root, 'a', bot(), '{"string": "token=SECRETVALUE",');
  const invalid = fingerprintBot(root, {a: 'pw'}, 'a');
  assert.deepEqual(invalid, {ok: false, botId: 'a', error: 'invalid config.json'});
  const missing = fingerprintBot(root, {}, 'nope');
  assert.deepEqual(missing, {ok: false, botId: 'nope', error: 'cannot read bot.json'});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test fleet/botFingerprint.test.ts`
Expected: FAIL with `Cannot find module './botFingerprint.ts'`.

- [ ] **Step 3: Implement**

```ts
// fleet/botFingerprint.ts
// Fingerprints what defines one fleet bot, so the config reconciler can tell exactly which bots
// changed on disk. See documentation/specs/2026-11-09-fleet-config-reload-design.md.
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

export type BotFingerprint =
  | {ok: true; botId: string; enabled: boolean; hash: string; fields: Record<string, string>}
  | {ok: false; botId: string; error: string};

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function listBotIds(configRoot: string): string[] {
  return readdirSync(join(configRoot, 'bots'), {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

// Parser messages are not passed on: some engines quote a snippet of the file, which can hold a
// feed token.
function readJsonObject(path: string, name: string): {raw: string; value: Record<string, unknown>} {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    throw new Error(`cannot read ${name}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`invalid ${name}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${name}`);
  }
  return {raw, value: value as Record<string, unknown>};
}

export function fingerprintBot(
  configRoot: string,
  secrets: Readonly<Record<string, string>>,
  botId: string,
): BotFingerprint {
  const botDir = join(configRoot, 'bots', botId);
  let bot: {raw: string; value: Record<string, unknown>};
  let config: {raw: string; value: Record<string, unknown>} = {raw: '', value: {}};
  try {
    bot = readJsonObject(join(botDir, 'bot.json'), 'bot.json');
    const configPath = join(botDir, 'config.json');
    if (existsSync(configPath)) config = readJsonObject(configPath, 'config.json');
  } catch (error) {
    return {ok: false, botId, error: (error as Error).message};
  }

  const secretKey = typeof bot.value.secretKey === 'string' ? bot.value.secretKey : '';
  const secret = secrets[secretKey] ?? '';

  // Values are digested, never kept, so changed-field comparisons can't leak them.
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.value)) fields[key] = sha256(JSON.stringify(value));
  for (const [key, value] of Object.entries(bot.value)) fields[key] = sha256(JSON.stringify(value));
  fields.secret = sha256(secret);

  return {
    ok: true,
    botId,
    enabled: Boolean(bot.value.enabled),
    hash: sha256([bot.raw, config.raw, secret].join('\u0000')),
    fields,
  };
}

export function changedFields(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(key => before[key] !== after[key]).sort();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test fleet/botFingerprint.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
npx eslint --fix fleet/botFingerprint.ts fleet/botFingerprint.test.ts
git add fleet/botFingerprint.ts fleet/botFingerprint.test.ts
git commit -m "feat(fleet): fingerprint a bot's config files and own secret"
```

---

### Task 2: Reload request file

**Files:**
- Create: `fleet/reloadRequests.ts`
- Test: `fleet/reloadRequests.test.ts`

**Interfaces:**
- Consumes: `writePrivateJsonAtomic(path: string, value: unknown): void` from `fleet/atomicJson.ts`.
- Produces:
  - `interface ReloadRequests {all: boolean; botIds: string[]}`
  - `const NO_RELOAD_REQUESTS: ReloadRequests`
  - `reloadRequestsPath(dataRoot: string): string`
  - `addReloadRequest(path: string, target: string): void` (`target` is a bot id or `'*'`)
  - `takeReloadRequests(path: string): {ok: true; requests: ReloadRequests} | {ok: false; error: string}` (atomic: renames the file away before reading, so a request written meanwhile lands in a fresh file)

- [ ] **Step 1: Write the failing tests**

```ts
// fleet/reloadRequests.test.ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  NO_RELOAD_REQUESTS,
  addReloadRequest,
  reloadRequestsPath,
  takeReloadRequests,
} from './reloadRequests.ts';

function dataRoot(t: {after(callback: () => void): void}): string {
  const root = mkdtempSync(join(tmpdir(), 'reload-requests-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}

test('no file means no requests', t => {
  const path = reloadRequestsPath(dataRoot(t));
  assert.deepEqual(takeReloadRequests(path), {ok: true, requests: NO_RELOAD_REQUESTS});
});

test('requests accumulate, are written 0600, and are consumed exactly once', t => {
  const path = reloadRequestsPath(dataRoot(t));
  addReloadRequest(path, 'skyfleet-en');
  addReloadRequest(path, 'euwatch-fr');
  addReloadRequest(path, 'skyfleet-en');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(takeReloadRequests(path), {
    ok: true,
    requests: {all: false, botIds: ['skyfleet-en', 'euwatch-fr']},
  });
  assert.equal(existsSync(path), false);
  assert.deepEqual(takeReloadRequests(path), {ok: true, requests: NO_RELOAD_REQUESTS});
});

test('"*" means all bots', t => {
  const path = reloadRequestsPath(dataRoot(t));
  addReloadRequest(path, '*');
  const taken = takeReloadRequests(path);
  assert.ok(taken.ok);
  assert.equal(taken.requests.all, true);
});

test('a malformed file is reported, not thrown, and is consumed', t => {
  const path = reloadRequestsPath(dataRoot(t));
  writeFileSync(path, '{"requests": "skyfleet-en"}');
  const taken = takeReloadRequests(path);
  assert.equal(taken.ok, false);
  assert.equal(existsSync(path), false);
});

test('adding to a malformed file replaces it', t => {
  const path = reloadRequestsPath(dataRoot(t));
  writeFileSync(path, 'not json');
  addReloadRequest(path, 'skyfleet-en');
  assert.deepEqual(takeReloadRequests(path), {
    ok: true,
    requests: {all: false, botIds: ['skyfleet-en']},
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test fleet/reloadRequests.test.ts`
Expected: FAIL with `Cannot find module './reloadRequests.ts'`.

- [ ] **Step 3: Implement**

```ts
// fleet/reloadRequests.ts
// The control channel behind `yarn fleet:reload`: the CLI adds requests, the config reconciler
// takes them. Mirrors fleet/logOverrides.ts.
import {existsSync, readFileSync, renameSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {writePrivateJsonAtomic} from './atomicJson.ts';

export interface ReloadRequests {
  all: boolean;
  botIds: string[];
}

export const NO_RELOAD_REQUESTS: ReloadRequests = {all: false, botIds: []};

export function reloadRequestsPath(dataRoot: string): string {
  return join(dataRoot, 'reload-requests.json');
}

function parseRequests(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  const requests = (parsed as {requests?: unknown} | null)?.requests;
  if (!Array.isArray(requests) || !requests.every(request => typeof request === 'string')) {
    throw new Error('reload-requests.json must be {"requests": [string, ...]}');
  }
  return requests as string[];
}

export function addReloadRequest(path: string, target: string): void {
  let existing: string[] = [];
  if (existsSync(path)) {
    try {
      existing = parseRequests(readFileSync(path, 'utf-8'));
    } catch {
      existing = []; // a malformed file is replaced
    }
  }
  writePrivateJsonAtomic(path, {requests: [...new Set([...existing, target])]});
}

export function takeReloadRequests(
  path: string,
): {ok: true; requests: ReloadRequests} | {ok: false; error: string} {
  const takenPath = `${path}.taking`;
  try {
    renameSync(path, takenPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {ok: true, requests: NO_RELOAD_REQUESTS};
    }
    return {ok: false, error: `cannot read reload requests (${(error as NodeJS.ErrnoException).code})`};
  }
  try {
    const requests = parseRequests(readFileSync(takenPath, 'utf-8'));
    return {
      ok: true,
      requests: {
        all: requests.includes('*'),
        botIds: [...new Set(requests.filter(request => request !== '*'))],
      },
    };
  } catch {
    return {ok: false, error: 'invalid reload-requests.json'};
  } finally {
    try {
      unlinkSync(takenPath);
    } catch {
      // Already gone; nothing to consume.
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test fleet/reloadRequests.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
npx eslint --fix fleet/reloadRequests.ts fleet/reloadRequests.test.ts
git add fleet/reloadRequests.ts fleet/reloadRequests.test.ts
git commit -m "feat(fleet): reload request file for fleet:reload"
```

---

### Task 3: Coordinator worker registry and notifier claims

**Files:**
- Modify: `fleet/authCoordinator.ts` (add four methods after `activationFailures()`)
- Create: `fleet/notifierClaims.ts`
- Test: `fleet/authCoordinator.test.ts` (append), `fleet/notifierClaims.test.ts`

**Interfaces:**
- Produces on `AuthCoordinator`:
  - `addWorker(worker: BotWorker): void` (replaces any worker with the same `botId`, clears its failure)
  - `removeWorker(botId: string): BotWorker | undefined`
  - `recordFailure(botId: string, error: string): void` (replaces this bot's previous failure)
  - `forgetFailure(botId: string): void`
- Produces `class NotifierClaims`:
  - `claim(botId: string, identifier: string): boolean` (true if this bot now holds, or already held, the role for `identifier`)
  - `release(botId: string): string | undefined` (returns the identifier released, if this bot held one)

- [ ] **Step 1: Write the failing tests**

Append to `fleet/authCoordinator.test.ts` (it already defines `quietLogger`, `makeSpec`, `fakeWorker`):

```ts
test('addWorker registers a worker, replacing one with the same botId and clearing its failure', () => {
  const coordinator = new AuthCoordinator({
    logger: quietLogger(),
    bots: [],
    staggerSeconds: 0,
    activateBot: async spec => fakeWorker(spec.botId),
  });
  coordinator.recordFailure('bot-1', 'login failed');
  const first = fakeWorker('bot-1');
  const second = fakeWorker('bot-1');
  coordinator.addWorker(first);
  coordinator.addWorker(second);
  assert.deepEqual(coordinator.activeWorkers(), [second]);
  assert.deepEqual(coordinator.activationFailures(), []);
});

test('removeWorker returns and unregisters the worker; failures can be recorded and forgotten', () => {
  const coordinator = new AuthCoordinator({
    logger: quietLogger(),
    bots: [],
    staggerSeconds: 0,
    activateBot: async spec => fakeWorker(spec.botId),
  });
  const worker = fakeWorker('bot-1');
  coordinator.addWorker(worker);
  assert.equal(coordinator.removeWorker('bot-1'), worker);
  assert.equal(coordinator.removeWorker('bot-1'), undefined);
  assert.deepEqual(coordinator.activeWorkers(), []);
  coordinator.recordFailure('bot-2', 'first');
  coordinator.recordFailure('bot-2', 'second');
  assert.deepEqual(coordinator.activationFailures(), [{botId: 'bot-2', error: 'second'}]);
  coordinator.forgetFailure('bot-2');
  assert.deepEqual(coordinator.activationFailures(), []);
});
```

```ts
// fleet/notifierClaims.test.ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NotifierClaims} from './notifierClaims.ts';

test('the first config for an account claims its notifications; siblings do not', () => {
  const claims = new NotifierClaims();
  assert.equal(claims.claim('euwatch-fr', 'euwatch.live'), true);
  assert.equal(claims.claim('euwatch-en', 'euwatch.live'), false);
  assert.equal(claims.claim('other', 'other.bsky.social'), true);
});

test('a holder re-claiming keeps the role', () => {
  const claims = new NotifierClaims();
  claims.claim('euwatch-fr', 'euwatch.live');
  assert.equal(claims.claim('euwatch-fr', 'euwatch.live'), true);
});

test('release frees the role for the next sibling that starts', () => {
  const claims = new NotifierClaims();
  claims.claim('euwatch-fr', 'euwatch.live');
  assert.equal(claims.release('euwatch-en'), undefined);
  assert.equal(claims.release('euwatch-fr'), 'euwatch.live');
  assert.equal(claims.claim('euwatch-en', 'euwatch.live'), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test fleet/authCoordinator.test.ts fleet/notifierClaims.test.ts`
Expected: FAIL (`coordinator.recordFailure is not a function`; `Cannot find module './notifierClaims.ts'`).

- [ ] **Step 3: Implement**

In `fleet/authCoordinator.ts`, insert after `activationFailures()`:

```ts
  // Used by the config reconciler (fleet/configReconciler.ts) to change the running set after
  // the initial staggered activation.
  addWorker(worker: BotWorker): void {
    this.workers = [...this.workers.filter(existing => existing.botId !== worker.botId), worker];
    this.forgetFailure(worker.botId);
  }

  removeWorker(botId: string): BotWorker | undefined {
    const worker = this.workers.find(existing => existing.botId === botId);
    this.workers = this.workers.filter(existing => existing.botId !== botId);
    return worker;
  }

  recordFailure(botId: string, error: string): void {
    this.failures = [...this.failures.filter(failure => failure.botId !== botId), {botId, error}];
  }

  forgetFailure(botId: string): void {
    this.failures = this.failures.filter(failure => failure.botId !== botId);
  }
```

```ts
// fleet/notifierClaims.ts
// Only one bot config per Bluesky account polls that account's notifications (several configs
// can share an identity; see documentation/specs/2026-08-09-fleet-identity-dedup-design.md).
// Claims are released when the holder stops, so the next sibling that starts takes over.
export class NotifierClaims {
  private readonly holders = new Map<string, string>(); // identifier -> botId

  claim(botId: string, identifier: string): boolean {
    const holder = this.holders.get(identifier);
    if (holder !== undefined) return holder === botId;
    this.holders.set(identifier, botId);
    return true;
  }

  release(botId: string): string | undefined {
    for (const [identifier, holder] of this.holders) {
      if (holder === botId) {
        this.holders.delete(identifier);
        return identifier;
      }
    }
    return undefined;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test fleet/authCoordinator.test.ts fleet/notifierClaims.test.ts`
Expected: PASS (all existing coordinator tests plus the 2 new ones; 3 claim tests).

- [ ] **Step 5: Commit**

```bash
npx eslint --fix fleet/authCoordinator.ts fleet/authCoordinator.test.ts fleet/notifierClaims.ts fleet/notifierClaims.test.ts
git add fleet/authCoordinator.ts fleet/authCoordinator.test.ts fleet/notifierClaims.ts fleet/notifierClaims.test.ts
git commit -m "feat(fleet): add/remove workers at runtime; releasable notifier claims"
```

---

### Task 4: Config status in operations, status output, and log overrides for new bots

**Files:**
- Modify: `fleet/botOperations.ts` (types, fields, two methods, `snapshot()`)
- Modify: `fleet/status.ts` (`isFleetBotStatus`, `formatBotStatus`)
- Modify: `fleet/logOverrides.ts` (`knownBotIds` parameter types), `fleet/fleetOperationsRuntime.ts:45`
- Test: `fleet/botOperations.test.ts` (append; update expected snapshots), `fleet/status.test.ts`, `fleet/logOverrides.test.ts` (append)

**Interfaces:**
- Produces in `fleet/botOperations.ts`:
  - `type ConfigOutcome = 'started' | 'reloaded' | 'reload-rejected' | 'reload-failed-restored' | 'start-failed'`
  - `BotOperationalSnapshot` gains `configLoadedAt: string | null`, `lastConfigOutcome: ConfigOutcome | null`, `lastConfigOutcomeAt: string | null`
  - `BotOperations.recordConfigLoaded(): void`, `BotOperations.recordConfigOutcome(outcome: ConfigOutcome): void`
- Produces in `fleet/logOverrides.ts`: `knownBotIds` parameters typed `{has(botId: string): boolean}` (a `Set` still satisfies it).

- [ ] **Step 1: Write the failing tests**

Append to `fleet/botOperations.test.ts`:

```ts
test('records when config was loaded and the last config outcome', () => {
  let now = new Date('2026-11-09T12:00:00.000Z');
  const operations = new BotOperations('bot-1', () => now);
  assert.equal(operations.snapshot().configLoadedAt, null);
  assert.equal(operations.snapshot().lastConfigOutcome, null);
  operations.recordConfigLoaded();
  now = new Date('2026-11-09T12:05:00.000Z');
  operations.recordConfigOutcome('reload-rejected');
  const snapshot = operations.snapshot();
  assert.equal(snapshot.configLoadedAt, '2026-11-09T12:00:00.000Z');
  assert.equal(snapshot.lastConfigOutcome, 'reload-rejected');
  assert.equal(snapshot.lastConfigOutcomeAt, '2026-11-09T12:05:00.000Z');
});
```

Append to `fleet/logOverrides.test.ts` (it already imports `mkdtempSync`, `rmSync`, `tmpdir`, `join`, `readValidOverrides`, `writeOverrides`):

```ts
test('readValidOverrides accepts a live bot-id lookup, so bots added after startup qualify', t => {
  const dir = mkdtempSync(join(tmpdir(), 'overrides-live-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const path = join(dir, 'log-overrides.json');
  const now = new Date('2026-11-09T12:00:00.000Z');
  writeOverrides(path, new Map([['new-bot', {level: 'debug', expiresAt: '2026-11-09T13:00:00.000Z'}]]));
  const live = new Map<string, unknown>();
  const knownBotIds = {has: (botId: string) => live.has(botId)};
  assert.throws(() => readValidOverrides(path, knownBotIds, now));
  live.set('new-bot', {});
  assert.equal(readValidOverrides(path, knownBotIds, now).get('new-bot')?.level, 'debug');
});
```

Append to `fleet/status.test.ts` (it already defines `tempDirectory`, `statusFixture`, `now`, and imports `formatFleetStatus`, `readFleetStatus`, `writeFileSync`, `join`):

```ts
test('readFleetStatus accepts bot states without config-reload fields; status shows n/a for them', t => {
  const path = join(tempDirectory(t), 'status.json');
  const fixture = statusFixture();
  const legacy = {
    ...fixture,
    botStates: fixture.botStates.map(bot => {
      const {configLoadedAt: _a, lastConfigOutcome: _b, lastConfigOutcomeAt: _c, ...rest} = bot;
      return rest;
    }),
  };
  writeFileSync(path, JSON.stringify(legacy));
  const output = formatFleetStatus(readFleetStatus(path), {showBots: true, now});
  assert.match(output, /configLoadedAt=n\/a/);
  assert.match(output, /lastConfigOutcome=n\/a/);
});

test('status shows when config was loaded and the last config outcome', () => {
  const fixture = statusFixture();
  const snapshot = {
    ...fixture,
    botStates: fixture.botStates.map(bot => ({
      ...bot,
      configLoadedAt: '2026-11-09T12:00:00.000Z',
      lastConfigOutcome: 'reloaded' as const,
      lastConfigOutcomeAt: '2026-11-09T12:05:00.000Z',
    })),
  };
  const output = formatFleetStatus(snapshot, {showBots: true, now});
  assert.match(output, /configLoadedAt=2026-11-09T12:00:00.000Z/);
  assert.match(output, /lastConfigOutcome=reloaded@2026-11-09T12:05:00.000Z/);
});
```

`statusFixture()`'s `botStates` entries get `configLoadedAt: null, lastConfigOutcome: null, lastConfigOutcomeAt: null` added in Step 3 along with the other full-snapshot fixtures.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test fleet/botOperations.test.ts fleet/logOverrides.test.ts fleet/status.test.ts`
Expected: FAIL (`operations.recordConfigLoaded is not a function`; type error or rejection for the live lookup; missing `configLoadedAt=` in output).

- [ ] **Step 3: Implement**

In `fleet/botOperations.ts`:

```ts
export type ConfigOutcome =
  | 'started'
  | 'reloaded'
  | 'reload-rejected'
  | 'reload-failed-restored'
  | 'start-failed';
```

Add to `BotOperationalSnapshot`:

```ts
  configLoadedAt: string | null;
  lastConfigOutcome: ConfigOutcome | null;
  lastConfigOutcomeAt: string | null;
```

Add fields and methods to `BotOperations`:

```ts
  private configLoadedAt: string | null = null;
  private lastConfigOutcome: ConfigOutcome | null = null;
  private lastConfigOutcomeAt: string | null = null;

  recordConfigLoaded(): void {
    this.configLoadedAt = this.now().toISOString();
  }

  recordConfigOutcome(outcome: ConfigOutcome): void {
    this.lastConfigOutcome = outcome;
    this.lastConfigOutcomeAt = this.now().toISOString();
  }
```

and in `snapshot()` after `counters`:

```ts
      configLoadedAt: this.configLoadedAt,
      lastConfigOutcome: this.lastConfigOutcome,
      lastConfigOutcomeAt: this.lastConfigOutcomeAt,
```

Existing tests that `deepEqual` a full snapshot (in `botOperations.test.ts`, `statusSnapshot.test.ts`, `fleetOperationsRuntime.test.ts`) now fail on the three new keys: add `configLoadedAt: null, lastConfigOutcome: null, lastConfigOutcomeAt: null` to those expected objects.

In `fleet/status.ts`, `isFleetBotStatus` gains (older snapshots without the fields stay valid):

```ts
    (value.configLoadedAt === undefined || isNullableTimestamp(value.configLoadedAt)) &&
    (value.lastConfigOutcomeAt === undefined || isNullableTimestamp(value.lastConfigOutcomeAt)) &&
    (value.lastConfigOutcome === undefined ||
      value.lastConfigOutcome === null ||
      typeof value.lastConfigOutcome === 'string') &&
```

and `formatBotStatus` gains, before `effectiveLogLevel=`:

```ts
    `configLoadedAt=${bot.configLoadedAt ?? 'n/a'}`,
    `lastConfigOutcome=${
      bot.lastConfigOutcome ? `${bot.lastConfigOutcome}@${bot.lastConfigOutcomeAt}` : 'n/a'
    }`,
```

In `fleet/logOverrides.ts`, change every `knownBotIds: ReadonlySet<string>` (the `readValidOverrides` parameter and the `LogOverrideWatcher` options field) to:

```ts
knownBotIds: {has(botId: string): boolean}
```

In `fleet/fleetOperationsRuntime.ts:45`, replace `knownBotIds: new Set(options.operations.keys()),` with:

```ts
      // Live view: runFleet adds and removes bots at runtime (config reload).
      knownBotIds: {has: botId => options.operations.has(botId)},
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test fleet/botOperations.test.ts fleet/logOverrides.test.ts fleet/status.test.ts fleet/statusSnapshot.test.ts fleet/fleetOperationsRuntime.test.ts && yarn typecheck`
Expected: PASS; typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
npx eslint --fix fleet/botOperations.ts fleet/status.ts fleet/logOverrides.ts fleet/fleetOperationsRuntime.ts fleet/*.test.ts
git add fleet/
git commit -m "feat(fleet): track config load and reload outcome per bot; live bot ids for log overrides"
```

---

### Task 5: The config reconciler

**Files:**
- Create: `fleet/configReconciler.ts`
- Test: `fleet/configReconciler.test.ts`

**Interfaces:**
- Consumes: `BotFingerprint`, `changedFields` (Task 1); `ReloadRequests` (Task 2); `ConfigOutcome` (Task 4); `Logger`, `formatDebugError` from `shared/logging/logger.ts`.
- Produces:
  - `type StopReason = 'reload' | 'disabled' | 'directory removed'`
  - `interface RunningBotConfig<Spec> {hash: string; fields: Record<string, string>; spec: Spec}`
  - `interface ConfigReconcilerOptions<Spec>` (see code)
  - `class ConfigReconciler<Spec>` with `constructor(options, running: Map<string, RunningBotConfig<Spec>>, failed: Map<string, string>)`, `tick(): Promise<void>`, `start(intervalMs?: number): void`, `stop(): Promise<void>`

`running` holds bots active after the initial activation, with the fingerprint taken when the fleet loaded their config (so edits made during the ~30 min activation are still detected). `failed` maps a bot id to the hash that failed to start; that exact config is not retried until it changes or is explicitly requested.

- [ ] **Step 1: Write the failing tests**

```ts
// fleet/configReconciler.test.ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Logger, type LogRecord} from '../shared/logging/logger.ts';
import type {BotFingerprint} from './botFingerprint.ts';
import {NO_RELOAD_REQUESTS, type ReloadRequests} from './reloadRequests.ts';
import type {ConfigOutcome} from './botOperations.ts';
import {ConfigReconciler, type RunningBotConfig, type StopReason} from './configReconciler.ts';

interface Spec {
  botId: string;
  hash: string;
}

function fp(botId: string, hash: string, extra: Partial<{enabled: boolean; fields: Record<string, string>}> = {}): BotFingerprint {
  return {ok: true, botId, enabled: extra.enabled ?? true, hash, fields: extra.fields ?? {feedUrl: hash}};
}

function harness(initial: Record<string, string> = {}) {
  const disk = new Map<string, BotFingerprint>();
  const calls: string[] = [];
  const outcomes: [string, ConfigOutcome][] = [];
  const records: LogRecord[] = [];
  const state = {
    secretsError: undefined as Error | undefined,
    loadErrors: new Map<string, Error>(),
    startFailures: new Set<string>(), // hashes that fail to start
    requests: NO_RELOAD_REQUESTS as ReloadRequests,
    startGate: undefined as Promise<void> | undefined,
  };
  const running = new Map<string, RunningBotConfig<Spec>>();
  for (const [botId, hash] of Object.entries(initial)) {
    disk.set(botId, fp(botId, hash));
    running.set(botId, {hash, fields: {feedUrl: hash}, spec: {botId, hash}});
  }
  const failed = new Map<string, string>();
  const reconciler = new ConfigReconciler<Spec>(
    {
      readSecrets: () => {
        if (state.secretsError) throw state.secretsError;
        return {};
      },
      listBotIds: () => [...disk.keys()].sort(),
      fingerprint: (_secrets, botId) => disk.get(botId)!,
      loadSpec: (_secrets, botId) => {
        const error = state.loadErrors.get(botId);
        if (error) throw error;
        const current = disk.get(botId)!;
        return {botId, hash: current.ok ? current.hash : 'x'};
      },
      takeReloadRequests: () => {
        const requests = state.requests;
        state.requests = NO_RELOAD_REQUESTS;
        return {ok: true, requests};
      },
      startBot: async spec => {
        calls.push(`start ${spec.botId}@${spec.hash}`);
        if (state.startGate) await state.startGate;
        if (state.startFailures.has(spec.hash)) throw new Error('login rejected');
      },
      stopBot: async (botId: string, reason: StopReason) => {
        calls.push(`stop ${botId} (${reason})`);
      },
      recordOutcome: (botId, outcome) => outcomes.push([botId, outcome]),
      logger: new Logger({defaultLevel: 'debug', sink: (_line, record) => records.push(record)}),
    },
    running,
    failed,
  );
  const summaries = () => records.filter(r => r.level === 'summary').map(r => `${r.botId ?? ''} ${r.message}`);
  return {reconciler, disk, calls, outcomes, records, summaries, state, failed};
}

test('an unchanged running bot is left alone', async () => {
  const h = harness({a: 'h1'});
  await h.reconciler.tick();
  assert.deepEqual(h.calls, []);
});

test('a new enabled directory starts its bot', async () => {
  const h = harness();
  h.disk.set('a', fp('a', 'h1'));
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['start a@h1']);
  assert.deepEqual(h.outcomes, [['a', 'started']]);
  assert.ok(h.summaries().includes('a started'));
});

test('a changed fingerprint stops the old worker before starting the new one, naming changed fields', async () => {
  const h = harness({a: 'h1'});
  h.disk.set('a', fp('a', 'h2', {fields: {feedUrl: 'h2'}}));
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['stop a (reload)', 'start a@h2']);
  assert.deepEqual(h.outcomes, [['a', 'reloaded']]);
  assert.ok(h.summaries().includes('a reloaded: feedUrl changed'));
  await h.reconciler.tick();
  assert.equal(h.calls.length, 2); // applied hash is now the running one
});

test('a requested reload restarts an unchanged bot; "*" restarts every bot', async () => {
  const h = harness({a: 'h1', b: 'h2'});
  h.state.requests = {all: false, botIds: ['a']};
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['stop a (reload)', 'start a@h1']);
  assert.ok(h.summaries().includes('a reloaded (requested)'));
  h.calls.length = 0;
  h.state.requests = {all: true, botIds: []};
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['stop a (reload)', 'start a@h1', 'stop b (reload)', 'start b@h2']);
});

test('enabled:false stops the bot; enabled:true again starts it', async () => {
  const h = harness({a: 'h1'});
  h.disk.set('a', fp('a', 'h1-off', {enabled: false}));
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['stop a (disabled)']);
  h.disk.set('a', fp('a', 'h1'));
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['stop a (disabled)', 'start a@h1']);
});

test('a directory missing for one tick is tolerated; missing for two stops the bot', async () => {
  const h = harness({a: 'h1'});
  const saved = h.disk.get('a')!;
  h.disk.delete('a');
  await h.reconciler.tick();
  assert.deepEqual(h.calls, []);
  h.disk.set('a', saved);
  await h.reconciler.tick();
  h.disk.delete('a');
  await h.reconciler.tick();
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['stop a (directory removed)']);
});

test('an invalid config keeps the old bot running and is logged once', async () => {
  const h = harness({a: 'h1'});
  h.disk.set('a', {ok: false, botId: 'a', error: 'invalid bot.json'});
  await h.reconciler.tick();
  await h.reconciler.tick();
  await h.reconciler.tick();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.summaries().filter(s => s.includes('rejected')), ['a reload rejected: invalid bot.json']);
});

test('a config that fails to load (e.g. missing secret) keeps the old bot and is logged once', async () => {
  const h = harness({a: 'h1'});
  h.disk.set('a', fp('a', 'h2'));
  h.state.loadErrors.set('a', new Error('No secret found for secretKey "a"'));
  await h.reconciler.tick();
  await h.reconciler.tick();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.outcomes, [['a', 'reload-rejected']]);
  assert.equal(h.summaries().filter(s => s.includes('rejected')).length, 1);
});

test('a reload whose new worker fails to start restores the previous config and is not retried', async () => {
  const h = harness({a: 'h1'});
  h.disk.set('a', fp('a', 'h2'));
  h.state.startFailures.add('h2');
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['stop a (reload)', 'start a@h2', 'start a@h1']);
  assert.deepEqual(h.outcomes, [['a', 'reload-failed-restored']]);
  assert.ok(h.summaries().includes('a reload failed, previous config restored'));
  await h.reconciler.tick();
  assert.equal(h.calls.length, 3); // same failing config is not retried
  h.disk.set('a', fp('a', 'h3'));
  await h.reconciler.tick();
  assert.deepEqual(h.calls.slice(3), ['stop a (reload)', 'start a@h3']);
});

test('a bot that failed at startup is retried only when its config changes or is requested', async () => {
  const h = harness();
  h.disk.set('a', fp('a', 'h1'));
  h.failed.set('a', 'h1');
  await h.reconciler.tick();
  assert.deepEqual(h.calls, []);
  h.state.requests = {all: false, botIds: ['a']};
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['start a@h1']);
});

test('a broken secrets file stops nothing and is logged once', async () => {
  const h = harness({a: 'h1'});
  h.state.secretsError = new Error('Unexpected token');
  h.disk.delete('a');
  await h.reconciler.tick();
  await h.reconciler.tick();
  await h.reconciler.tick();
  assert.deepEqual(h.calls, []);
  assert.equal(h.summaries().filter(s => s.includes('secrets')).length, 1);
});

test('overlapping ticks are skipped, and stop() waits for the tick in flight', async () => {
  const h = harness();
  h.disk.set('a', fp('a', 'h1'));
  let release!: () => void;
  h.state.startGate = new Promise(resolve => (release = resolve));
  const first = h.reconciler.tick();
  await h.reconciler.tick(); // skipped: first is still running
  assert.deepEqual(h.calls, ['start a@h1']);
  let stopped = false;
  const stopping = h.reconciler.stop().then(() => (stopped = true));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(stopped, false);
  release();
  await first;
  await stopping;
  assert.equal(stopped, true);
});

test('log lines never contain config values', async () => {
  const h = harness({a: 'h1'});
  h.disk.set('a', fp('a', 'h2', {fields: {feedUrl: 'https://x.test/?token=SECRETVALUE'}}));
  await h.reconciler.tick();
  assert.ok(h.records.every(r => !r.message.includes('SECRETVALUE')));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test fleet/configReconciler.test.ts`
Expected: FAIL with `Cannot find module './configReconciler.ts'`.

- [ ] **Step 3: Implement**

```ts
// fleet/configReconciler.ts
// Applies per-bot config changes while the fleet runs: every 10 s it fingerprints each bot's
// config, compares with what is running, and starts, stops, or restarts only the bots that
// differ, one at a time. See documentation/specs/2026-11-09-fleet-config-reload-design.md.
import {Logger, formatDebugError} from '../shared/logging/logger.ts';
import {changedFields, type BotFingerprint} from './botFingerprint.ts';
import type {ReloadRequests} from './reloadRequests.ts';
import type {ConfigOutcome} from './botOperations.ts';

export type StopReason = 'reload' | 'disabled' | 'directory removed';

export interface RunningBotConfig<Spec> {
  hash: string;
  fields: Record<string, string>;
  spec: Spec;
}

export interface ConfigReconcilerOptions<Spec> {
  readSecrets(): Record<string, string>;
  listBotIds(): string[];
  fingerprint(secrets: Readonly<Record<string, string>>, botId: string): BotFingerprint;
  loadSpec(secrets: Readonly<Record<string, string>>, botId: string): Spec;
  takeReloadRequests(): {ok: true; requests: ReloadRequests} | {ok: false; error: string};
  startBot(spec: Spec): Promise<void>;
  stopBot(botId: string, reason: StopReason): Promise<void>;
  recordOutcome(botId: string, outcome: ConfigOutcome): void;
  logger: Logger;
}

const DEFAULT_INTERVAL_MS = 10_000;
const MISSING_TICKS_BEFORE_STOP = 2;

// A message we can log safely: never a parser message (it may quote file content).
function describe(error: unknown): string {
  if (error instanceof SyntaxError) return 'invalid JSON';
  return error instanceof Error ? error.message : String(error);
}

export class ConfigReconciler<Spec> {
  private readonly missingTicks = new Map<string, number>();
  private readonly rejectedLogged = new Map<string, string>(); // botId -> rejection key
  private readonly warned = new Set<string>(); // fleet-level warnings already logged
  private ticking = false;
  private inFlight: Promise<void> = Promise.resolve();
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly options: ConfigReconcilerOptions<Spec>,
    private readonly running: Map<string, RunningBotConfig<Spec>>,
    private readonly failed: Map<string, string>,
  ) {}

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    // tick() records inFlight itself, and only when it actually runs: assigning the result here
    // would let a skipped tick replace the real in-flight promise that stop() waits on.
    this.interval = setInterval(() => void this.tick(), intervalMs);
  }

  async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    await this.inFlight;
  }

  async tick(): Promise<void> {
    if (this.ticking) return; // the previous tick is still applying changes
    this.ticking = true;
    const current = this.reconcile().finally(() => {
      this.ticking = false;
    });
    this.inFlight = current;
    await current;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.options.logger.summary('CONFIG', message);
  }

  private async reconcile(): Promise<void> {
    const {logger} = this.options;
    let secrets: Record<string, string>;
    let botIds: string[];
    try {
      secrets = this.options.readSecrets();
      this.warned.delete('secrets');
    } catch {
      this.warnOnce('secrets', 'secrets file unreadable or invalid; config changes paused, all bots keep running');
      return;
    }
    try {
      botIds = this.options.listBotIds();
      this.warned.delete('bots');
    } catch {
      this.warnOnce('bots', 'bots directory unreadable; config changes paused, all bots keep running');
      return;
    }
    const taken = this.options.takeReloadRequests();
    let requests: ReloadRequests = {all: false, botIds: []};
    if (taken.ok) {
      requests = taken.requests;
    } else {
      logger.summary('CONFIG', `reload requests ignored: ${taken.error}`);
    }

    const onDisk = new Set(botIds);
    for (const botId of [...this.running.keys()]) {
      if (onDisk.has(botId)) continue;
      const missing = (this.missingTicks.get(botId) ?? 0) + 1;
      this.missingTicks.set(botId, missing);
      if (missing >= MISSING_TICKS_BEFORE_STOP) await this.stop_(botId, 'directory removed');
    }

    for (const botId of botIds) {
      this.missingTicks.delete(botId);
      const requested = requests.all || requests.botIds.includes(botId);
      const fingerprint = this.options.fingerprint(secrets, botId);
      const running = this.running.get(botId);

      if (!fingerprint.ok) {
        this.reject(botId, `error:${fingerprint.error}`, fingerprint.error, Boolean(running));
        continue;
      }
      if (!fingerprint.enabled) {
        this.failed.delete(botId);
        if (running) await this.stop_(botId, 'disabled');
        continue;
      }
      if (running) {
        if (fingerprint.hash === running.hash && !requested) continue;
        if (this.failed.get(botId) === fingerprint.hash && !requested) continue;
        await this.restart(botId, fingerprint, running, secrets, requested);
      } else {
        if (this.failed.get(botId) === fingerprint.hash && !requested) continue;
        await this.start_(botId, fingerprint, secrets);
      }
    }
  }

  private reject(botId: string, key: string, reason: string, isRunning: boolean): void {
    if (this.rejectedLogged.get(botId) === key) return;
    this.rejectedLogged.set(botId, key);
    this.options.logger.summary(
      'CONFIG',
      isRunning ? `reload rejected: ${reason}` : `not started: ${reason}`,
      botId,
    );
    this.options.recordOutcome(botId, 'reload-rejected');
  }

  private loadSpec(botId: string, fingerprint: BotFingerprint & {ok: true}, secrets: Record<string, string>, isRunning: boolean): Spec | undefined {
    try {
      return this.options.loadSpec(secrets, botId);
    } catch (error) {
      this.reject(botId, `load:${fingerprint.hash}`, describe(error), isRunning);
      this.failed.set(botId, fingerprint.hash);
      return undefined;
    }
  }

  private async start_(botId: string, fingerprint: BotFingerprint & {ok: true}, secrets: Record<string, string>): Promise<void> {
    const spec = this.loadSpec(botId, fingerprint, secrets, false);
    if (spec === undefined) return;
    try {
      await this.options.startBot(spec);
    } catch (error) {
      this.failed.set(botId, fingerprint.hash);
      this.options.logger.summary('CONFIG', 'failed to start', botId);
      this.options.logger.debug('CONFIG', formatDebugError(error), botId);
      this.options.recordOutcome(botId, 'start-failed');
      return;
    }
    this.running.set(botId, {hash: fingerprint.hash, fields: fingerprint.fields, spec});
    this.failed.delete(botId);
    this.rejectedLogged.delete(botId);
    this.options.logger.summary('CONFIG', 'started', botId);
    this.options.recordOutcome(botId, 'started');
  }

  private async restart(
    botId: string,
    fingerprint: BotFingerprint & {ok: true},
    previous: RunningBotConfig<Spec>,
    secrets: Record<string, string>,
    requested: boolean,
  ): Promise<void> {
    const spec = this.loadSpec(botId, fingerprint, secrets, true);
    if (spec === undefined) return; // the old worker keeps running
    await this.options.stopBot(botId, 'reload');
    try {
      await this.options.startBot(spec);
    } catch (error) {
      this.failed.set(botId, fingerprint.hash);
      this.options.logger.debug('CONFIG', formatDebugError(error), botId);
      try {
        await this.options.startBot(previous.spec);
        this.options.logger.summary('CONFIG', 'reload failed, previous config restored', botId);
        this.options.recordOutcome(botId, 'reload-failed-restored');
      } catch (rollbackError) {
        this.running.delete(botId);
        this.options.logger.summary('CONFIG', 'reload failed and previous config failed too; bot stopped', botId);
        this.options.logger.debug('CONFIG', formatDebugError(rollbackError), botId);
        this.options.recordOutcome(botId, 'start-failed');
      }
      return;
    }
    const changed = changedFields(previous.fields, fingerprint.fields);
    this.running.set(botId, {hash: fingerprint.hash, fields: fingerprint.fields, spec});
    this.failed.delete(botId);
    this.rejectedLogged.delete(botId);
    this.options.logger.summary(
      'CONFIG',
      changed.length > 0 ? `reloaded: ${changed.join(', ')} changed` : requested ? 'reloaded (requested)' : 'reloaded',
      botId,
    );
    this.options.recordOutcome(botId, 'reloaded');
  }

  private async stop_(botId: string, reason: StopReason): Promise<void> {
    await this.options.stopBot(botId, reason);
    this.running.delete(botId);
    this.missingTicks.delete(botId);
    this.options.logger.summary('CONFIG', `stopped (${reason})`, botId);
  }
}
```

Note on the log assertions: `Logger.summary(scope, message, botId)` puts the bot id in `record.botId`, which the test harness prefixes, so `'a started'` matches `summary('CONFIG', 'started', 'a')`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test fleet/configReconciler.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
npx eslint --fix fleet/configReconciler.ts fleet/configReconciler.test.ts
git add fleet/configReconciler.ts fleet/configReconciler.test.ts
git commit -m "feat(fleet): config reconciler that starts, stops, and restarts changed bots"
```

---

### Task 6: Bot lifecycle and fleet wiring

**Files:**
- Create: `fleet/botLifecycle.ts`
- Test: `fleet/botLifecycle.test.ts`
- Modify: `fleet/configLoader.ts` (`export function loadOneBot`)
- Modify: `fleet/runFleet.ts`, `fleet/runFleet.test.ts` (remove the `shouldAssignNotifier` test and import)

**Interfaces:**
- Consumes: `AuthCoordinator.addWorker/removeWorker/recordFailure/forgetFailure`, `NotifierClaims` (Task 3); `BotOperations.recordConfigLoaded` (Task 4); `ConfigReconciler`, `StopReason`, `RunningBotConfig` (Task 5); `fingerprintBot`, `listBotIds` (Task 1); `reloadRequestsPath`, `takeReloadRequests` (Task 2); `loadOneBot(configRoot, dataRoot, secrets, botId): BotSpec`.
- Produces:
  - `createBotLifecycle(options: BotLifecycleOptions): BotLifecycle`
  - `interface BotLifecycle {build(spec: BotSpec): Promise<BotWorker>; startBot(spec: BotSpec): Promise<void>; stopBot(botId: string, reason: StopReason): Promise<void>}`

- [ ] **Step 1: Write the failing tests**

```ts
// fleet/botLifecycle.test.ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Logger, type LogRecord} from '../shared/logging/logger.ts';
import {AuthCoordinator} from './authCoordinator.ts';
import {BotOperations} from './botOperations.ts';
import {BotStore} from './botStore.ts';
import type {BotWorker} from './botWorker.ts';
import type {BotSpec} from './configLoader.ts';
import {NotifierClaims} from './notifierClaims.ts';
import {createBotLifecycle} from './botLifecycle.ts';

function spec(botId: string, identifier: string, dbPath: string): BotSpec {
  return {
    botId,
    identifier,
    appPassword: 'pw',
    instanceUrl: 'https://bsky.social',
    feedUrl: 'https://example.test/feed.xml',
    fetchIntervalMinutes: 5,
    dbPath,
    feedReaderConfig: {string: '$title'},
    schedulerConfig: {adaptiveSpacing: false, spacingWindow: 600, minSpacing: 1, maxSpacing: 60},
  } as BotSpec;
}

// A worker that, like the real one, owns its BotStore and closes it on shutdown.
function storeWorker(s: BotSpec): BotWorker & {store: BotStore} {
  const store = new BotStore(s.dbPath);
  return {botId: s.botId, store, shutdown: async () => store.close()} as unknown as BotWorker & {store: BotStore};
}

function setup(t: {after(callback: () => void): void}) {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const records: LogRecord[] = [];
  const logger = new Logger({defaultLevel: 'debug', sink: (_line, record) => records.push(record)});
  const coordinator = new AuthCoordinator({logger, bots: [], staggerSeconds: 0, activateBot: async () => {
    throw new Error('unused');
  }});
  const operations = new Map<string, BotOperations>();
  const claims = new NotifierClaims();
  const notified: string[] = [];
  const failing = new Set<string>();
  const workers = new Map<string, BotWorker & {store: BotStore}>();
  const lifecycle = createBotLifecycle({
    coordinator,
    operations,
    claims,
    buildWorker: async (s, notify) => {
      if (failing.has(s.botId)) throw new Error('login rejected');
      if (notify) notified.push(s.botId);
      const worker = storeWorker(s);
      workers.set(s.botId, worker);
      return worker;
    },
    shutdownTimeoutMs: 1000,
    logger,
  });
  return {dir, records, coordinator, operations, claims, notified, failing, workers, lifecycle};
}

test('startBot registers the worker, creates operations, and records config loaded', async t => {
  const s = setup(t);
  await s.lifecycle.startBot(spec('a', 'a.bsky.social', join(s.dir, 'a.sqlite')));
  assert.deepEqual(s.coordinator.activeWorkers().map(w => w.botId), ['a']);
  assert.ok(s.operations.get('a')?.snapshot().configLoadedAt);
  assert.deepEqual(s.notified, ['a']);
  await s.lifecycle.stopBot('a', 'disabled');
});

test('a failed start records an activation failure and releases the notifier claim', async t => {
  const s = setup(t);
  s.failing.add('a');
  await assert.rejects(s.lifecycle.startBot(spec('a', 'shared.bsky.social', join(s.dir, 'a.sqlite'))));
  assert.deepEqual(s.coordinator.activationFailures().map(f => f.botId), ['a']);
  await s.lifecycle.startBot(spec('b', 'shared.bsky.social', join(s.dir, 'b.sqlite')));
  assert.deepEqual(s.notified, ['b']); // the role was free for the sibling
  await s.lifecycle.stopBot('b', 'disabled');
});

test('stopping a disabled bot drops its operations; a reload keeps them', async t => {
  const s = setup(t);
  await s.lifecycle.startBot(spec('a', 'a.bsky.social', join(s.dir, 'a.sqlite')));
  await s.lifecycle.stopBot('a', 'reload');
  assert.ok(s.operations.has('a'));
  await s.lifecycle.startBot(spec('a', 'a.bsky.social', join(s.dir, 'a.sqlite')));
  await s.lifecycle.stopBot('a', 'disabled');
  assert.equal(s.operations.has('a'), false);
  assert.deepEqual(s.coordinator.activeWorkers(), []);
});

test('stopping the notifier holder logs that the account’s notifications pause', async t => {
  const s = setup(t);
  await s.lifecycle.startBot(spec('a', 'shared.bsky.social', join(s.dir, 'a.sqlite')));
  await s.lifecycle.stopBot('a', 'disabled');
  assert.ok(s.records.some(r => r.message.includes('notifications for @shared.bsky.social paused')));
});

test('a reload swaps workers on the same store: queue, cursor, and dedup history survive', async t => {
  const s = setup(t);
  const dbPath = join(s.dir, 'a.sqlite');
  await s.lifecycle.startBot(spec('a', 'a.bsky.social', dbPath));
  const before = s.workers.get('a')!.store;
  before.enqueue({
    title: 't',
    content: 'queued before reload',
    embedJson: null,
    languagesJson: null,
    facetsJson: null,
    itemDate: '2026-11-09T12:00:00.000Z',
    dedupeKey: 'k1',
  });
  before.writeCursor(new Date('2026-11-09T11:00:00.000Z'));
  before.writeSeenValue('https://example.test/seen');
  await s.lifecycle.stopBot('a', 'reload');
  await s.lifecycle.startBot(spec('a', 'a.bsky.social', dbPath));
  const after = s.workers.get('a')!.store;
  assert.notEqual(after, before);
  assert.equal(after.countQueued(), 1);
  assert.equal(after.readCursor(), '2026-11-09T11:00:00.000Z');
  assert.equal(after.seenValueExists('https://example.test/seen'), true);
  await s.lifecycle.stopBot('a', 'disabled');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test fleet/botLifecycle.test.ts`
Expected: FAIL with `Cannot find module './botLifecycle.ts'`.

- [ ] **Step 3: Implement `fleet/botLifecycle.ts`**

```ts
// fleet/botLifecycle.ts
// Starts and stops one bot at runtime (initial activation and config reloads), keeping the
// coordinator's worker list, the per-bot operations map, and notifier claims in step.
import {Logger} from '../shared/logging/logger.ts';
import type {AuthCoordinator} from './authCoordinator.ts';
import {BotOperations} from './botOperations.ts';
import type {BotWorker} from './botWorker.ts';
import type {BotSpec} from './configLoader.ts';
import type {NotifierClaims} from './notifierClaims.ts';
import type {StopReason} from './configReconciler.ts';

export interface BotLifecycleOptions {
  coordinator: AuthCoordinator;
  operations: Map<string, BotOperations>;
  claims: NotifierClaims;
  buildWorker: (spec: BotSpec, notify: boolean) => Promise<BotWorker>;
  shutdownTimeoutMs: number;
  logger: Logger;
}

export interface BotLifecycle {
  build(spec: BotSpec): Promise<BotWorker>;
  startBot(spec: BotSpec): Promise<void>;
  stopBot(botId: string, reason: StopReason): Promise<void>;
}

export function createBotLifecycle(options: BotLifecycleOptions): BotLifecycle {
  async function build(spec: BotSpec): Promise<BotWorker> {
    let operations = options.operations.get(spec.botId);
    if (!operations) {
      operations = new BotOperations(spec.botId);
      options.operations.set(spec.botId, operations);
    }
    const notify = options.claims.claim(spec.botId, spec.identifier);
    try {
      const worker = await options.buildWorker(spec, notify);
      operations.recordConfigLoaded();
      return worker;
    } catch (error) {
      if (notify) options.claims.release(spec.botId);
      throw error;
    }
  }

  return {
    build,

    async startBot(spec: BotSpec): Promise<void> {
      let worker: BotWorker;
      try {
        worker = await build(spec);
      } catch (error) {
        options.coordinator.recordFailure(spec.botId, String(error));
        throw error;
      }
      options.coordinator.addWorker(worker);
    },

    async stopBot(botId: string, reason: StopReason): Promise<void> {
      const worker = options.coordinator.removeWorker(botId);
      if (worker) await worker.shutdown(options.shutdownTimeoutMs);
      const releasedIdentifier = options.claims.release(botId);
      if (reason === 'reload') return; // the same bot starts again right away
      options.operations.delete(botId);
      options.coordinator.forgetFailure(botId);
      if (releasedIdentifier) {
        options.logger.summary(
          'CONFIG',
          `notifications for @${releasedIdentifier} paused until another config for it starts`,
          botId,
        );
      }
    },
  };
}
```

- [ ] **Step 4: Run the lifecycle tests to verify they pass**

Run: `npx tsx --test fleet/botLifecycle.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Export `loadOneBot`**

In `fleet/configLoader.ts`, change `function loadOneBot(` to `export function loadOneBot(`.

- [ ] **Step 6: Wire `fleet/runFleet.ts`**

1. Imports: add
   ```ts
   import {readFileSync} from 'node:fs';
   import {fingerprintBot, listBotIds, type BotFingerprint} from './botFingerprint.ts';
   import {ConfigReconciler, type RunningBotConfig} from './configReconciler.ts';
   import {createBotLifecycle} from './botLifecycle.ts';
   import {NotifierClaims} from './notifierClaims.ts';
   import {reloadRequestsPath, takeReloadRequests} from './reloadRequests.ts';
   ```
   and add `loadOneBot` to the existing `./configLoader.ts` import.
2. Delete `shouldAssignNotifier` and its doc comment. `buildWorker` keeps its signature; it already receives `ntfyUrl: string | undefined`.
3. Right after `const {fleetConfig, bots, errors} = loadFleet(...)` and its logging, capture what was loaded, so edits made during the ~30 min staggered activation are still detected later:
   ```ts
   const readSecrets = (): Record<string, string> =>
     JSON.parse(readFileSync(secretsFilePath, 'utf-8')) as Record<string, string>;
   const startupFingerprints = new Map<string, BotFingerprint>();
   try {
     const startupSecrets = readSecrets();
     for (const botId of listBotIds(configRoot)) {
       startupFingerprints.set(botId, fingerprintBot(configRoot, startupSecrets, botId));
     }
   } catch {
     // loadFleet already succeeded with these files; a race here only means a bot may be reloaded once.
   }
   ```
4. Replace `const notifiedIdentities = new Set<string>();` with `const claims = new NotifierClaims();`, and make `operations` a mutable `Map<string, BotOperations>` (it already is one; keep it).
5. Keep `const coordinator = new AuthCoordinator({...})` where it is, but replace its `activateBot` body with `activateBot: spec => lifecycle.build(spec),` (the closure only runs inside `coordinator.start()`, after `lifecycle` below exists). Then, right after the coordinator, create the lifecycle:
   ```ts
   const lifecycle = createBotLifecycle({
     coordinator,
     operations,
     claims,
     buildWorker: (spec, notify) =>
       buildWorker(
         spec,
         sharedLimiters,
         operations.get(spec.botId)!,
         logger,
         dryRun,
         fleetConfig.runIntervalSeconds,
         fleetConfig.freshness,
         fleetConfig.perBotQueueMaxLength,
         getIdentityStore(spec.identifier),
         notify ? ntfyUrl : undefined,
         ntfyToken,
       ),
     shutdownTimeoutMs: shutdownPerBotTimeoutMs,
     logger,
   });
   ```
6. Declare `let reconciler: ConfigReconciler<BotSpec> | undefined;` next to `let shuttingDown = false;`, and in `shutdown()` add `await reconciler?.stop();` right after `coordinator.abortActivation();`.
7. After `await coordinator.start();`, inside the existing `if (!shuttingDown) {` block, start the reconciler:
   ```ts
   const active = new Set(coordinator.activeWorkers().map(worker => worker.botId));
   const running = new Map<string, RunningBotConfig<BotSpec>>();
   for (const spec of bots) {
     const fingerprint = startupFingerprints.get(spec.botId);
     if (active.has(spec.botId) && fingerprint?.ok) {
       running.set(spec.botId, {hash: fingerprint.hash, fields: fingerprint.fields, spec});
     }
   }
   // Bots that failed activation or had invalid config: not retried until their config changes.
   const failed = new Map<string, string>();
   for (const [botId, fingerprint] of startupFingerprints) {
     if (fingerprint.ok && fingerprint.enabled && !active.has(botId)) failed.set(botId, fingerprint.hash);
   }
   reconciler = new ConfigReconciler<BotSpec>(
     {
       readSecrets,
       listBotIds: () => listBotIds(configRoot),
       fingerprint: (secrets, botId) => fingerprintBot(configRoot, secrets, botId),
       loadSpec: (secrets, botId) => loadOneBot(configRoot, dataRoot, secrets, botId),
       takeReloadRequests: () => takeReloadRequests(reloadRequestsPath(dataRoot)),
       startBot: spec => lifecycle.startBot(spec),
       stopBot: (botId, reason) => lifecycle.stopBot(botId, reason),
       recordOutcome: (botId, outcome) => operations.get(botId)?.recordConfigOutcome(outcome),
       logger,
     },
     running,
     failed,
   );
   reconciler.start();
   logger.summary('FLEET', 'Config reload active: bot config changes apply within ~10s');
   ```
8. In `fleet/runFleet.test.ts`, delete the `shouldAssignNotifier` test and remove it from the import.

- [ ] **Step 7: Verify**

Run: `yarn typecheck && yarn lint && HEALTH_CHECK_PORT=18080 yarn test`
Expected: typecheck and lint exit 0; all tests pass.

- [ ] **Step 8: Smoke-test the image locally**

Run: `docker build -q -t bsky-rss:reload . && .github/scripts/smoke-image.sh bsky-rss:reload`
Expected: three `ok:` lines (the fleet entry point still loads its whole import graph and stops at the missing config).

- [ ] **Step 9: Commit**

```bash
npx eslint --fix fleet/botLifecycle.ts fleet/botLifecycle.test.ts fleet/runFleet.ts fleet/runFleet.test.ts fleet/configLoader.ts
git add fleet/
git commit -m "feat(fleet): apply per-bot config changes at runtime via the config reconciler"
```

---

### Task 7: `yarn fleet:reload` CLI and documentation

**Files:**
- Create: `fleet/reloadControl.ts`
- Test: `fleet/reloadControl.test.ts`
- Modify: `package.json` (scripts), `documentation/fleet.md`, `CHANGELOG.md` (`[Unreleased]`)

**Interfaces:**
- Consumes: `addReloadRequest`, `reloadRequestsPath` (Task 2); `listBotIds` (Task 1).
- Produces: `runReloadControl(args: string[], options: {configRoot: string; dataRoot: string}): string`

- [ ] **Step 1: Write the failing tests**

```ts
// fleet/reloadControl.test.ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reloadRequestsPath, takeReloadRequests} from './reloadRequests.ts';
import {runReloadControl} from './reloadControl.ts';

function roots(t: {after(callback: () => void): void}) {
  const root = mkdtempSync(join(tmpdir(), 'reload-control-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const configRoot = join(root, 'config');
  const dataRoot = join(root, 'data');
  mkdirSync(join(configRoot, 'bots', 'skyfleet-en'), {recursive: true});
  mkdirSync(dataRoot, {recursive: true});
  return {configRoot, dataRoot};
}

test('requests a reload for an existing bot directory', t => {
  const r = roots(t);
  assert.equal(runReloadControl(['skyfleet-en'], r), 'reload requested for skyfleet-en; applied within ~10s');
  const taken = takeReloadRequests(reloadRequestsPath(r.dataRoot));
  assert.ok(taken.ok);
  assert.deepEqual(taken.requests.botIds, ['skyfleet-en']);
});

test('--all requests every bot', t => {
  const r = roots(t);
  assert.equal(runReloadControl(['--all'], r), 'reload requested for all bots; applied within ~10s');
  const taken = takeReloadRequests(reloadRequestsPath(r.dataRoot));
  assert.ok(taken.ok && taken.requests.all);
});

test('an unknown bot or wrong arguments are rejected with usage', t => {
  const r = roots(t);
  assert.throws(() => runReloadControl(['nope'], r), /Unknown bot "nope"/);
  assert.throws(() => runReloadControl([], r), /Usage:/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test fleet/reloadControl.test.ts`
Expected: FAIL with `Cannot find module './reloadControl.ts'`.

- [ ] **Step 3: Implement**

```ts
// fleet/reloadControl.ts
// `yarn fleet:reload <bot-id> | --all`: asks the running fleet to reload one bot (or every bot)
// from its config files. The fleet's config reconciler applies it within ~10 s.
import {basename} from 'node:path';
import {listBotIds} from './botFingerprint.ts';
import {addReloadRequest, reloadRequestsPath} from './reloadRequests.ts';

const usage = (executable: string): string =>
  [`Usage: ${executable} <bot-id>`, `       ${executable} --all`].join('\n');

export function runReloadControl(
  args: string[],
  options: {configRoot: string; dataRoot: string},
): string {
  const path = reloadRequestsPath(options.dataRoot);
  if (args.length === 1 && args[0] === '--all') {
    addReloadRequest(path, '*');
    return 'reload requested for all bots; applied within ~10s';
  }
  if (args.length === 1 && args[0] && !args[0].startsWith('-')) {
    const botId = args[0];
    if (!listBotIds(options.configRoot).includes(botId)) {
      throw new Error(`Unknown bot "${botId}" (no directory in ${options.configRoot}/bots)`);
    }
    addReloadRequest(path, botId);
    return `reload requested for ${botId}; applied within ~10s`;
  }
  throw new Error(usage('fleet:reload'));
}

if (import.meta.main) {
  try {
    console.log(
      runReloadControl(process.argv.slice(2), {
        configRoot: process.env.FLEET_CONFIG_ROOT ?? './config.example',
        dataRoot: process.env.FLEET_DATA_ROOT ?? './data/fleet',
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage(basename(process.argv[1] ?? 'reloadControl.ts')));
    process.exitCode = 1;
  }
}
```

`import.meta.main` is the same direct-execution check `fleet/logControl.ts` uses (`if (import.meta.main) main();`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test fleet/reloadControl.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Script and docs**

`package.json` scripts, after `"fleet:log"`:

```json
    "fleet:reload": "NODE_NO_WARNINGS=1 tsx ./fleet/reloadControl.ts",
```

`documentation/fleet.md`, new section after the log-override section:

```markdown
## Changing one bot without restarting the fleet

The fleet checks `config/bots/` every 10 seconds and applies changes to individual bots:

- **Edit** a bot's `bot.json` or `config.json`, or rotate its secret: that bot restarts with the
  new config. Nothing else is touched. Its queue, cursor, dedup history, and session are kept.
- **Add** a bot directory, or set `"enabled": true`: the bot starts.
- **Set `"enabled": false`** or remove the directory: the bot stops. (A directory has to be missing
  on two checks in a row before its bot stops, so a `git pull` or editor save can't stop it.)

A bad edit never takes a bot down: invalid JSON or a missing secret is logged
(`[CONFIG] <bot> reload rejected: ...`) and the bot keeps running its previous config. If the new
config fails to start (for example a rejected password), the previous config is started again.

To force a reload without editing anything:

    docker exec bsky-rss-fleet node --import tsx fleet/reloadControl.ts <bot-id>
    docker exec bsky-rss-fleet node --import tsx fleet/reloadControl.ts --all

The outcome appears in the logs and in `yarn fleet:status` (`configLoadedAt`, `lastConfigOutcome`).
`fleet.json` and environment variables still need a full restart.
```

`CHANGELOG.md` under `## [Unreleased]`:

```markdown
### Added
- **Per-bot config reload without restarting the fleet.** Changes to a bot's `bot.json`,
  `config.json`, or secret apply within ~10 s, only to that bot; bots can be added, enabled,
  disabled, or removed at runtime; `yarn fleet:reload <bot-id> | --all` forces a reload. A bad edit
  keeps the bot on its previous config. See `documentation/fleet.md`.
```

- [ ] **Step 6: Verify and commit**

Run: `yarn typecheck && yarn lint && HEALTH_CHECK_PORT=18080 yarn test`
Expected: all green.

```bash
npx eslint --fix fleet/reloadControl.ts fleet/reloadControl.test.ts
git add fleet/reloadControl.ts fleet/reloadControl.test.ts package.json documentation/fleet.md CHANGELOG.md
git commit -m "feat(fleet): fleet:reload command and docs for per-bot config reload"
```

---

### After merge (operator steps, not code)

- [ ] Release as a minor version (`yarn bump-version 2.16.0`, CHANGELOG entry, tag, deploy). The fleet must restart **once** to run the reconciler.
- [ ] Production check: change a value in `/home/skyfleet-next/config/bots/skyfleet-en/bot.json`, then confirm `[CONFIG] [skyfleet-en] reloaded: feedUrl changed` within ~10 s in `docker logs bsky-rss-fleet`, with no other bot reloading.
- [ ] Update the project `CLAUDE.md` (untracked, in the main checkout): replace the paragraph starting "Fleet mode has **no per-bot restart/reload capability**" with a note that per-bot config reload exists (`fleet/configReconciler.ts`, `yarn fleet:reload`), while `fleet.json` and environment changes still need a full restart.
