# Fleet Broadcast Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manually-run script (`yarn fleet:broadcast`) that queues the same maintenance/support message + link to every fleet account, by writing directly into each bot's existing `queue_items` table — the already-running fleet's own `BotWorker`/`Scheduler` then posts each one at that bot's already-tuned pace, so no new throttling code is needed.

**Architecture:** One new file, `fleet/broadcast.ts`, following `fleet/status.ts`/`fleet/logControl.ts`'s existing shape: small exported, unit-tested pure functions hold the real logic; a thin, untested `main()` (argv, the real confirmation prompt, the real `open-graph-scraper` call) is gated by `import.meta.main`.

**Tech Stack:** TypeScript (tsx, no build step), `open-graph-scraper` (already a dependency), `node:readline/promises`, `node:crypto`, `node:test` + `node:assert/strict`.

## Global Constraints

- **No CLI argument parsing beyond two boolean flags** (`--dry-run`, `--yes`) checked via plain `process.argv.includes(...)` — the operator edits `MESSAGE`/`LINK`/`EXCLUDE_BOT_IDS` constants directly in the file, per the design spec's explicit non-goal (no wizard, no argv-driven message input).
- **One Open Graph scrape total**, not per-bot — the message+link is identical across every target bot.
- **Zero new throttling/rate-limiting code.** Enqueuing writes to `BotStore` directly (the same `queue_items` table and `enqueue()` method regular RSS items use); posting timing and pacing come entirely from each bot's already-running `BotWorker`/`Scheduler`, untouched by this plan.
- **Deterministic dedupeKey**: `broadcast:` + SHA-256 hex digest of `message + link`, so re-running the script with unchanged text is a safe no-op per bot (existing `UNIQUE(dedupe_key)` constraint), and editing the text produces a genuinely new item.
- **Preview + typed confirmation before any write** (`Type BROADCAST to continue:`), unless `--yes` is passed. `--dry-run` stops right after the preview, before the confirmation prompt.
- **Per-bot failure isolation**: one bot's store failing to open, or `enqueue()` throwing, is caught, logged, and does not stop the loop over the remaining bots.
- **`perBotQueueMaxLength` is deliberately not enforced here** — accepted non-goal, this script bypasses `BotWorker` and writes to `BotStore` directly.
- **`DRY_RUN` is respected transitively, with no code in this file aware of it** — the eventual `BskyClient.post()` call (made later, by the already-running fleet) already handles it.
- **No new dependencies.**

---

### Task 1: `fleet/broadcast.ts` — dedupeKey, targeting, embed building, enqueue

**Files:**
- Create: `fleet/broadcast.ts`
- Test: `fleet/broadcast.test.ts`

**Interfaces:**
- Consumes: `BotSpec` (`fleet/configLoader.ts`, existing), `ParsedEmbed` (`fleet/feedReader.ts`, existing — `{uri: string; title: string; description?: string; imageUrl?: string; imageAlt?: string; type?: string}`), `BotStore` (`fleet/botStore.ts`, existing — `enqueue(item): number`, `close(): void`).
- Produces: `broadcastDedupeKey(message: string, link: string): string`, `targetBots(allBots: readonly BotSpec[], excludeBotIds: readonly string[]): BotSpec[]`, `OpenGraphResult` interface (`{ogImage?: {url: string}[]; ogDescription?: string; ogUrl?: string; ogTitle?: string}`), `buildBroadcastEmbed(ogResult: OpenGraphResult | undefined, link: string): ParsedEmbed | undefined`, `EnqueueBroadcastOutcome = 'enqueued' | 'duplicate'`, `enqueueBroadcast(store: BotStore, params: {title: string; message: string; embed: ParsedEmbed | undefined; dedupeKey: string}): EnqueueBroadcastOutcome` — all consumed by Task 2's `main()`.

- [ ] **Step 1: Write the failing tests**

Create `fleet/broadcast.test.ts`:

```typescript
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  broadcastDedupeKey,
  targetBots,
  buildBroadcastEmbed,
  enqueueBroadcast,
} from './broadcast.ts';
import {BotStore} from './botStore.ts';
import type {BotSpec} from './configLoader.ts';

function makeBotSpec(botId: string): BotSpec {
  return {
    botId,
    identifier: `${botId}.bsky.social`,
    appPassword: 'unused-in-this-test',
    instanceUrl: 'https://bsky.social',
    feedUrl: 'https://example.com/feed.xml',
    fetchIntervalMinutes: 5,
    dbPath: '/unused/in/this/test.sqlite',
    feedReaderConfig: {} as BotSpec['feedReaderConfig'],
    schedulerConfig: {} as BotSpec['schedulerConfig'],
  };
}

test('broadcastDedupeKey is deterministic for the same message+link', () => {
  const a = broadcastDedupeKey('hello', 'https://example.com');
  const b = broadcastDedupeKey('hello', 'https://example.com');
  assert.equal(a, b);
  assert.match(a, /^broadcast:[0-9a-f]{64}$/);
});

test('broadcastDedupeKey differs for a different message or a different link', () => {
  const base = broadcastDedupeKey('hello', 'https://example.com');
  assert.notEqual(broadcastDedupeKey('goodbye', 'https://example.com'), base);
  assert.notEqual(broadcastDedupeKey('hello', 'https://example.com/other'), base);
});

test('targetBots excludes named bot IDs, keeps the rest', () => {
  const all = [makeBotSpec('a'), makeBotSpec('b'), makeBotSpec('c')];
  const result = targetBots(all, ['b']);
  assert.deepEqual(
    result.map(b => b.botId),
    ['a', 'c'],
  );
});

test('targetBots with an empty exclude list returns every bot', () => {
  const all = [makeBotSpec('a'), makeBotSpec('b')];
  assert.deepEqual(
    targetBots(all, []).map(b => b.botId),
    ['a', 'b'],
  );
});

test('targetBots excluding a nonexistent bot ID is a no-op, not an error', () => {
  const all = [makeBotSpec('a')];
  assert.deepEqual(
    targetBots(all, ['does-not-exist']).map(b => b.botId),
    ['a'],
  );
});

test('buildBroadcastEmbed builds a ParsedEmbed from a successful Open Graph result', () => {
  const embed = buildBroadcastEmbed(
    {
      ogTitle: 'Example Title',
      ogDescription: 'Example description',
      ogImage: [{url: 'https://example.com/image.jpg'}],
      ogUrl: 'https://example.com/canonical',
    },
    'https://example.com/original-link',
  );
  assert.deepEqual(embed, {
    uri: 'https://example.com/canonical',
    title: 'Example Title',
    description: 'Example description',
    imageUrl: 'https://example.com/image.jpg',
    imageAlt: undefined,
  });
});

test('buildBroadcastEmbed falls back to the original link when ogUrl is absent', () => {
  const embed = buildBroadcastEmbed({ogTitle: 'Title only'}, 'https://example.com/link');
  assert.equal(embed?.uri, 'https://example.com/link');
});

test('buildBroadcastEmbed returns undefined when the Open Graph result is undefined (scrape failed)', () => {
  assert.equal(buildBroadcastEmbed(undefined, 'https://example.com'), undefined);
});

test('buildBroadcastEmbed returns undefined when the Open Graph result has no title', () => {
  assert.equal(
    buildBroadcastEmbed({ogDescription: 'no title here'}, 'https://example.com'),
    undefined,
  );
});

function makeStore(): {store: BotStore; dir: string} {
  const dir = mkdtempSync(join(tmpdir(), 'broadcast-test-'));
  const store = new BotStore(join(dir, 'state.sqlite'));
  return {store, dir};
}

test('enqueueBroadcast writes a real queued row and reports "enqueued"', () => {
  const {store, dir} = makeStore();
  try {
    const outcome = enqueueBroadcast(store, {
      title: 'Broadcast: test',
      message: 'Test broadcast message',
      embed: undefined,
      dedupeKey: broadcastDedupeKey('Test broadcast message', 'https://example.com'),
    });
    assert.equal(outcome, 'enqueued');
    const queued = store.listQueued();
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.content, 'Test broadcast message');
    assert.equal(queued[0]!.embedJson, null);
  } finally {
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('enqueueBroadcast with an embed serializes it into embedJson', () => {
  const {store, dir} = makeStore();
  try {
    const embed = {uri: 'https://example.com', title: 'T', description: undefined, imageUrl: undefined, imageAlt: undefined};
    enqueueBroadcast(store, {
      title: 'Broadcast: test',
      message: 'msg',
      embed,
      dedupeKey: broadcastDedupeKey('msg', 'https://example.com'),
    });
    const queued = store.listQueued();
    assert.deepEqual(JSON.parse(queued[0]!.embedJson!), embed);
  } finally {
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('enqueueBroadcast reports "duplicate" for a repeated dedupeKey, without adding a second row', () => {
  const {store, dir} = makeStore();
  try {
    const dedupeKey = broadcastDedupeKey('msg', 'https://example.com');
    const first = enqueueBroadcast(store, {title: 't', message: 'msg', embed: undefined, dedupeKey});
    const second = enqueueBroadcast(store, {title: 't', message: 'msg', embed: undefined, dedupeKey});
    assert.equal(first, 'enqueued');
    assert.equal(second, 'duplicate');
    assert.equal(store.listQueued().length, 1);
  } finally {
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test fleet/broadcast.test.ts`
Expected: FAIL — `Cannot find module './broadcast.ts'`.

- [ ] **Step 3: Implement**

Create `fleet/broadcast.ts` (this task only — no `main()` yet, that's Task 2's job; the file is valid TypeScript on its own since these are plain exported functions):

```typescript
import {createHash} from 'node:crypto';
import type {BotSpec} from './configLoader.ts';
import type {ParsedEmbed} from './feedReader.ts';
import {BotStore} from './botStore.ts';

/**
 * Deterministic per-message dedupe key: same message+link always hashes to the same key, so
 * re-running the script with unchanged text is a safe no-op per bot (BotStore.enqueue's
 * existing UNIQUE(dedupe_key) constraint already makes this idempotent) — editing the text
 * produces a genuinely new item. Prefixed to namespace it away from RSS-derived dedupe keys
 * (which are URL/date-derived, not hash-derived).
 */
export function broadcastDedupeKey(message: string, link: string): string {
  const hash = createHash('sha256').update(`${message}\n${link}`).digest('hex');
  return `broadcast:${hash}`;
}

/** Every loaded bot's spec, minus any explicitly excluded botId. */
export function targetBots(
  allBots: readonly BotSpec[],
  excludeBotIds: readonly string[],
): BotSpec[] {
  const excluded = new Set(excludeBotIds);
  return allBots.filter(bot => !excluded.has(bot.botId));
}

/**
 * Minimal shape of open-graph-scraper's real OgObject result (verified against
 * node_modules/open-graph-scraper/types/lib/types.d.ts) — only the fields this module reads.
 */
export interface OpenGraphResult {
  ogImage?: {url: string}[];
  ogDescription?: string;
  ogUrl?: string;
  ogTitle?: string;
}

/**
 * Builds the embed for the broadcast, or undefined if there's nothing usable — matching
 * fleet/feedReader.ts's own real-world condition (an embed needs a title to be worth showing).
 * undefined here means the message still posts fine as plain text, with the link auto-detected
 * into a clickable facet by RichText.detectFacets() at post time (existing BskyClient.post()
 * behavior, unchanged) — a failed/missing Open Graph scrape never blocks the broadcast.
 */
export function buildBroadcastEmbed(
  ogResult: OpenGraphResult | undefined,
  link: string,
): ParsedEmbed | undefined {
  if (!ogResult?.ogTitle) return undefined;
  return {
    uri: ogResult.ogUrl ?? link,
    title: ogResult.ogTitle,
    description: ogResult.ogDescription,
    imageUrl: ogResult.ogImage?.[0]?.url,
    imageAlt: undefined,
  };
}

export type EnqueueBroadcastOutcome = 'enqueued' | 'duplicate';

/**
 * Writes one broadcast row into a single bot's existing queue_items table — the exact same
 * BotStore.enqueue() method and table regular RSS items use. That bot's already-running
 * BotWorker drains it on its own next tick and posts it through its own already-tuned
 * Scheduler pacing; this function has no timing/throttling logic of its own.
 */
export function enqueueBroadcast(
  store: BotStore,
  params: {title: string; message: string; embed: ParsedEmbed | undefined; dedupeKey: string},
): EnqueueBroadcastOutcome {
  const id = store.enqueue({
    title: params.title,
    content: params.message,
    embedJson: params.embed ? JSON.stringify(params.embed) : null,
    languagesJson: null,
    facetsJson: null,
    itemDate: new Date().toISOString(),
    dedupeKey: params.dedupeKey,
  });
  return id === 0 ? 'duplicate' : 'enqueued';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test fleet/broadcast.test.ts && yarn typecheck`
Expected: PASS, all 12 tests; 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add fleet/broadcast.ts fleet/broadcast.test.ts
git commit -m "feat(fleet): add broadcast tool's dedupeKey, targeting, embed, and enqueue logic"
```

---

### Task 2: `main()` orchestration + `yarn fleet:broadcast`

**Files:**
- Modify: `fleet/broadcast.ts` (add `main()` and the operator-edited constants — no changes to Task 1's exports)
- Modify: `package.json` (add the `fleet:broadcast` script)

**Interfaces:**
- Consumes: everything Task 1 exported from `fleet/broadcast.ts`; `loadFleet(configRoot, secretsFilePath, dataRoot): LoadedFleet` (`fleet/configLoader.ts`, existing — `LoadedFleet = {fleetConfig, bots: BotSpec[], errors: {botId: string; error: string}[]}`); `open-graph-scraper`'s default export `og(options: {url: string; timeout?: number; fetchOptions?: {headers?: Record<string,string>}}): Promise<{error: boolean; result: OpenGraphResult}>` (verified against the installed package's real `.d.ts`, not memory); `node:readline/promises`'s `createInterface({input, output}).question(prompt): Promise<string>`.
- Produces: nothing further consumed by other tasks — this is the final wiring task before docs.

- [ ] **Step 1: No new automated test for this step**

`main()` is intentionally not directly unit-tested, matching `fleet/status.ts`'s and `fleet/logControl.ts`'s existing convention for their own thin `main()` functions (argv/console/process-exit glue around already-tested logic). Verification for this task is the manual smoke test in Step 3 below, plus the full existing suite continuing to pass.

- [ ] **Step 2: Implement**

Add to the top of `fleet/broadcast.ts` (after the existing imports), and append the rest to the end of the file:

```typescript
import {createInterface} from 'node:readline/promises';
import og from 'open-graph-scraper';
import {loadFleet} from './configLoader.ts';
```

```typescript
// Operator edits these three before running `yarn fleet:broadcast`. MESSAGE and LINK are
// hashed together into this run's dedupeKey (see broadcastDedupeKey) - editing either one
// after a previous run means every bot treats it as a new broadcast, not a duplicate.
const MESSAGE = 'Edit this message before running.';
const LINK = 'https://example.com/announcement';
const EXCLUDE_BOT_IDS: string[] = [];

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function scrapeOpenGraph(link: string): Promise<OpenGraphResult | undefined> {
  try {
    const response = await og({
      url: link,
      timeout: 10,
      fetchOptions: {headers: {'user-agent': DEFAULT_USER_AGENT}},
    });
    return response.error ? undefined : (response.result as OpenGraphResult);
  } catch {
    // og() can throw directly (e.g. a malformed URL) in addition to returning error:true -
    // either way, no embed; the broadcast still posts as plain text with an auto-detected link.
    return undefined;
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const skipConfirm = process.argv.includes('--yes');

  const configRoot = process.env.FLEET_CONFIG_ROOT ?? './config.example';
  const secretsFilePath =
    process.env.FLEET_SECRETS_PATH ?? './config.example/secrets/bsky-fleet.json';
  const dataRoot = process.env.FLEET_DATA_ROOT ?? './data/fleet';

  const {bots, errors} = loadFleet(configRoot, secretsFilePath, dataRoot);
  if (errors.length > 0) {
    console.log(`Warning: ${errors.length} bot config(s) failed to load and will be skipped.`);
  }

  const targets = targetBots(bots, EXCLUDE_BOT_IDS);
  if (targets.length === 0) {
    console.log('No target bots (empty fleet, or all excluded). Nothing to do.');
    return;
  }

  const ogResult = await scrapeOpenGraph(LINK);
  const embed = buildBroadcastEmbed(ogResult, LINK);
  const dedupeKey = broadcastDedupeKey(MESSAGE, LINK);
  const title = `Broadcast: ${MESSAGE.slice(0, 40)}`;

  console.log(`Message: ${MESSAGE}`);
  console.log(`Link: ${LINK}`);
  console.log(
    embed
      ? `Embed: "${embed.title}"${embed.imageUrl ? ' (with image)' : ' (no image)'}`
      : 'No embed (Open Graph scrape failed or produced no title) - link will still be clickable.',
  );
  console.log(`Targets (${targets.length}): ${targets.map(b => b.botId).join(', ')}`);

  if (dryRun) {
    console.log('\n--dry-run: stopping before any writes.');
    return;
  }

  if (!skipConfirm) {
    const rl = createInterface({input: process.stdin, output: process.stdout});
    const answer = await rl.question('\nType BROADCAST to continue: ');
    rl.close();
    if (answer.trim() !== 'BROADCAST') {
      console.log('Aborted - no changes made.');
      return;
    }
  }

  const enqueued: string[] = [];
  const duplicate: string[] = [];
  const failed: string[] = [];
  for (const bot of targets) {
    let store: BotStore | undefined;
    try {
      store = new BotStore(bot.dbPath);
      const outcome = enqueueBroadcast(store, {title, message: MESSAGE, embed, dedupeKey});
      (outcome === 'enqueued' ? enqueued : duplicate).push(bot.botId);
    } catch (error) {
      failed.push(bot.botId);
      console.error(`${bot.botId}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      store?.close();
    }
  }

  console.log(`\nEnqueued: ${enqueued.length}${enqueued.length ? ` (${enqueued.join(', ')})` : ''}`);
  console.log(
    `Already queued: ${duplicate.length}${duplicate.length ? ` (${duplicate.join(', ')})` : ''}`,
  );
  console.log(`Failed: ${failed.length}${failed.length ? ` (${failed.join(', ')})` : ''}`);
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
```

In `package.json`, add alongside the existing `fleet:status`/`fleet:log` scripts:

```json
    "fleet:broadcast": "NODE_NO_WARNINGS=1 tsx ./fleet/broadcast.ts",
```

- [ ] **Step 3: Manual smoke test**

Run: `yarn typecheck` — expect 0 errors.

Run against the real example config (safe — `config.example/` is a fixture, and `--dry-run` stops before any write):

```bash
FLEET_CONFIG_ROOT=./config.example \
FLEET_SECRETS_PATH=./config.example/secrets/bsky-fleet.json \
FLEET_DATA_ROOT=/tmp/broadcast-smoke-test \
npx tsx fleet/broadcast.ts --dry-run
```

Expected output: the default placeholder `MESSAGE`/`LINK`, an Open Graph line (likely "No embed..." since `https://example.com/announcement` has no real OG tags — that's fine, confirms the failure path doesn't crash), the full list of `config.example`'s bot IDs, and `--dry-run: stopping before any writes.` with exit code 0. Confirm no file was written under `/tmp/broadcast-smoke-test` (dry-run must not call `loadFleet`'s data-root-dependent paths in a way that creates state — `loadFleet` itself doesn't write anything, only `BotStore`'s constructor does, and that's never reached in `--dry-run`).

Run the full suite once more to confirm no regressions: `yarn test:fleet`.

- [ ] **Step 4: Commit**

```bash
git add fleet/broadcast.ts package.json
git commit -m "feat(fleet): add broadcast.ts main() orchestration and yarn fleet:broadcast"
```

---

### Task 3: Documentation

**Files:**
- Modify: `documentation/fleet.md`
- Modify: `CLAUDE.md`

**Interfaces:** None — prose only.

- [ ] **Step 1: Add a new top-level section to `documentation/fleet.md`**

Insert immediately before the `## Legacy import` heading (matching where the notification feature's own subsection sits, just one level up since this is a top-level section per the design spec, not nested under Operations visibility):

```markdown
## Broadcast messages

`fleet/broadcast.ts` (`yarn fleet:broadcast`) posts the same maintenance/support message and
link to every fleet account at once - for something like "we're aware of an issue with X feed"
or "brief downtime expected tonight." Edit the `MESSAGE`, `LINK`, and (optionally)
`EXCLUDE_BOT_IDS` constants directly at the top of `fleet/broadcast.ts`, then run:

```bash
yarn fleet:broadcast              # preview, then asks you to type BROADCAST to confirm
yarn fleet:broadcast --dry-run    # preview only, never writes anything
yarn fleet:broadcast --yes        # skips the confirmation prompt
```

It doesn't post anything itself - it writes one row into each target bot's existing queue
(the same `queue_items` table and `BotStore.enqueue()` method regular RSS items use), and that
bot's already-running fleet process posts it on its own next drain tick, at its own
already-tuned pace. This means the fleet process needs to actually be running for the broadcast
to go out, and posting isn't instant - expect it within each bot's normal drain interval, not
immediately when the script exits. `DRY_RUN=true` on the fleet container is respected exactly
like any other post (logged, not actually published), with no special-casing needed here.

Re-running the script with the exact same `MESSAGE`/`LINK` is safe - each bot's queue dedupes
by a hash of the message+link, so nothing gets posted twice. Editing the text is treated as a
genuinely new broadcast.

An Open Graph card for `LINK` is scraped once (not once per account) and attached if the page
has a usable title; if the scrape fails or the link has no title, the message still posts as
plain text with the link auto-detected into a clickable link, same as any other post.
```

- [ ] **Step 2: Add one line to `CLAUDE.md`'s Fleet mode section**

Insert a new bullet after the `fleet/notificationWatcher.ts` bullet (keeping the section's
existing one-sentence-per-module pattern):

```markdown
- **`fleet/broadcast.ts`** (`yarn fleet:broadcast`) is a manually-run operator tool that queues
  the same message across every fleet account by writing directly into each bot's existing
  `queue_items` table - posting timing/pacing comes entirely from that bot's already-running
  `BotWorker`/`Scheduler`, no new throttling logic.
```

- [ ] **Step 3: Commit**

```bash
git add documentation/fleet.md CLAUDE.md
git commit -m "docs(fleet): document the broadcast tool"
```

(Note: `CLAUDE.md` is gitignored in this repository, confirmed in a prior session — the edit
still needs to be made on disk, but only `documentation/fleet.md` will actually be staged and
committed. This is expected, not an error.)

---

## Self-Review

**1. Spec coverage.** Every section of `documentation/specs/2026-09-29-fleet-broadcast-design.md`
maps to a task: the script's flow (config load → target list → OG scrape → dedupeKey → preview
→ confirm → enqueue → summary) → Tasks 1+2; error handling (per-bot isolation, duplicate
handling, `perBotQueueMaxLength`/`DRY_RUN` non-goals) → Task 2's `main()` and the Global
Constraints header; testing → Task 1's test file plus Task 2's documented manual smoke test;
documentation → Task 3.

**2. Placeholder scan.** No TODOs, no "add appropriate error handling" — every step has complete
code or an explicit, reasoned "not unit-tested, matching X's existing convention" statement
backed by a manual verification step.

**3. Type consistency.** `ParsedEmbed`'s fields (`uri`, `title`, `description?`, `imageUrl?`,
`imageAlt?`, `type?`) are used identically in Task 1's `buildBroadcastEmbed` and Task 2's
`main()` (via `embed.title`/`embed.imageUrl` for the preview line). `OpenGraphResult`,
`EnqueueBroadcastOutcome`, `broadcastDedupeKey`, `targetBots`, `buildBroadcastEmbed`, and
`enqueueBroadcast` are defined once in Task 1 and consumed with matching signatures in Task 2's
`main()` — traced call-by-call, no name or shape mismatch. `BotSpec.dbPath` (existing field,
`fleet/configLoader.ts`) is what `main()` passes to `new BotStore(bot.dbPath)`, matching
`runFleet.ts`'s own identical usage.

---

**Plan complete and saved to `documentation/plans/2026-09-29-fleet-broadcast.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
