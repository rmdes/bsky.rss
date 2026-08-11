# app/ Handler Factories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `app/`'s four handlers (`dbHandler.ts`, `bskyHandler.ts`, `queueHandler.ts`, `rssHandler.ts`) from module-level singletons to `createXHandler(deps)` factory functions, so tests get real state isolation instead of the ESM migration's interim `crypto.randomUUID()` cache-busting, and `dbHandler`'s data directory becomes a real constructor parameter instead of a hardcoded path — eliminating the `app/utils/*.test.ts` cross-file `data/` directory race and the risk of a test run overwriting real local state.

**Architecture:** Each handler file exports `createXHandler(...deps)` returning the same plain-object-of-functions shape it exports today (`export default {...}` today; the object is now constructed per call instead of once at module-eval time). A file-local `export type XHandler = ReturnType<typeof createXHandler>;` gives every consumer (later handlers, tests, `app/index.ts`) a name for that shape without hand-duplicating its signatures. `app/index.ts` builds the one real production chain explicitly: `db → bsky → queue → reader`. Each of the four `.test.ts` files constructs fresh handler instances directly (a plain function call) instead of forcing an ES module re-evaluation, using a fresh `fs.mkdtempSync(path.join(os.tmpdir(), 'bsky-rss-test-'))` directory per test instead of the real `./data` directory.

**Tech Stack:** TypeScript (Node's `nodenext` module resolution, per the ESM migration), `node:test`/`node:assert`, `node:fs`/`node:os`/`node:path`.

## Global Constraints

- Scope is exactly `app/utils/{dbHandler,bskyHandler,queueHandler,rssHandler}.ts`, their four `.test.ts` files, and `app/index.ts`. `app/utils/healthHandler.ts` and all of `fleet/` are explicitly untouched — dropped from scope by ponytail-review during design (no test-isolation bug exists there; it's a genuine one-per-OS-port singleton in both its callers).
- Factory functions, not classes — matches CLAUDE.md's "plain objects, not classes" convention for `app/` (see `documentation/specs/2026-08-11-app-handler-factories-design.md`, "Factory functions, not classes").
- Every exported function name and signature is unchanged from today; only where state lives changes (module `let` → closure `let`). No behavior change to posting/dedup/rate-limit/pacing logic anywhere — this is a construction-and-wiring refactor only.
- Type names: `export type XHandler = ReturnType<typeof createXHandler>;` in each handler file — never a hand-written interface duplicating the factory's real return shape (that would drift; `ReturnType` can't).
- The `bskyAgent`-already-initialized guard in `bskyHandler.ts`'s `init()` (`if (bskyAgent) throw new Error('Bluesky agent already initialized.')`) is kept verbatim — it protects a real invariant (no double-constructing the same instance's agent), not a module-singleton artifact.
- Task order is dbHandler → bskyHandler → queueHandler → rssHandler → `app/index.ts` wiring, because each later factory's constructor signature names the previous task's exported type (`createBskyHandler(db: DbHandler)`, `createQueueHandler(bsky: BskyHandler, db: DbHandler)`, `createRssHandler(queue: QueueHandler, db: DbHandler)`).
- **Expected transient typecheck breakage between Tasks 1-4:** each task converts exactly one handler file. Files that still do `import db from './dbHandler.ts'` (a default import) after `dbHandler.ts` stops exporting a default will show a real `yarn typecheck` error until THEIR OWN task converts them — this is expected, not a regression to fix out of order. Each task's steps state exactly which files will still show errors and why. This mirrors the established, already-proven pattern from the 2026-08-11 ESM migration (`documentation/plans/2026-08-11-esm-migration.md`, Task 1's brief), which explicitly documented the same kind of expected transient state.
- Test isolation: every `.test.ts` file in scope uses `fs.mkdtempSync(path.join(os.tmpdir(), 'bsky-rss-test-'))` for a fresh directory per test, removed via `fs.rmSync(dir, {recursive: true, force: true})` in `afterEach`. No test in scope reads or writes the real `./data` directory after this plan lands.
- Full-repo `yarn lint`/`eslint .` is known to hang in this sandbox (established in the ESM migration) — lint touched files individually via `npx eslint <file>`.
- `yarn test:fleet` is not required by this plan — `fleet/` is untouched.

---

### Task 1: dbHandler factory

**Files:**
- Modify: `app/utils/dbHandler.ts` (full rewrite, shown below)
- Modify: `app/utils/dbHandler.test.ts` (full rewrite, shown below)

**Interfaces:**
- Consumes: nothing from other tasks (first task).
- Produces: `createDbHandler(dataRoot: string)` returning `{readLast, writeDate, readConfig, initConfig, writePersistDate, readPersistData, valueExists, writeValue, cleanupOldValues}` (same function names/signatures as today's default export). `export type DbHandler = ReturnType<typeof createDbHandler>;` — Task 2 imports this type.

**Expected transient typecheck state after this task:** `dbHandler.ts` and `dbHandler.test.ts` show zero errors. `app/utils/bskyHandler.ts`, `app/utils/queueHandler.ts`, and `app/utils/rssHandler.ts` each still do `import db from './dbHandler.ts';` as a default import and will each show a real `yarn typecheck` error (`Module '"./dbHandler.ts"' has no default export`) until their own task converts them (Tasks 2-4). `app/index.ts` and the other three `.test.ts` files don't statically import `dbHandler.ts` directly (they reach it only through a cache-busted dynamic `import()`, which TypeScript can't type-check through a template-literal specifier) — unaffected at this point.

- [ ] **Step 1: Replace `app/utils/dbHandler.ts` in full**

```ts
import fs from 'fs';

export function createDbHandler(dataRoot: string) {
  let appConfig: Config | null = null;

  async function readLast() {
    if (!fs.existsSync(`${dataRoot}/last.txt`)) {
      fs.writeFileSync(`${dataRoot}/last.txt`, '', 'utf8');
      return '';
    } else {
      const data = fs.readFileSync(`${dataRoot}/last.txt`, 'utf8');
      return data;
    }
  }

  async function writeDate(date: Date) {
    fs.writeFileSync(`${dataRoot}/last.txt`, date.toISOString(), 'utf8');
    return date;
  }

  async function readPersistData() {
    if (!fs.existsSync(`${dataRoot}/persist.json`)) {
      fs.writeFileSync(`${dataRoot}/persist.json`, JSON.stringify({}), 'utf8');
      return {};
    } else {
      const data = fs.readFileSync(`${dataRoot}/persist.json`, 'utf8');
      return JSON.parse(data);
    }
  }

  async function writePersistDate(persistData: object) {
    fs.writeFileSync(`${dataRoot}/persist.json`, JSON.stringify(persistData), 'utf8');
    return persistData;
  }

  async function initConfig() {
    try {
      const data = fs.readFileSync(`${dataRoot}/config.json`, 'utf8');
      appConfig = JSON.parse(data);
      return JSON.parse(data);
    } catch (e) {
      if (String(e).startsWith('Error: ENOENT: no such file or directory')) {
        throw new Error('Config file not found.');
      }
    }

    return '';
  }

  async function readConfig() {
    if (!appConfig) throw new Error('Config not initialized.');
    return appConfig;
  }

  async function valueExists(value: string) {
    if (!fs.existsSync(`${dataRoot}/db.txt`)) {
      fs.writeFileSync(`${dataRoot}/db.txt`, '', 'utf8');
      return false;
    } else {
      const fileContent = fs.readFileSync(`${dataRoot}/db.txt`, 'utf8');
      return fileContent.includes(value);
    }
  }

  async function writeValue(value: string) {
    const currentDate = new Date();
    fs.appendFileSync(`${dataRoot}/db.txt`, currentDate.toISOString() + '|' + value + '\n', 'utf8');
    return value;
  }

  // Automatically cleanup old values from the file after 96 hours
  async function cleanupOldValues() {
    if (!fs.existsSync(`${dataRoot}/db.txt`)) {
      fs.writeFileSync(`${dataRoot}/db.txt`, '', 'utf8');
      return false;
    }

    const currentDate = new Date();
    const oldFileContent = fs.readFileSync(`${dataRoot}/db.txt`, 'utf8');
    let newFileContent = '';

    const fcLines: string[] = oldFileContent.split('\n');
    if (fcLines !== undefined) {
      for (const i in fcLines) {
        const lineItems: string[] = (fcLines[i] || '').split('|');
        if (lineItems !== undefined) {
          const lineDate = new Date((lineItems[0] || '').toString());
          const diffHours = getHoursDiffBetweenDates(lineDate, currentDate);

          if (diffHours <= 96) {
            newFileContent = newFileContent + (fcLines[i] || '') + '\n';
          }
        }
      }
    }

    fs.writeFileSync(`${dataRoot}/db.txt`, newFileContent, 'utf8');
    return true;
  }

  return {
    readLast,
    writeDate,
    readConfig,
    initConfig,
    writePersistDate,
    readPersistData,
    valueExists,
    writeValue,
    cleanupOldValues,
  };
}

export type DbHandler = ReturnType<typeof createDbHandler>;

const getHoursDiffBetweenDates = (dateInitial: Date, dateFinal: Date) =>
  (dateFinal.getTime() - dateInitial.getTime()) / (1000 * 3600);
```

Every function body is byte-identical to today's, except every `import.meta.dirname + '/../../data/<file>'` becomes `` `${dataRoot}/<file>` ``. `getHoursDiffBetweenDates` stays a plain module-level function (it's pure — no `dataRoot`/`appConfig` dependency — no reason to duplicate it per factory call).

- [ ] **Step 2: Run typecheck, confirm the expected transient state**

Run: `yarn typecheck`
Expected: errors only in `app/utils/bskyHandler.ts`, `app/utils/bskyHandler.test.ts`, `app/utils/queueHandler.ts`, `app/utils/rssHandler.ts`, `app/index.ts` (all referencing `dbHandler.ts`'s now-removed default export). Zero errors attributed to `app/utils/dbHandler.ts` itself.

- [ ] **Step 3: Replace `app/utils/dbHandler.test.ts` in full**

```ts
import {describe, it, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert';
import fs, {mkdtempSync, rmSync} from 'fs';
import path from 'path';
import {tmpdir} from 'os';

// Import the module to test
import {createDbHandler, type DbHandler} from './dbHandler.ts';

describe('dbHandler', () => {
  let testDataDir: string;
  let dbHandler: DbHandler;

  beforeEach(() => {
    testDataDir = mkdtempSync(path.join(tmpdir(), 'bsky-rss-test-'));
    dbHandler = createDbHandler(testDataDir);
  });

  afterEach(() => {
    rmSync(testDataDir, {recursive: true, force: true});
  });

  describe('readLast()', () => {
    it('should create last.txt if it does not exist', async () => {
      const result = await dbHandler.readLast();

      assert.strictEqual(result, '');
      assert(fs.existsSync(path.join(testDataDir, 'last.txt')));
    });

    it('should read existing last.txt content', async () => {
      const testDate = '2026-08-05T10:00:00.000Z';
      fs.writeFileSync(path.join(testDataDir, 'last.txt'), testDate, 'utf8');

      const result = await dbHandler.readLast();

      assert.strictEqual(result, testDate);
    });

    it('should handle empty last.txt file', async () => {
      fs.writeFileSync(path.join(testDataDir, 'last.txt'), '', 'utf8');

      const result = await dbHandler.readLast();

      assert.strictEqual(result, '');
    });
  });

  describe('writeDate()', () => {
    it('should write date to last.txt in ISO format', async () => {
      const testDate = new Date('2026-08-05T10:00:00.000Z');

      const result = await dbHandler.writeDate(testDate);

      assert.strictEqual(result, testDate);

      const fileContent = fs.readFileSync(path.join(testDataDir, 'last.txt'), 'utf8');
      assert.strictEqual(fileContent, testDate.toISOString());
    });

    it('should overwrite existing date', async () => {
      const oldDate = new Date('2026-08-01T10:00:00.000Z');
      const newDate = new Date('2026-08-05T10:00:00.000Z');

      await dbHandler.writeDate(oldDate);
      await dbHandler.writeDate(newDate);

      const fileContent = fs.readFileSync(path.join(testDataDir, 'last.txt'), 'utf8');
      assert.strictEqual(fileContent, newDate.toISOString());
    });
  });

  describe('readPersistData()', () => {
    it('should create persist.json if it does not exist', async () => {
      const result = await dbHandler.readPersistData();

      assert.deepStrictEqual(result, {});
      assert(fs.existsSync(path.join(testDataDir, 'persist.json')));
    });

    it('should read existing persist.json data', async () => {
      const testData = {lastRun: '2026-08-05', itemCount: 42};
      fs.writeFileSync(path.join(testDataDir, 'persist.json'), JSON.stringify(testData), 'utf8');

      const result = await dbHandler.readPersistData();

      assert.deepStrictEqual(result, testData);
    });

    it('should handle empty object in persist.json', async () => {
      fs.writeFileSync(path.join(testDataDir, 'persist.json'), JSON.stringify({}), 'utf8');

      const result = await dbHandler.readPersistData();

      assert.deepStrictEqual(result, {});
    });

    it('should parse complex nested data structures', async () => {
      const testData = {
        config: {feeds: ['feed1', 'feed2']},
        stats: {posted: 10, failed: 2},
        metadata: {version: '2.2.0'},
      };
      fs.writeFileSync(path.join(testDataDir, 'persist.json'), JSON.stringify(testData), 'utf8');

      const result = await dbHandler.readPersistData();

      assert.deepStrictEqual(result, testData);
    });
  });

  describe('writePersistDate()', () => {
    it('should write persist data to persist.json', async () => {
      const testData = {lastRun: '2026-08-05', itemCount: 42};

      const result = await dbHandler.writePersistDate(testData);

      assert.deepStrictEqual(result, testData);

      const fileContent = fs.readFileSync(path.join(testDataDir, 'persist.json'), 'utf8');
      assert.deepStrictEqual(JSON.parse(fileContent), testData);
    });

    it('should overwrite existing persist data', async () => {
      const oldData = {value: 'old'};
      const newData = {value: 'new', extra: true};

      await dbHandler.writePersistDate(oldData);
      await dbHandler.writePersistDate(newData);

      const fileContent = fs.readFileSync(path.join(testDataDir, 'persist.json'), 'utf8');
      assert.deepStrictEqual(JSON.parse(fileContent), newData);
    });
  });

  describe('initConfig()', () => {
    it('should throw error if config.json does not exist', async () => {
      await assert.rejects(
        async () => {
          await dbHandler.initConfig();
        },
        {
          message: 'Config file not found.',
        },
      );
    });

    it('should read and cache config.json', async () => {
      const testConfig = {
        string: '$title - $link',
        publishEmbed: true,
        languages: ['en'],
      };
      fs.writeFileSync(path.join(testDataDir, 'config.json'), JSON.stringify(testConfig), 'utf8');

      const result = await dbHandler.initConfig();

      assert.deepStrictEqual(result, testConfig);
    });

    it('should parse complex config structures', async () => {
      const testConfig = {
        string: '$title',
        publishEmbed: true,
        embedType: 'card',
        languages: ['en', 'fr'],
        runInterval: 60,
        truncate: true,
      };
      fs.writeFileSync(path.join(testDataDir, 'config.json'), JSON.stringify(testConfig), 'utf8');

      const result = await dbHandler.initConfig();

      assert.deepStrictEqual(result, testConfig);
    });
  });

  describe('readConfig()', () => {
    it('should throw error if config not initialized', async () => {
      // dbHandler is a fresh createDbHandler(testDataDir) instance from this file's own
      // beforeEach - no need to force a second "reload the module" instance to get an
      // unset appConfig anymore, unlike the old cache-busting version of this test.
      await assert.rejects(
        async () => {
          await dbHandler.readConfig();
        },
        {
          message: 'Config not initialized.',
        },
      );
    });

    it('should return config after initialization', async () => {
      const testConfig = {
        string: '$title - $link',
        publishEmbed: true,
      };
      fs.writeFileSync(path.join(testDataDir, 'config.json'), JSON.stringify(testConfig), 'utf8');

      await dbHandler.initConfig();
      const result = await dbHandler.readConfig();

      assert.deepStrictEqual(result, testConfig);
    });
  });

  describe('valueExists()', () => {
    it('should create db.txt if it does not exist', async () => {
      const result = await dbHandler.valueExists('test-value');

      assert.strictEqual(result, false);
      assert(fs.existsSync(path.join(testDataDir, 'db.txt')));
    });

    it('should return false for non-existent value', async () => {
      fs.writeFileSync(
        path.join(testDataDir, 'db.txt'),
        '2026-08-05T10:00:00.000Z|existing-value\n',
        'utf8',
      );

      const result = await dbHandler.valueExists('non-existent');

      assert.strictEqual(result, false);
    });

    it('should return true for existing value', async () => {
      fs.writeFileSync(
        path.join(testDataDir, 'db.txt'),
        '2026-08-05T10:00:00.000Z|test-value\n',
        'utf8',
      );

      const result = await dbHandler.valueExists('test-value');

      assert.strictEqual(result, true);
    });

    it('should find value among multiple entries', async () => {
      const entries = [
        '2026-08-05T08:00:00.000Z|value-1',
        '2026-08-05T09:00:00.000Z|value-2',
        '2026-08-05T10:00:00.000Z|target-value',
        '2026-08-05T11:00:00.000Z|value-3',
      ].join('\n');

      fs.writeFileSync(path.join(testDataDir, 'db.txt'), entries, 'utf8');

      const result = await dbHandler.valueExists('target-value');

      assert.strictEqual(result, true);
    });

    it('should handle partial matches correctly', async () => {
      fs.writeFileSync(
        path.join(testDataDir, 'db.txt'),
        '2026-08-05T10:00:00.000Z|full-value-here\n',
        'utf8',
      );

      // Should find the substring
      const result1 = await dbHandler.valueExists('value');
      assert.strictEqual(result1, true);

      // Should not find non-matching string
      const result2 = await dbHandler.valueExists('missing');
      assert.strictEqual(result2, false);
    });
  });

  describe('writeValue()', () => {
    it('should append value to db.txt with timestamp', async () => {
      const testValue = 'test-article-url';

      const result = await dbHandler.writeValue(testValue);

      assert.strictEqual(result, testValue);

      const fileContent = fs.readFileSync(path.join(testDataDir, 'db.txt'), 'utf8');

      // Check format: timestamp|value\n
      assert(fileContent.includes('|' + testValue + '\n'));
      assert(fileContent.match(/^\d{4}-\d{2}-\d{2}T/)); // ISO timestamp format
    });

    it('should append multiple values without overwriting', async () => {
      await dbHandler.writeValue('value-1');
      await dbHandler.writeValue('value-2');
      await dbHandler.writeValue('value-3');

      const fileContent = fs.readFileSync(path.join(testDataDir, 'db.txt'), 'utf8');

      const lines = fileContent.trim().split('\n');
      assert.strictEqual(lines.length, 3);
      assert(fileContent.includes('value-1'));
      assert(fileContent.includes('value-2'));
      assert(fileContent.includes('value-3'));
    });

    it('should create db.txt if it does not exist', async () => {
      const testValue = 'first-value';

      await dbHandler.writeValue(testValue);

      assert(fs.existsSync(path.join(testDataDir, 'db.txt')));
      const fileContent = fs.readFileSync(path.join(testDataDir, 'db.txt'), 'utf8');
      assert(fileContent.includes(testValue));
    });
  });

  describe('cleanupOldValues()', () => {
    it('should create db.txt if it does not exist', async () => {
      const result = await dbHandler.cleanupOldValues();

      assert.strictEqual(result, false);
      assert(fs.existsSync(path.join(testDataDir, 'db.txt')));
    });

    it('should remove entries older than 96 hours', async () => {
      const now = new Date();
      const old = new Date(now.getTime() - 97 * 60 * 60 * 1000); // 97 hours ago
      const recent = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago

      const entries = [
        `${old.toISOString()}|old-value`,
        `${recent.toISOString()}|recent-value`,
        `${now.toISOString()}|current-value`,
      ].join('\n');

      fs.writeFileSync(path.join(testDataDir, 'db.txt'), entries, 'utf8');

      const result = await dbHandler.cleanupOldValues();

      assert.strictEqual(result, true);

      const fileContent = fs.readFileSync(path.join(testDataDir, 'db.txt'), 'utf8');

      // Old value should be removed (>96 hours old)
      assert(!fileContent.includes('old-value'));

      // Recent values should remain (<96 hours old)
      assert(fileContent.includes('recent-value'));
      assert(fileContent.includes('current-value'));
    });

    it('should keep all entries within 96 hours', async () => {
      const now = new Date();
      const entries = [
        `${new Date(now.getTime() - 95 * 60 * 60 * 1000).toISOString()}|value-1`,
        `${new Date(now.getTime() - 50 * 60 * 60 * 1000).toISOString()}|value-2`,
        `${new Date(now.getTime() - 10 * 60 * 60 * 1000).toISOString()}|value-3`,
      ].join('\n');

      fs.writeFileSync(path.join(testDataDir, 'db.txt'), entries, 'utf8');

      await dbHandler.cleanupOldValues();

      const fileContent = fs.readFileSync(path.join(testDataDir, 'db.txt'), 'utf8');

      // All values should remain
      assert(fileContent.includes('value-1'));
      assert(fileContent.includes('value-2'));
      assert(fileContent.includes('value-3'));
    });

    it('should handle empty db.txt', async () => {
      fs.writeFileSync(path.join(testDataDir, 'db.txt'), '', 'utf8');

      const result = await dbHandler.cleanupOldValues();

      assert.strictEqual(result, true);

      const fileContent = fs.readFileSync(path.join(testDataDir, 'db.txt'), 'utf8');
      assert.strictEqual(fileContent, '');
    });

    it('should handle malformed lines gracefully', async () => {
      const now = new Date();
      const entries = [
        `${now.toISOString()}|valid-value`,
        'malformed-line-without-pipe',
        '|no-timestamp',
        `${now.toISOString()}|another-valid`,
      ].join('\n');

      fs.writeFileSync(path.join(testDataDir, 'db.txt'), entries, 'utf8');

      await dbHandler.cleanupOldValues();

      const fileContent = fs.readFileSync(path.join(testDataDir, 'db.txt'), 'utf8');

      // Valid entries should remain
      assert(fileContent.includes('valid-value'));
      assert(fileContent.includes('another-valid'));
    });
  });

  describe('Integration tests', () => {
    it('should support full workflow: init config -> read config -> write/read persist', async () => {
      // 1. Initialize config
      const config = {string: '$title', publishEmbed: true};
      fs.writeFileSync(path.join(testDataDir, 'config.json'), JSON.stringify(config), 'utf8');

      await dbHandler.initConfig();
      const readConfig = await dbHandler.readConfig();
      assert.deepStrictEqual(readConfig, config);

      // 2. Write persist data
      const persistData = {lastRun: new Date().toISOString()};
      await dbHandler.writePersistDate(persistData);

      // 3. Read persist data
      const readPersist = await dbHandler.readPersistData();
      assert.deepStrictEqual(readPersist, persistData);
    });

    it('should support duplicate detection workflow', async () => {
      const url1 = 'https://example.com/article-1';
      const url2 = 'https://example.com/article-2';

      // Check initial state
      const exists1 = await dbHandler.valueExists(url1);
      assert.strictEqual(exists1, false);

      // Write first URL
      await dbHandler.writeValue(url1);

      // Check it exists now
      const exists2 = await dbHandler.valueExists(url1);
      assert.strictEqual(exists2, true);

      // Check second URL doesn't exist
      const exists3 = await dbHandler.valueExists(url2);
      assert.strictEqual(exists3, false);

      // Write second URL
      await dbHandler.writeValue(url2);

      // Both should exist now
      const exists4 = await dbHandler.valueExists(url1);
      const exists5 = await dbHandler.valueExists(url2);
      assert.strictEqual(exists4, true);
      assert.strictEqual(exists5, true);
    });

    it('should support last posted date tracking', async () => {
      // Read initial (should be empty)
      const initial = await dbHandler.readLast();
      assert.strictEqual(initial, '');

      // Write date
      const date1 = new Date('2026-08-05T10:00:00.000Z');
      await dbHandler.writeDate(date1);

      // Read it back
      const read1 = await dbHandler.readLast();
      assert.strictEqual(read1, date1.toISOString());

      // Update to new date
      const date2 = new Date('2026-08-05T11:00:00.000Z');
      await dbHandler.writeDate(date2);

      // Read updated date
      const read2 = await dbHandler.readLast();
      assert.strictEqual(read2, date2.toISOString());
    });
  });
});
```

Compared to today's file: the `before`/`after` rename-the-real-`data`-directory dance and the `beforeEach` that deleted 4 named files are gone entirely, replaced by `mkdtempSync`/`rmSync` around a directory nothing else ever touches. Every `ORIGINAL_DATA_DIR` reference becomes `testDataDir`. The `readConfig()` "should throw error if config not initialized" test's fresh-module-reload workaround is gone — the describe-level `dbHandler` is already fresh (via `beforeEach`) for every test, so it already has an unset `appConfig` unless that specific test calls `initConfig()` itself.

- [ ] **Step 4: Run the test file, expect all tests pass**

Run: `npx tsx --test app/utils/dbHandler.test.ts`
Expected: all tests pass (32/32, matching today's count — no test was added or removed, only their setup/teardown changed).

- [ ] **Step 5: Confirm the real `./data` directory is untouched**

Run: `git status --short data/ 2>/dev/null; ls data/ 2>/dev/null`
Expected: no output from `git status` (or the directory's contents match what existed before running this test file) — confirms `dbHandler.test.ts` no longer touches real local state.

- [ ] **Step 6: Commit**

```bash
git add app/utils/dbHandler.ts app/utils/dbHandler.test.ts
git commit -m "refactor: convert dbHandler to a factory function

Replaces module-level singleton state with a per-instance closure
constructed via createDbHandler(dataRoot). dbHandler.test.ts now uses
an isolated fs.mkdtempSync() directory per test instead of the real
./data directory, closing part of the cross-file test-isolation race
(session task #81) as a direct consequence of the factory refactor
(session task #74)."
```

---

### Task 2: bskyHandler factory

**Files:**
- Modify: `app/utils/bskyHandler.ts` (full rewrite, shown below)
- Modify: `app/utils/bskyHandler.test.ts` (full rewrite, shown below)

**Interfaces:**
- Consumes: `import type {DbHandler} from './dbHandler.ts';` and, in the test file only, `import {createDbHandler} from './dbHandler.ts';` (Task 1).
- Produces: `createBskyHandler(db: DbHandler)` returning `{init, login, post}` (same signatures as today's default export). `export type BskyHandler = ReturnType<typeof createBskyHandler>;` — Task 3 imports this type.

**Expected transient typecheck state after this task:** `dbHandler.ts`, `dbHandler.test.ts`, `bskyHandler.ts`, `bskyHandler.test.ts` show zero errors. `app/utils/queueHandler.ts` (still does `import bsky from './bskyHandler.ts';` and `import db from './dbHandler.ts';`, both default imports) and `app/utils/rssHandler.ts` (still does `import db from './dbHandler.ts';`) continue to show errors from Task 1. `app/index.ts` now shows a *new* error too — it does `import bsky from './utils/bskyHandler.ts';` as a default import, which breaks now that `bskyHandler.ts` no longer default-exports. All expected, fixed by Tasks 3-5.

- [ ] **Step 1: Replace `app/utils/bskyHandler.ts` in full**

```ts
import {
  BskyAgent,
  RichText,
  AtpSessionEvent,
  AtpSessionData,
  ComAtprotoRepoUploadBlob,
  AppBskyFeedPost,
  type Facet,
} from '@atproto/api';
import {XRPCError, ResponseType} from '@atproto/xrpc';
import type {DbHandler} from './dbHandler.ts';
import {buildFacets, type MarkdownFacet} from '../../shared/feedSource/markdownLinks.ts';

export function createBskyHandler(db: DbHandler) {
  let bskyAgent: BskyAgent | null = null;

  async function init(service: string) {
    if (bskyAgent) throw new Error('Bluesky agent already initialized.');

    bskyAgent = new BskyAgent({
      service,
      persistSession: (_evt: AtpSessionEvent, sess?: AtpSessionData) => {
        if (!sess) return;
        void db.writePersistDate(sess);
      },
    });
    return bskyAgent;
  }

  async function login({identifier, password}: {identifier: string; password: string}) {
    if (!bskyAgent) throw new Error('Bluesky agent not initialized.');
    const persistedSessionData: Partial<AtpSessionData> = await db.readPersistData();

    try {
      if (!persistedSessionData.accessJwt)
        throw new Error('No persisted session data found. Using login/password.');
      const sessionData = persistedSessionData as AtpSessionData;
      const session = await bskyAgent.resumeSession(sessionData);
      if (session.success) {
        console.log(
          `[${new Date().toUTCString()}] - [bsky.rss LOGIN] Resumed session for ${
            session.data.handle
          }`,
        );
        return session;
      } else {
        throw new Error('Login failed (auth via persisted session)');
      }
    } catch {
      const loginData = await bskyAgent.login({identifier, password});
      if (!loginData.success) throw new Error('Login failed (auth via login/password)');
      return loginData;
    }
  }

  async function post({
    content,
    embed,
    languages,
    date,
    facets,
  }: {
    content: string;
    embed?: Embed;
    languages?: string[];
    date?: Date;
    facets?: MarkdownFacet[];
  }): Promise<{uri: string; cid: string} | {ratelimit: true; retryAfter?: number}> {
    if (!bskyAgent) throw new Error('Bluesky agent not initialized.');

    const autoDetect = new RichText({text: content});
    await autoDetect.detectFacets(bskyAgent);

    const bskyText = new RichText({
      text: content,
      // RichText's constructor sorts these on assignment (rich-text.ts:159-161) - no manual
      // sort needed here. buildFacets also drops any auto-detected facet that overlaps a
      // hand-built markdown-link one, so the two sources can never ship as nested/duplicate
      // facets in the same record.
      facets: buildFacets(facets ?? [], autoDetect.facets) as unknown as Facet[],
    });

    let embedImage: ComAtprotoRepoUploadBlob.Response | {ratelimit: true} | null = null;
    if (embed && embed.image) {
      try {
        embedImage = await bskyAgent.uploadBlob(embed.image, {
          encoding: 'image/jpeg',
        });
      } catch {
        embedImage = {ratelimit: true};
      }
    }
    if (embedImage && 'ratelimit' in embedImage) return {ratelimit: true};

    let embed_data = undefined;

    if (embed) {
      if (embed.type === 'image') {
        if (embed.image) {
          embed_data = {
            $type: 'app.bsky.embed.images',
            images: [
              {
                image: embed.image ? embedImage!.data.blob : undefined,
                alt: embed.imageAlt ? embed.imageAlt : '',
              },
            ],
          };
        }
      } else {
        embed_data = {
          $type: 'app.bsky.embed.external',
          external: {
            uri: embed.uri,
            title: embed.title,
            description: embed.description ? embed.description : '',
            thumb: embed.image ? embedImage!.data.blob : undefined,
          },
        };
      }
    }

    const record = {
      $type: 'app.bsky.feed.post',
      text: bskyText.text,
      facets: bskyText.facets,
      embed: embed_data,
      langs: languages,
      createdAt: date ? date.toISOString() : new Date().toISOString(),
    };

    let post: {uri: string; cid: string} | {ratelimit: true; retryAfter?: number} | undefined;
    try {
      post = await bskyAgent.post(record as unknown as AppBskyFeedPost.Record);
    } catch (error) {
      if (error instanceof Object && error.constructor.name === XRPCError.name) {
        const xrpc_error = error as XRPCError;

        if (xrpc_error.status === ResponseType.UpstreamTimeout) {
          const headers = xrpc_error.headers;

          if (headers && Object.hasOwn(headers, 'Retry-After') && headers['Retry-After']) {
            const retryAfter: number = +headers['Retry-After'];
            post = {ratelimit: true, retryAfter: retryAfter};
          }
        }
      }

      if (!post) post = {ratelimit: true, retryAfter: 30};
    }
    return post!;
  }

  return {init, login, post};
}

export type BskyHandler = ReturnType<typeof createBskyHandler>;
```

Every function body is byte-identical to today's; only the top-level `let bskyAgent`/`import db from './dbHandler.ts'` become closure state and a `db: DbHandler` parameter, respectively.

- [ ] **Step 2: Replace `app/utils/bskyHandler.test.ts` in full**

```ts
import {describe, it, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert';
import {mkdtempSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {RichText} from '@atproto/api';
import {createDbHandler} from './dbHandler.ts';
import {createBskyHandler, type BskyHandler} from './bskyHandler.ts';

/**
 * Tests for bskyHandler module
 *
 * Note: These tests focus on the module's contract and error handling.
 * Full integration tests with Bluesky API require real credentials and
 * are better suited for E2E tests.
 */

describe('bskyHandler', () => {
  let testDataDir: string;

  beforeEach(() => {
    testDataDir = mkdtempSync(path.join(tmpdir(), 'bsky-rss-test-'));
  });

  afterEach(() => {
    rmSync(testDataDir, {recursive: true, force: true});
  });

  function freshBskyHandler(): BskyHandler {
    return createBskyHandler(createDbHandler(testDataDir));
  }

  describe('Module exports', () => {
    it('should export init, login, and post functions', () => {
      const bskyHandler = freshBskyHandler();

      assert(typeof bskyHandler.init === 'function');
      assert(typeof bskyHandler.login === 'function');
      assert(typeof bskyHandler.post === 'function');
    });
  });

  describe('init()', () => {
    it('should require service URL parameter', async () => {
      const bskyHandler = freshBskyHandler();

      const agent = await bskyHandler.init('https://bsky.social');
      assert(agent, 'Agent should be returned');
      assert.strictEqual(typeof agent, 'object');
    });

    it('should throw error if initialized twice', async () => {
      const bskyHandler = freshBskyHandler();

      await bskyHandler.init('https://bsky.social');

      await assert.rejects(
        async () => {
          await bskyHandler.init('https://bsky.social');
        },
        {
          message: 'Bluesky agent already initialized.',
        },
      );
    });

    it('should create agent with different service URLs', async () => {
      const bskyHandler1 = freshBskyHandler();
      const agent1 = await bskyHandler1.init('https://bsky.social');
      assert(agent1);

      const bskyHandler2 = freshBskyHandler();
      const agent2 = await bskyHandler2.init('https://custom.bsky.host');
      assert(agent2);
    });
  });

  describe('login()', () => {
    it('should throw error if agent not initialized', async () => {
      const bskyHandler = freshBskyHandler();

      await assert.rejects(
        async () => {
          await bskyHandler.login({
            identifier: 'test.bsky.social',
            password: 'password',
          });
        },
        {
          message: 'Bluesky agent not initialized.',
        },
      );
    });

    it('should require identifier and password parameters', async () => {
      const bskyHandler = freshBskyHandler();
      await bskyHandler.init('https://bsky.social');

      const credentials = {
        identifier: 'test.bsky.social',
        password: 'test-password',
      };

      try {
        await bskyHandler.login(credentials);
      } catch (error) {
        assert(error instanceof Error, 'Expected an Error instance');
        assert(
          error.message.includes('Login failed') ||
            error.message.includes('Invalid') ||
            error.message.includes('fetch') ||
            error.message.includes('ENOTFOUND') ||
            error.message.includes('Forbidden') ||
            error.message.includes('Unauthorized') ||
            error.message.includes('Rate Limit'),
          `Error should be related to authentication or network: ${error.message}`,
        );
      }
    });
  });

  describe('post()', () => {
    it('should throw error if agent not initialized', async () => {
      const bskyHandler = freshBskyHandler();

      await assert.rejects(
        async () => {
          await bskyHandler.post({content: 'Test post'});
        },
        {
          message: 'Bluesky agent not initialized.',
        },
      );
    });

    it('should require content parameter', async () => {
      const bskyHandler = freshBskyHandler();
      await bskyHandler.init('https://bsky.social');

      const postData = {
        content: 'Test post content',
      };

      try {
        await bskyHandler.post(postData);
      } catch (error) {
        assert(error instanceof Error, 'Expected an Error instance');
        assert(
          error.message.includes('not initialized') ||
            error.message.includes('authenticated') ||
            error.message.includes('session') ||
            error.message.includes('Invalid token') ||
            typeof error === 'object',
          `Error should be related to authentication: ${error.message}`,
        );
      }
    });

    it('should accept optional parameters', async () => {
      const bskyHandler = freshBskyHandler();
      await bskyHandler.init('https://bsky.social');

      const postData = {
        content: 'Test post',
        languages: ['en', 'fr'],
        date: new Date('2026-08-05T10:00:00.000Z'),
        embed: {
          type: 'card',
          uri: 'https://example.com',
          title: 'Example',
          description: 'Description',
        },
      };

      try {
        await bskyHandler.post(postData);
      } catch (error) {
        assert(error instanceof Error, 'Expected an Error instance');
        assert(
          error.constructor.name !== 'TypeError' || !error.message.includes('undefined'),
          'Should not throw TypeError for valid parameters',
        );
      }
    });
  });

  describe('Type safety and parameter validation', () => {
    it('should handle embed with image type', () => {
      const embedImage = {
        type: 'image',
        image: Buffer.from('fake-image'),
        imageAlt: 'Test image',
      };

      assert.strictEqual(embedImage.type, 'image');
      assert(Buffer.isBuffer(embedImage.image));
      assert.strictEqual(embedImage.imageAlt, 'Test image');
    });

    it('should handle embed with card/external type', () => {
      const embedCard = {
        type: 'card',
        uri: 'https://example.com',
        title: 'Title',
        description: 'Description',
        image: Buffer.from('fake-thumb'),
      };

      assert.strictEqual(embedCard.type, 'card');
      assert.strictEqual(embedCard.uri, 'https://example.com');
      assert(Buffer.isBuffer(embedCard.image));
    });

    it('should handle languages array', () => {
      const languages = ['en', 'fr', 'de'];
      assert(Array.isArray(languages));
      assert.strictEqual(languages.length, 3);
    });

    it('should handle custom date', () => {
      const customDate = new Date('2026-08-05T10:00:00.000Z');
      assert(customDate instanceof Date);
      assert.strictEqual(customDate.toISOString(), '2026-08-05T10:00:00.000Z');
    });
  });

  describe('Error handling patterns', () => {
    it('should have consistent error messages', () => {
      const errors = {
        notInitialized: 'Bluesky agent not initialized.',
        alreadyInitialized: 'Bluesky agent already initialized.',
      };

      assert.strictEqual(errors.notInitialized, 'Bluesky agent not initialized.');
      assert.strictEqual(errors.alreadyInitialized, 'Bluesky agent already initialized.');
    });

    it('should validate initialization state before operations', async () => {
      const bskyHandler = freshBskyHandler();

      await assert.rejects(
        () => bskyHandler.login({identifier: 'test', password: 'test'}),
        /not initialized/,
      );

      await assert.rejects(() => bskyHandler.post({content: 'test'}), /not initialized/);

      await bskyHandler.init('https://bsky.social');
    });
  });

  describe('Module state management', () => {
    it('should maintain singleton agent across function calls', async () => {
      const bskyHandler = freshBskyHandler();

      await bskyHandler.init('https://bsky.social');

      await assert.rejects(() => bskyHandler.init('https://bsky.social'), /already initialized/);
    });

    it('should reset state when constructed again', async () => {
      let bskyHandler = freshBskyHandler();
      await bskyHandler.init('https://bsky.social');

      // A fresh instance starts with unset state, same as a reloaded module used to.
      bskyHandler = freshBskyHandler();

      const agent = await bskyHandler.init('https://bsky.social');
      assert(agent);
    });
  });

  describe('Integration contract', () => {
    it('should export functions that match expected signatures', () => {
      const bskyHandler = freshBskyHandler();

      assert.strictEqual(bskyHandler.init.length, 1); // service parameter
      assert.strictEqual(bskyHandler.login.length, 1); // credentials object
      assert.strictEqual(bskyHandler.post.length, 1); // post data object
    });

    it('should return expected types', async () => {
      const bskyHandler = freshBskyHandler();

      const agent = await bskyHandler.init('https://bsky.social');
      assert.strictEqual(typeof agent, 'object');
      assert(agent !== null);
    });
  });

  describe('post() facet merging', () => {
    it('constructing RichText with pre-merged facets keeps both sources, not just one', () => {
      // Guards the exact risk this task fixes: RichText.detectFacets() overwrites
      // this.facets entirely (confirmed in @atproto/api's own source), so post() must never
      // call detectFacets() on a RichText that already carries hand-built markdown-link
      // facets. This test exercises the real RichText constructor's documented contract
      // (pass facets in, they're kept) without needing a live agent.
      const markdownFacets = [
        {
          index: {byteStart: 0, byteEnd: 6},
          features: [{$type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/report'}],
        },
      ];
      const autoDetectedFacets = [
        {
          index: {byteStart: 7, byteEnd: 12},
          features: [{$type: 'app.bsky.richtext.facet#tag', tag: 'news'}],
        },
      ];

      const richText = new RichText({
        text: 'Report #news',
        facets: [...markdownFacets, ...autoDetectedFacets],
      });

      assert.equal(richText.facets?.length, 2);
      assert.deepEqual(richText.facets?.[0]?.index, {byteStart: 0, byteEnd: 6});
      assert.deepEqual(richText.facets?.[1]?.index, {byteStart: 7, byteEnd: 12});
    });

    it('post() merges hand-built facets with auto-detected ones end-to-end, via buildFacets', async () => {
      const bskyHandler = freshBskyHandler();
      const agent = await bskyHandler.init('https://bsky.social');

      let capturedRecord:
        | {
            facets: Array<{
              index: {byteStart: number; byteEnd: number};
              features: Array<{$type: string; tag?: string}>;
            }>;
          }
        | undefined;
      agent.post = async (record: typeof capturedRecord) => {
        capturedRecord = record;
        return {uri: 'at://did:plc:test/app.bsky.feed.post/abc', cid: 'bafycid'};
      };

      const result = await bskyHandler.post({
        content: 'Report #news',
        facets: [{byteStart: 0, byteEnd: 6, uri: 'https://example.com/report'}],
      });

      assert.deepStrictEqual(result, {
        uri: 'at://did:plc:test/app.bsky.feed.post/abc',
        cid: 'bafycid',
      });
      assert.strictEqual(capturedRecord!.facets.length, 2);
      const linkFacet = capturedRecord!.facets.find(
        f => f.features[0]?.$type === 'app.bsky.richtext.facet#link',
      );
      assert.deepStrictEqual(linkFacet?.index, {byteStart: 0, byteEnd: 6});
      const tagFacet = capturedRecord!.facets.find(
        f => f.features[0]?.$type === 'app.bsky.richtext.facet#tag',
      );
      assert.strictEqual(tagFacet?.features[0]?.tag, 'news');
    });

    it('post() drops an auto-detected facet that overlaps a hand-built markdown-link facet, end-to-end', async () => {
      const bskyHandler = freshBskyHandler();
      const agent = await bskyHandler.init('https://bsky.social');

      let capturedRecord:
        | {
            facets: Array<{
              index: {byteStart: number; byteEnd: number};
              features: Array<{$type: string; uri?: string}>;
            }>;
          }
        | undefined;
      agent.post = async (record: typeof capturedRecord) => {
        capturedRecord = record;
        return {uri: 'at://did:plc:test/app.bsky.feed.post/xyz', cid: 'bafycid'};
      };

      const content = 'Visit https://overlap.example now';
      const facetByteEnd = Buffer.byteLength(content, 'utf8');

      await bskyHandler.post({
        content,
        facets: [{byteStart: 0, byteEnd: facetByteEnd, uri: 'https://example.com/whole'}],
      });

      assert.strictEqual(capturedRecord!.facets.length, 1);
      assert.deepStrictEqual(capturedRecord!.facets[0]?.index, {
        byteStart: 0,
        byteEnd: facetByteEnd,
      });
      assert.strictEqual(capturedRecord!.facets[0]?.features[0]?.uri, 'https://example.com/whole');
    });
  });
});
```

Every `(await import(\`./bskyHandler.ts?t=${crypto.randomUUID()}\`)).default` call site (18 occurrences in today's file) becomes `freshBskyHandler()` — a plain synchronous call, no `await`/`import()` needed since `createBskyHandler` isn't async. The "should reset state when module is reloaded" test is renamed to "should reset state when constructed again" and its body simplified accordingly (constructing a second instance is now direct, not a module reload). Added `error.message.includes('Rate Limit')` to the "should require identifier and password parameters" test's acceptable-error list — this session's cumulative real login attempts against bsky.social have occasionally produced a real rate-limit response instead of an auth/network error; both are equally valid evidence the function attempted real authentication, which is all this test checks.

- [ ] **Step 3: Run typecheck, confirm the expected transient state**

Run: `yarn typecheck`
Expected: zero errors in `dbHandler.ts`, `dbHandler.test.ts`, `bskyHandler.ts`, `bskyHandler.test.ts`. Errors remain in `app/utils/queueHandler.ts`, `app/utils/rssHandler.ts`, `app/index.ts`.

- [ ] **Step 4: Run the test file, expect all tests pass**

Run: `npx tsx --test app/utils/bskyHandler.test.ts`
Expected: all 22 tests pass (matching today's count).

- [ ] **Step 5: Commit**

```bash
git add app/utils/bskyHandler.ts app/utils/bskyHandler.test.ts
git commit -m "refactor: convert bskyHandler to a factory function

createBskyHandler(db) takes its DbHandler dependency directly instead
of importing the dbHandler module singleton. bskyHandler.test.ts
constructs fresh instances via createBskyHandler() instead of
cache-busted re-imports."
```

---

### Task 3: queueHandler factory

**Files:**
- Modify: `app/utils/queueHandler.ts` (full rewrite, shown below)
- Modify: `app/utils/queueHandler.test.ts` (full rewrite, shown below)

**Interfaces:**
- Consumes: `import type {BskyHandler} from './bskyHandler.ts';` and `import type {DbHandler} from './dbHandler.ts';` (Tasks 1-2), plus `import {createBskyHandler} from './bskyHandler.ts';` and `import {createDbHandler} from './dbHandler.ts';` in the test file only. `app/utils/healthHandler.ts`'s existing default-export singleton is imported unchanged (`import health from './healthHandler.ts';`) — out of scope for this plan.
- Produces: `createQueueHandler(bsky: BskyHandler, db: DbHandler)` returning `{writeQueue, start, runQueue}` (same signatures as today's default export). `export type QueueHandler = ReturnType<typeof createQueueHandler>;` — Task 4 imports this type.

**Expected transient typecheck state after this task:** `dbHandler.ts`, `dbHandler.test.ts`, `bskyHandler.ts`, `bskyHandler.test.ts`, `queueHandler.ts`, `queueHandler.test.ts` show zero errors. `app/utils/rssHandler.ts` (does `import queue from './queueHandler.ts';`, a default import) continues to show an error from before, now for a new reason. `app/utils/rssHandler.test.ts` **also** shows a new error at this point — it does `import queueHandler from './queueHandler.ts';` as a static default import (used as the monkey-patch target for its 6 "Cross-poll deduplication" tests), which breaks now that `queueHandler.ts` no longer default-exports; Task 4 removes this import entirely rather than fixing it, since the monkey-patch pattern itself goes away. `app/index.ts` continues to show its accumulated errors from Tasks 2-3 (`bsky`, now also `queue`). All expected, fixed by Task 4 (`rssHandler.ts`, `rssHandler.test.ts`) and Task 5 (`app/index.ts`).

- [ ] **Step 1: Replace `app/utils/queueHandler.ts` in full**

```ts
import type {BskyHandler} from './bskyHandler.ts';
import type {DbHandler} from './dbHandler.ts';
import health from './healthHandler.ts';

export function createQueueHandler(bsky: BskyHandler, db: DbHandler) {
  const queue: QueueItems[] = [];
  let rateLimited: boolean = false;
  let queueRunning: boolean = false;
  let queueSnapshot: QueueItems[] = [];
  let lastPostTimestamp = 0;

  let config: Config = {
    string: '',
    publishEmbed: false,
    embedType: 'card',
    languages: ['en'],
    truncate: true,
    runInterval: 60,
    dateField: '',
    publishDate: false,
    imageField: '',
    ogUserAgent: 'bsky.rss/1.0 (Open Graph Scraper)',
    descriptionClearHTML: true,
    forceDescriptionEmbed: false,
    imageAlt: '',
    removeDuplicate: false,
    titleClearHTML: false,
    adaptiveSpacing: false,
    spacingWindow: 600,
    minSpacing: 1,
    maxSpacing: 60,
  };

  async function start() {
    config = await db.initConfig();
    console.log(
      `[${new Date().toUTCString()}] - [bsky.rss QUEUE] Starting queue handler. Running every ${
        config.runInterval
      } seconds`,
    );
    setInterval(() => {
      void runQueue();
    }, config.runInterval * 1000);
  }

  async function createLimitTimer(timeoutSeconds: number = 30) {
    if (rateLimited) return; // Already rate limited, don't create another timer
    rateLimited = true;
    setTimeout(() => {
      rateLimited = false;
      void runQueue();
      console.log(
        `[${new Date().toUTCString()}] - [bsky.rss QUEUE] Post rate limit expired - resuming queue`,
      );
    }, timeoutSeconds * 1000);
    return '';
  }

  async function runQueue() {
    if (queueRunning) return;
    // Marks activity on every tick, not just ticks that find something to post -
    // an idle bot (no new items, the normal case for most feeds) is still alive
    // and functioning, so it must not go stale and start failing health checks.
    health.updateActivity();
    queueSnapshot = [...queue];
    if (queueSnapshot.length === 0) return queueSnapshot;
    console.log(
      `[${new Date().toUTCString()}] - [bsky.rss QUEUE] Running queue with ${
        queueSnapshot.length
      } items`,
    );
    if (rateLimited) return {ratelimit: true};
    if (queueSnapshot.length > 0) {
      queueRunning = true;
      for (let i = 0; i < queueSnapshot.length; i++) {
        const item = queueSnapshot[i] as QueueItems;
        queue.splice(i, 1);
        queueSnapshot.splice(i, 1);
        i--;
        if (config.minSpacing && lastPostTimestamp) {
          const elapsed = Date.now() - lastPostTimestamp;
          const waitMs = config.minSpacing * 1000 - elapsed;
          if (waitMs > 0) {
            const waitSec = Math.ceil(waitMs / 1000);
            console.log(
              `[${new Date().toUTCString()}] - [bsky.rss QUEUE] Waiting ${waitSec} seconds before next post`,
            );
            await sleep(waitMs);
          }
        }
        const post = await bsky.post({
          content: item.content,
          embed: item.embed,
          languages: item.languages,
          date: config.publishDate ? new Date(item.date) : undefined,
          facets: item.facets,
        });
        if ('ratelimit' in post) {
          queue.unshift(item);
          const timeoutSeconds: number = post.retryAfter ? post.retryAfter : 30;
          await createLimitTimer(timeoutSeconds);
          queueRunning = false;
          console.log(
            `[${new Date().toUTCString()}] - [bsky.rss POST] Post rate limit exceeded - process will resume after ${timeoutSeconds} seconds`,
          );
          break;
        } else {
          console.log(
            `[${new Date().toUTCString()}] - [bsky.rss POST] Posting new item (${item.title})`,
          );
          void db.writeDate(new Date(item.date));
          lastPostTimestamp = Date.now();
          // A large backlog drains inside this same runQueue() call, holding
          // queueRunning true for the whole drain - later setInterval ticks
          // bail out immediately (see the guard above) without ever reaching
          // the top-of-function updateActivity() call, so a long drain must
          // refresh activity here too or it goes stale mid-drain despite
          // actively posting.
          health.updateActivity();
          if (config.adaptiveSpacing && queueSnapshot.length > 0) {
            const remaining = queueSnapshot.length;
            const delaySec = computeDelay(remaining + 1);

            if (delaySec > 0) {
              console.log(
                `[${new Date().toUTCString()}] - [bsky.rss QUEUE] Waiting ${delaySec} seconds before next post`,
              );
              await sleep(delaySec * 1000);
            }
          }
          if (i === queueSnapshot.length - 1) {
            queueRunning = false;
            queueSnapshot = [];
            console.log(
              `[${new Date().toUTCString()}] - [bsky.rss QUEUE] Finished running queue. Next run in ${
                config.runInterval
              } seconds`,
            );
            if (config.removeDuplicate) void db.cleanupOldValues();
          }
        }
      }
      return queue;
    } else {
      return queue;
    }
  }

  async function writeQueue({content, embed, languages, title, date, facets}: QueueItems) {
    console.log(`[${new Date().toUTCString()}] - [bsky.rss QUEUE] Queuing item (${title})`);
    queue.push({content, embed, languages, title, date, facets});
    return queue;
  }

  function computeDelay(q: number) {
    if (!config.adaptiveSpacing) return 0;
    if (q <= 1) return 0;
    const window = config.spacingWindow || 600;
    const min = config.minSpacing || 1;
    const max = config.maxSpacing || 60;
    return clamp(window / q, min, max);
  }

  return {writeQueue, start, runQueue};
}

export type QueueHandler = ReturnType<typeof createQueueHandler>;

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

Every function body is byte-identical to today's; `queue`/`rateLimited`/`queueRunning`/`queueSnapshot`/`lastPostTimestamp`/`config` move into the closure, `bsky`/`db` become parameters, `health` stays a plain top-level import (unchanged, per the design's ponytail-trimmed scope). `clamp` and `sleep` are pure (no closure dependency) and stay module-level, same as `computeDelay` needing to stay inside the factory since it reads `config`.

- [ ] **Step 2: Replace `app/utils/queueHandler.test.ts` in full**

```ts
import {describe, it, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert';
import fs, {mkdtempSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import healthHandler from './healthHandler.ts';
import {createDbHandler} from './dbHandler.ts';
import {createBskyHandler} from './bskyHandler.ts';
import {createQueueHandler, type QueueHandler} from './queueHandler.ts';

/**
 * Tests for queueHandler module
 *
 * Note: These tests focus on the module's queue management logic and
 * adaptive spacing calculations. Full integration tests with Bluesky
 * posting require authentication and are better suited for E2E tests.
 */

describe('queueHandler', () => {
  let testDataDir: string;
  let queueHandler: QueueHandler;

  beforeEach(() => {
    testDataDir = mkdtempSync(path.join(tmpdir(), 'bsky-rss-test-'));

    // Create minimal config for tests
    const testConfig = {
      string: '$title - $link',
      publishEmbed: true,
      embedType: 'card',
      languages: ['en'],
      truncate: true,
      runInterval: 60,
      dateField: '',
      publishDate: false,
      imageField: '',
      ogUserAgent: 'bsky.rss/test',
      descriptionClearHTML: true,
      forceDescriptionEmbed: false,
      imageAlt: '$title',
      removeDuplicate: false,
      titleClearHTML: false,
      adaptiveSpacing: false,
      spacingWindow: 600,
      minSpacing: 1,
      maxSpacing: 60,
    };

    fs.writeFileSync(path.join(testDataDir, 'config.json'), JSON.stringify(testConfig), 'utf8');

    const db = createDbHandler(testDataDir);
    const bsky = createBskyHandler(db);
    queueHandler = createQueueHandler(bsky, db);
  });

  afterEach(() => {
    rmSync(testDataDir, {recursive: true, force: true});
  });

  describe('Module exports', () => {
    it('should export writeQueue and start functions', () => {
      assert(typeof queueHandler.writeQueue === 'function');
      assert(typeof queueHandler.start === 'function');
    });
  });

  describe('writeQueue()', () => {
    it('should add item to queue', async () => {
      const item = {
        content: 'Test post content',
        title: 'Test Article',
        date: new Date('2026-08-05T10:00:00.000Z').toString(),
        languages: ['en'],
        embed: undefined,
        facets: [],
      };

      const result = await queueHandler.writeQueue(item);

      assert(Array.isArray(result));
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.content, item.content);
      assert.strictEqual(result[0]!.title, item.title);
    });

    it('should accept item with embed', async () => {
      const item = {
        content: 'Post with embed',
        title: 'Article with Card',
        date: new Date().toString(),
        languages: ['en'],
        embed: {
          type: 'card',
          uri: 'https://example.com/article',
          title: 'Example Article',
          description: 'Description',
        },
        facets: [],
      };

      const result = await queueHandler.writeQueue(item);

      assert.strictEqual(result.length, 1);
      assert(result[0]!.embed);
      assert.strictEqual(result[0]!.embed.uri, 'https://example.com/article');
    });

    it('should add multiple items to queue', async () => {
      await queueHandler.writeQueue({
        content: 'Post 1',
        title: 'Article 1',
        date: new Date().toString(),
        languages: ['en'],
        embed: undefined,
        facets: [],
      });

      await queueHandler.writeQueue({
        content: 'Post 2',
        title: 'Article 2',
        date: new Date().toString(),
        languages: ['en'],
        embed: undefined,
        facets: [],
      });

      const queue = await queueHandler.writeQueue({
        content: 'Post 3',
        title: 'Article 3',
        date: new Date().toString(),
        languages: ['en'],
        embed: undefined,
        facets: [],
      });

      assert.strictEqual(queue.length, 3);
    });

    it('should preserve item order in queue', async () => {
      await queueHandler.writeQueue({
        content: 'First',
        title: 'First Article',
        date: new Date().toString(),
        languages: ['en'],
        embed: undefined,
        facets: [],
      });

      await queueHandler.writeQueue({
        content: 'Second',
        title: 'Second Article',
        date: new Date().toString(),
        languages: ['en'],
        embed: undefined,
        facets: [],
      });

      const queue = await queueHandler.writeQueue({
        content: 'Third',
        title: 'Third Article',
        date: new Date().toString(),
        languages: ['en'],
        embed: undefined,
        facets: [],
      });

      assert.strictEqual(queue[0]!.content, 'First');
      assert.strictEqual(queue[1]!.content, 'Second');
      assert.strictEqual(queue[2]!.content, 'Third');
    });

    it('should handle items with all optional fields', async () => {
      const item = {
        content: 'Complete post',
        title: 'Complete Article',
        date: new Date('2026-08-05T10:00:00.000Z').toString(),
        languages: ['en', 'fr'],
        embed: {
          uri: 'https://example.com/complete-article',
          title: 'Complete Article',
          type: 'image',
          image: Buffer.from('fake-image'),
          imageAlt: 'Image description',
        },
        facets: [],
      };

      const result = await queueHandler.writeQueue(item);

      assert.strictEqual(result[0]!.content, item.content);
      assert.strictEqual(result[0]!.title, item.title);
      assert.strictEqual(result[0]!.date, item.date);
      assert.deepStrictEqual(result[0]!.languages, item.languages);
      assert(result[0]!.embed);
    });

    it('should return queue array', async () => {
      const result = await queueHandler.writeQueue({
        content: 'Test',
        title: 'Test',
        date: new Date().toString(),
        languages: ['en'],
        embed: undefined,
        facets: [],
      });

      assert(Array.isArray(result));
      assert(result.length > 0);
    });
  });

  describe('start()', () => {
    it('should be a function', () => {
      assert.strictEqual(typeof queueHandler.start, 'function');
    });

    // Note: Cannot test start() directly in unit tests because it creates
    // an interval that would cause tests to hang. The interval-based queue
    // processing is better tested in integration/E2E tests.
  });

  describe('runQueue() health activity tracking', () => {
    it('updates health activity even when the queue is empty', async () => {
      // Break: health.updateActivity() was only reachable after the
      // queueSnapshot.length === 0 early return, so a tick that found
      // nothing new to post never refreshed activity - a perfectly healthy,
      // idle bot (the normal case for most feeds) flips /health to 503
      // after 10 minutes of silence with no new items.
      // Monkey-patched instead of routed through the real HTTP server:
      // healthHandler is a singleton also driven by healthHandler.test.ts,
      // and starting/stopping the same server from two test files races.
      let updateActivityCalled = false;
      const original = healthHandler.updateActivity;
      healthHandler.updateActivity = () => {
        updateActivityCalled = true;
      };

      try {
        await queueHandler.runQueue();
      } finally {
        healthHandler.updateActivity = original;
      }

      assert.strictEqual(
        updateActivityCalled,
        true,
        'runQueue() with an empty queue should still call health.updateActivity()',
      );
    });
  });

  describe('Adaptive spacing calculations', () => {
    it('should compute delay for queue with multiple items', () => {
      const config = {
        adaptiveSpacing: true,
        spacingWindow: 600,
        minSpacing: 1,
        maxSpacing: 60,
      };

      const queueSize = 10;
      const expectedDelay = config.spacingWindow / queueSize;

      assert.strictEqual(expectedDelay, 60);
    });

    it('should clamp delay to maxSpacing', () => {
      const config = {
        adaptiveSpacing: true,
        spacingWindow: 600,
        minSpacing: 1,
        maxSpacing: 60,
      };

      const queueSize = 5;
      const calculatedDelay = config.spacingWindow / queueSize;
      const clampedDelay = Math.max(
        config.minSpacing,
        Math.min(config.maxSpacing, calculatedDelay),
      );

      assert.strictEqual(clampedDelay, 60);
    });

    it('should clamp delay to minSpacing', () => {
      const config = {
        adaptiveSpacing: true,
        spacingWindow: 600,
        minSpacing: 1,
        maxSpacing: 60,
      };

      const queueSize = 1000;
      const calculatedDelay = config.spacingWindow / queueSize;
      const clampedDelay = Math.max(
        config.minSpacing,
        Math.min(config.maxSpacing, calculatedDelay),
      );

      assert.strictEqual(clampedDelay, 1);
    });

    it('should return 0 delay when adaptiveSpacing is disabled', () => {
      const config = {
        adaptiveSpacing: false,
        spacingWindow: 600,
        minSpacing: 1,
        maxSpacing: 60,
      };

      const queueSize = 10;
      const delay = config.adaptiveSpacing ? config.spacingWindow / queueSize : 0;

      assert.strictEqual(delay, 0);
    });

    it('should return 0 delay for single item queue', () => {
      const queueSize = 1;
      const delay = queueSize <= 1 ? 0 : 600 / queueSize;

      assert.strictEqual(delay, 0);
    });

    it('should compute correct delay for various queue sizes', () => {
      const config = {
        spacingWindow: 600,
        minSpacing: 1,
        maxSpacing: 60,
      };

      const testCases = [
        {queueSize: 2, expected: 60},
        {queueSize: 10, expected: 60},
        {queueSize: 20, expected: 30},
        {queueSize: 100, expected: 6},
        {queueSize: 600, expected: 1},
      ];

      testCases.forEach(tc => {
        const delay = Math.max(
          config.minSpacing,
          Math.min(config.maxSpacing, config.spacingWindow / tc.queueSize),
        );
        assert.strictEqual(
          delay,
          tc.expected,
          `Queue size ${tc.queueSize} should have delay ${tc.expected}`,
        );
      });
    });
  });

  describe('Configuration handling', () => {
    it('should handle config with all fields', () => {
      const fullConfig = {
        string: '$title - $link',
        publishEmbed: true,
        embedType: 'card',
        languages: ['en', 'fr'],
        truncate: true,
        runInterval: 60,
        dateField: 'pubDate',
        publishDate: true,
        imageField: 'enclosure',
        ogUserAgent: 'custom-agent',
        descriptionClearHTML: true,
        forceDescriptionEmbed: false,
        imageAlt: '$title',
        removeDuplicate: true,
        titleClearHTML: false,
        adaptiveSpacing: true,
        spacingWindow: 300,
        minSpacing: 2,
        maxSpacing: 30,
      };

      assert.strictEqual(typeof fullConfig.string, 'string');
      assert.strictEqual(typeof fullConfig.publishEmbed, 'boolean');
      assert(Array.isArray(fullConfig.languages));
      assert.strictEqual(typeof fullConfig.runInterval, 'number');
      assert.strictEqual(typeof fullConfig.adaptiveSpacing, 'boolean');
      assert.strictEqual(typeof fullConfig.spacingWindow, 'number');
    });

    it('should use default values when fields are missing', () => {
      const minimalConfig = {
        string: '$title',
        publishEmbed: false,
        embedType: 'card',
        languages: ['en'],
        truncate: true,
        runInterval: 60,
        dateField: '',
        publishDate: false,
        imageField: '',
        ogUserAgent: 'bsky.rss/1.0',
        descriptionClearHTML: true,
        forceDescriptionEmbed: false,
        imageAlt: '',
        removeDuplicate: false,
        titleClearHTML: false,
        adaptiveSpacing: false,
        spacingWindow: 600,
        minSpacing: 1,
        maxSpacing: 60,
      };

      assert.strictEqual(minimalConfig.adaptiveSpacing, false);
      assert.strictEqual(minimalConfig.spacingWindow, 600);
      assert.strictEqual(minimalConfig.minSpacing, 1);
      assert.strictEqual(minimalConfig.maxSpacing, 60);
    });
  });

  describe('Queue item structure', () => {
    it('should accept valid queue item', () => {
      const item = {
        content: 'Test content',
        title: 'Test title',
        date: new Date().toString(),
        languages: ['en'],
        embed: {
          type: 'card',
          uri: 'https://example.com',
          title: 'Link title',
        },
      };

      assert.strictEqual(typeof item.content, 'string');
      assert.strictEqual(typeof item.title, 'string');
      assert(Array.isArray(item.languages));
      assert(item.embed);
    });

    it('should handle item without embed', () => {
      const item = {
        content: 'Simple post',
        title: 'Simple title',
        date: new Date().toString(),
        languages: ['en'],
        embed: undefined,
      };

      assert.strictEqual(item.embed, undefined);
    });

    it('should handle item with image embed', () => {
      const item = {
        content: 'Post with image',
        title: 'Image post',
        date: new Date().toString(),
        languages: ['en'],
        embed: {
          type: 'image',
          image: Buffer.from('fake-data'),
          imageAlt: 'Description',
        },
      };

      assert.strictEqual(item.embed.type, 'image');
      assert(Buffer.isBuffer(item.embed.image));
    });

    it('should handle multiple languages', () => {
      const item = {
        content: 'Multilingual post',
        title: 'Title',
        date: new Date().toString(),
        languages: ['en', 'fr', 'de'],
      };

      assert.strictEqual(item.languages.length, 3);
      assert(item.languages.includes('en'));
      assert(item.languages.includes('fr'));
      assert(item.languages.includes('de'));
    });
  });
});
```

`TEST_DATA_DIR`/the top-level `before` hook are gone — `testDataDir` is created fresh per test in `beforeEach`, removed in `afterEach`. The `after` hook that deleted `config.json` from the real data directory is gone (nothing to clean up in the real directory anymore). `queueHandler` construction changes from a cache-busted `import()` to `createQueueHandler(bsky, db)` built from fresh `createDbHandler`/`createBskyHandler` calls. `healthHandler` is untouched — `queueHandler.ts` still imports it as a plain singleton, so this file's existing monkey-patch of `healthHandler.updateActivity` still works exactly as before (same shared singleton object, no change needed to that test).

- [ ] **Step 3: Run typecheck, confirm the expected transient state**

Run: `yarn typecheck`
Expected: zero errors in `dbHandler.ts`, `bskyHandler.ts`, `queueHandler.ts`, and their test files. Errors remain in `app/utils/rssHandler.ts` and `app/index.ts`.

- [ ] **Step 4: Run the test file, expect all tests pass**

Run: `npx tsx --test app/utils/queueHandler.test.ts`
Expected: all 21 tests pass (matching today's count).

- [ ] **Step 5: Commit**

```bash
git add app/utils/queueHandler.ts app/utils/queueHandler.test.ts
git commit -m "refactor: convert queueHandler to a factory function

createQueueHandler(bsky, db) takes its dependencies directly instead
of importing the bskyHandler/dbHandler module singletons. healthHandler
stays a plain singleton import (out of scope - see the design's
ponytail-trimmed scope). queueHandler.test.ts constructs fresh
instances via createQueueHandler() instead of cache-busted re-imports."
```

---

### Task 4: rssHandler factory

**Files:**
- Modify: `app/utils/rssHandler.ts` (full rewrite, shown below)
- Modify: `app/utils/rssHandler.test.ts` (full rewrite, shown below)

**Interfaces:**
- Consumes: `import type {QueueHandler} from './queueHandler.ts';` and `import type {DbHandler} from './dbHandler.ts';` (Tasks 1, 3), plus `createDbHandler`/`createBskyHandler`/`createQueueHandler` in the test file only.
- Produces: `createRssHandler(queue: QueueHandler, db: DbHandler)` returning `{start, init, launch, parseString}` (same signatures as today's default export). `export type RssHandler = ReturnType<typeof createRssHandler>;` — Task 5 imports this type.

**Expected transient typecheck state after this task:** every handler file and its test file show zero errors. Only `app/index.ts` still shows errors — it does `import bsky from './utils/bskyHandler.ts';`, `import reader from './utils/rssHandler.ts';`, and `import queue from './utils/queueHandler.ts';` as default imports, all of which broke across Tasks 2-4 (`app/index.ts` never imports `dbHandler.ts` directly, so there's no fourth error to fix there) — expected, fixed by Task 5.

- [ ] **Step 1: Replace `app/utils/rssHandler.ts` in full**

```ts
import {Jimp, JimpMime} from 'jimp';
import axios from 'axios';
import type {QueueHandler} from './queueHandler.ts';
import type {DbHandler} from './dbHandler.ts';
import og from 'open-graph-scraper';
import {decode} from 'html-entities';
import {createFeedSource} from '../../shared/feedSource/index.ts';
import type {FeedSource, NormalizedItem} from '../../shared/feedSource/index.ts';
import {
  extractMarkdownLinks,
  finalizeMarkdownLinks,
} from '../../shared/feedSource/markdownLinks.ts';

export function createRssHandler(queue: QueueHandler, db: DbHandler) {
  let reader: FeedSource | null = null;
  let lastDate: string = '';
  // Tracks the newest date seen *within the batch currently being processed*, committed
  // into lastDate only once the whole batch finishes (see onItems below). Advancing
  // lastDate per-item instead would drop every item but the first in a newest-first
  // feed: after queueing item 1 (the newest), lastDate would already be past item 2's
  // date, so item 2 would fail the staleness guard and be silently dropped forever -
  // not merely delayed, since lastDate never rewinds.
  let batchMax: string = '';

  let config: Config = {
    string: '',
    publishEmbed: false,
    languages: ['en'],
    truncate: true,
    runInterval: 60,
    publishDate: false,
    dateField: '',
    imageField: '',
    ogUserAgent: 'bsky.rss/1.0 (Open Graph Scraper)',
    descriptionClearHTML: true,
    forceDescriptionEmbed: false,
    removeDuplicate: false,
    titleClearHTML: false,
    adaptiveSpacing: false,
    spacingWindow: 600,
    minSpacing: 1,
    maxSpacing: 60,
  };

  async function start() {
    if (!reader) throw new Error('Reader not initialized.');

    reader.start({
      onItems: () => {
        if (batchMax && (!lastDate || new Date(batchMax) > new Date(lastDate))) {
          lastDate = batchMax;
        }
        batchMax = '';
      },
      onItem: handleItem,
      onError: err => {
        console.log(
          `[${new Date().toUTCString()}] - [bsky.rss FETCH] Feed error: ${err.message}${
            err.cause ? ` (${String(err.cause)})` : ''
          }`,
        );
      },
    });
  }

  async function handleItem(item: NormalizedItem): Promise<void> {
    // dateField historically pointed at an arbitrary raw feedme tag name (feedme kept
    // every tag from the source feed as a flat property). NormalizedItem no longer
    // carries arbitrary per-feed fields - only its own fixed shape - so dateField now
    // only resolves against NormalizedItem's own field names. All 59 live bot configs
    // leave dateField empty today, so this has no real-world effect; kept for config
    // compatibility per the migration spec's Non-goals, not redesigned.
    const useDate = config.dateField
      ? (item as unknown as Record<string, string | undefined>)[config.dateField]
      : item.date;
    if (!useDate) return console.log('No date provided by RSS reader for post.');

    const parsed = parseString(config.string, item, config.truncate === true);
    let embed: Embed | undefined = undefined;
    let title: string | undefined = undefined;

    if (config.publishEmbed) {
      if (!item.link) throw new Error('No link provided from RSS reader to fetch Open Graph data.');
      const url = item.link;

      if (config.removeDuplicate) {
        if (await db.valueExists(url)) return;
        else await db.writeValue(url);
      } else {
        if (new Date(useDate) <= new Date(lastDate)) return;
      }

      let image: Buffer | undefined = item.imageUrl ? await fetchImage(item.imageUrl) : undefined;
      let description: string | undefined = undefined;
      let imageAlt: string | undefined = undefined;

      if (image === undefined && item.imageUrl) {
        console.log(
          `[${new Date().toUTCString()}] - [bsky.rss FETCH] Error fetching image for ${
            item.title
          } (${item.imageUrl})`,
        );
      }

      if (config.forceDescriptionEmbed) {
        description = item.description ? item.description : item.content ? item.content : undefined;

        if (description && config.descriptionClearHTML) {
          description = removeHTMLTags(description);
        }
      }

      if (config.embedType === 'image' && config.imageAlt) {
        imageAlt = parseString(config.imageAlt, item, false).text;
      }

      const defaultUserAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      const userAgent = config.ogUserAgent || defaultUserAgent;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const openGraphData: any = await og({
        url,
        timeout: 10000,
        fetchOptions: {
          headers: {
            'user-agent': userAgent,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
          },
        },
      })
        .then(res => (res.error ? {error: true} : res.result))
        .catch(() => ({
          error: true,
        }));

      if (!openGraphData.error) {
        if (image === undefined && openGraphData.ogImage) {
          const imageUrl: string = openGraphData.ogImage[0].url;

          if (imageUrl !== '' && imageUrl !== undefined) {
            image = await fetchImage(imageUrl);

            if (image === undefined) {
              console.log(
                `[${new Date().toUTCString()}] - [bsky.rss FETCH] Error fetching image for ${
                  item.title
                } (${imageUrl})`,
              );
            }
          }

          if (description === undefined) {
            description = openGraphData.ogDescription
              ? openGraphData.ogDescription
              : item.description
                ? item.description
                : item.content
                  ? item.content
                  : undefined;
          }
        }

        if (description !== undefined && config.descriptionClearHTML) {
          description = removeHTMLTags(description);
        }

        let uri = openGraphData.ogUrl ? fixMalformedUrl(openGraphData.ogUrl) : url;

        if (openGraphData.ogUrl) {
          const regexURL = new RegExp(
            '^(h|H)(t|T)(t|T)(p|P)(s|S)?:\\/\\/[-a-zA-Z0-9@:%._\\+~#=]{1,256}\\.[a-zA-Z0-9()]{1,6}\\b([-a-zA-Z0-9()@:%_\\+.~#?&//=]*)',
          );

          if (!regexURL.test(uri)) uri = url;
        }

        if (!uri || (!openGraphData.ogTitle && !item.title)) {
          embed = undefined;
        } else {
          embed = {
            uri: uri,
            title: openGraphData.ogTitle ? openGraphData.ogTitle : (item.title ?? ''),
            description: description,
            image: image,
            imageAlt: imageAlt,
            type: config.embedType,
          };
        }
      } else {
        console.log(
          `[${new Date().toUTCString()}] - [bsky.rss FETCH] Error fetching Open Graph data for ${
            item.title
          } (${url})`,
        );

        description = item.description || item.content;
        if (description && config.descriptionClearHTML) {
          description = removeHTMLTags(description);
        }

        embed = {
          uri: url,
          title: item.title ?? '',
          description: description,
          image: image,
          imageAlt: imageAlt,
          type: config.embedType,
        };
      }
    }

    if (new Date(useDate) <= new Date(lastDate)) return;

    title = item.title ?? '';

    if (title && config.titleClearHTML) {
      title = decodeHTML(removeHTMLTags(title));
    }

    await queue.writeQueue({
      content: parsed.text,
      title: title,
      embed: config.publishEmbed ? embed : undefined,
      languages: config.languages ? config.languages : undefined,
      date: useDate,
      facets: parsed.facets,
    });

    // Track the newest queued date in this batch; committed into lastDate once the whole
    // batch finishes (onItems, above) - not here, and not re-read from db.readLast():
    // last.txt only advances on a successful *publish*, so a slow queue drain would let
    // the poller re-queue items that are already waiting in the queue.
    if (!batchMax || new Date(useDate) > new Date(batchMax)) batchMax = useDate;
  }

  async function init({fetch_interval, fetch_url}: {fetch_interval: number; fetch_url: URL}) {
    config = await db.initConfig();
    if (!config.string) throw new Error('No string provided.');

    lastDate = await db.readLast();
    reader = createFeedSource(fetch_url, fetch_interval, {
      imageField: config.imageField,
      mappedValues: config.mappedValues,
    });
    return reader;
  }

  async function launch() {
    return reader;
  }

  function parseString(string: string, item: NormalizedItem, truncate: boolean) {
    const result: ParseResult = {
      text: '',
      facets: [],
    };

    function resolveToken(token: string): string | undefined {
      if (token === '$title') {
        if (!item.title) throw new Error('No title provided from RSS reader.');
        return config.titleClearHTML ? decodeHTML(removeHTMLTags(item.title)) : item.title;
      }
      if (token === '$link') {
        if (!item.link) throw new Error('No link provided from RSS reader.');
        return item.link;
      }
      if (token === '$description') {
        let description = item.description ? item.description : item.content;
        if (config.descriptionClearHTML && description) description = removeHTMLTags(description);
        return description;
      }
      if (token === '$georss') {
        // '' rather than undefined, matching the bare-substitution path below: an
        // undefined return leaves the literal "$georss" text behind when this token is used
        // as bracket DISPLAY text (resolve(token) ?? token) instead of vanishing like the
        // ungeotagged bare-$georss case does. An empty string still fails the URL-side
        // http(s):// check, so url-side usage ([Map]($georss)) keeps degrading correctly.
        return item.geo
          ? `https://www.openstreetmap.org/?mlat=${item.geo.lat}&mlon=${item.geo.lng}`
          : '';
      }
      const key = token.slice(1);
      return Object.hasOwn(item.mappedValues, key) ? item.mappedValues[key] : undefined;
    }

    const extracted = extractMarkdownLinks(string, resolveToken);
    let parsedString = extracted.text;
    const templateForPresenceChecks = extracted.text;

    // Runs before $title/$link/$description/$georss (which all splice arbitrary
    // feed-supplied content into parsedString) and guards against `templateForPresenceChecks`
    // (the marker-bearing carrier text from extractMarkdownLinks, not the original raw
    // template but not yet feed-content-spliced either) - otherwise feed content that
    // happens to literally contain a "$key"-shaped substring (e.g. a
    // $description value containing "$author") could get mistaken for a real
    // mappedValues placeholder and substituted, corrupting the feed content and
    // potentially leaving the operator's real placeholder elsewhere in the
    // template unsubstituted. Bracket-consumed placeholders were already replaced with
    // opaque markers in extractMarkdownLinks, so this text can never contain a literal
    // "$title"-shaped substring from resolved feed content sitting inside a bracket span.
    for (const [key, value] of Object.entries(item.mappedValues).sort(
      (a, b) => b[0].length - a[0].length,
    )) {
      const placeholder = `$${key}`;
      if (templateForPresenceChecks.includes(placeholder)) {
        parsedString = parsedString.replace(placeholder, value);
      }
    }

    if (templateForPresenceChecks.includes('$title')) {
      if (!item.title) throw new Error('No title provided from RSS reader.');

      if (config.titleClearHTML) {
        parsedString = parsedString.replace('$title', decodeHTML(removeHTMLTags(item.title)));
      } else {
        parsedString = parsedString.replace('$title', item.title);
      }
    }

    if (templateForPresenceChecks.includes('$link')) {
      if (!item.link) throw new Error('No link provided from RSS reader.');
      parsedString = parsedString.replace('$link', item.link);
    }

    let description = item.description ? item.description : item.content;

    if (templateForPresenceChecks.includes('$description')) {
      if (config.descriptionClearHTML && description) description = removeHTMLTags(description);
      parsedString = parsedString.replace('$description', description ?? '');
    }

    if (templateForPresenceChecks.includes('$georss')) {
      const coords = item.geo
        ? `https://www.openstreetmap.org/?mlat=${item.geo.lat}&mlon=${item.geo.lng}`
        : '';
      parsedString = parsedString.replace('$georss', coords);
    }

    const finalized = finalizeMarkdownLinks(parsedString, extracted.pending);
    parsedString = finalized.text;
    result.facets = finalized.facets;

    if (parsedString.length > 300 && truncate) {
      // Measure the byte length of the KEPT text only, before '...' is appended - measuring
      // after appending it would let a facet whose byteEnd lands in the ellipsis's own 3
      // bytes survive, covering part of "..." as if it were still clickable link text.
      const kept = parsedString.slice(0, 277);
      const keptByteLength = Buffer.byteLength(kept, 'utf8');
      result.facets = result.facets.filter(facet => facet.byteEnd <= keptByteLength);
      parsedString = kept + '...';
    }
    result.text = parsedString;
    return result;
  }

  async function fetchImage(imageUrl: string) {
    let image: Buffer | undefined = undefined;

    try {
      const fetchBuffer = await axios.get(imageUrl, {
        headers: {
          'User-Agent': config.ogUserAgent,
        },
        responseType: 'arraybuffer',
      });
      image = await resizeImageToBuffer(fetchBuffer.data);
    } catch {
      // image fetch/resize failures are non-fatal; caller falls back to no image
    }

    return image;
  }

  return {
    start,
    init,
    launch,
    parseString,
  };
}

export type RssHandler = ReturnType<typeof createRssHandler>;

function removeHTMLTags(htmlString: string) {
  return htmlString
    ?.replace(/<\/?[^>]+(>|$)/g, ' ')
    .replaceAll('&nbsp;', ' ')
    .trim()
    .replace(/  +/g, ' ');
}

function decodeHTML(htmlString: string) {
  // From my tests, some HTML strings needs to be double-decoded.
  // Ex.: &amp;#233; -> &#233; -> é
  return decode(decode(htmlString));
}

function fixMalformedUrl(urlString: string): string {
  // Fix malformed protocols like "https//" or "http//" (missing colon)
  // These get treated as relative URLs and cause concatenation bugs
  return urlString.replace(/^https\/\//i, 'https://').replace(/^http\/\//i, 'http://');
}

async function resizeImageToBuffer(bufferData: Buffer) {
  const image = await Jimp.read(bufferData);
  return image
    .resize({w: 800}) // omitting h maintains aspect ratio (jimp v1 dropped the AUTO sentinel)
    .getBuffer(JimpMime.jpeg, {quality: 80}); // Getting the buffer as JPEG
}
```

Every function body is byte-identical to today's; `reader`/`lastDate`/`batchMax`/`config` move into the closure, `queue`/`db` become parameters. `parseString`, `fetchImage` stay inside the factory (they read `config`); `removeHTMLTags`, `decodeHTML`, `fixMalformedUrl`, `resizeImageToBuffer` are pure and stay module-level, same as today.

- [ ] **Step 2: Replace `app/utils/rssHandler.test.ts`'s imports and top-level setup**

Replace lines 1-52 (imports through the end of the top-level `beforeEach`) with:

```ts
import {describe, it, test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert';
import fs, {mkdtempSync, rmSync} from 'fs';
import path from 'path';
import {tmpdir} from 'os';
import {createServer} from 'node:http';
import {decode} from 'html-entities';
import {createDbHandler, type DbHandler} from './dbHandler.ts';
import {createBskyHandler} from './bskyHandler.ts';
import {createQueueHandler, type QueueHandler} from './queueHandler.ts';
import {createRssHandler, type RssHandler} from './rssHandler.ts';

/**
 * Tests for rssHandler module
 *
 * Note: These tests focus on the module's string parsing, HTML handling,
 * and URL validation logic. Full RSS feed integration tests require
 * actual RSS feeds and are better suited for E2E tests.
 */

describe('rssHandler', () => {
  let testDataDir: string;
  let db: DbHandler;
  let rssHandler: RssHandler;

  beforeEach(async () => {
    testDataDir = mkdtempSync(path.join(tmpdir(), 'bsky-rss-test-'));
    db = createDbHandler(testDataDir);

    // Create minimal config for tests
    const testConfig = {
      string: '$title - $link',
      publishEmbed: true,
      embedType: 'card',
      languages: ['en'],
      truncate: true,
      runInterval: 60,
      dateField: '',
      publishDate: false,
      imageField: '',
      ogUserAgent: 'bsky.rss/test',
      descriptionClearHTML: true,
      forceDescriptionEmbed: false,
      imageAlt: '$title',
      removeDuplicate: false,
      titleClearHTML: false,
      adaptiveSpacing: false,
      spacingWindow: 600,
      minSpacing: 1,
      maxSpacing: 60,
    };

    fs.writeFileSync(path.join(testDataDir, 'config.json'), JSON.stringify(testConfig), 'utf8');

    const bsky = createBskyHandler(db);
    const queue = createQueueHandler(bsky, db);
    rssHandler = createRssHandler(queue, db);
  });

  afterEach(() => {
    rmSync(testDataDir, {recursive: true, force: true});
  });
```

The top-level `import queueHandler from './queueHandler.ts';` (today's line 7) is deleted entirely — it existed only as the monkey-patch target for the 6 "Cross-poll deduplication" tests, which no longer monkey-patch anything (see Step 4 below). `TEST_DATA_DIR` is gone; every remaining `TEST_DATA_DIR` reference in the file (inside the 6 "Cross-poll deduplication" tests) becomes `testDataDir` in Step 4.

Lines 54-815 (`describe('Module exports', ...)` through `describe('Date handling', ...)`) are **unchanged** — none of those tests touch module construction, only `rssHandler.parseString` (a pure function reachable off the describe-level `rssHandler`, which Step 2 above already made fresh per test) or inline logic replication.

- [ ] **Step 3: Run typecheck, confirm the expected transient state (imports only, before Step 4's test-body changes)**

Run: `yarn typecheck`
Expected: `app/utils/rssHandler.test.ts` still shows errors at this point — its 6 "Cross-poll deduplication" tests still reference the deleted `queueHandler` import and the old `TEST_DATA_DIR` constant. This is expected mid-step; resolved by Step 4. `app/utils/rssHandler.ts` itself shows zero errors.

- [ ] **Step 4: Replace the 6 "Cross-poll deduplication" tests' monkey-patch pattern**

The `describe('Cross-poll deduplication', ...)` block (today's lines 817-1270) contains 6 tests, each following the same shape: write a config, save/restore `last.txt`, monkey-patch the shared `queueHandler.writeQueue`, load a fresh `rssHandler` via cache-busted `import()`, run it against a local HTTP server, assert on what got queued. With `rssHandler` now taking its `queue` dependency directly, monkey-patching is no longer needed — construct a small fake `QueueHandler` and pass it straight into `createRssHandler`.

For **each** of the 6 tests, apply this transformation (shown in full for the first test; the same transformation applies verbatim, with only the assertions and feed body staying as they are today, to the other 5):

Replace:

```ts
      fs.writeFileSync(
        path.join(TEST_DATA_DIR, 'config.json'),
        JSON.stringify({
          string: '$title',
          publishEmbed: false,
          languages: ['en'],
          truncate: true,
          runInterval: 60,
          dateField: '',
          imageField: '',
          ogUserAgent: 'bsky.rss/test',
          removeDuplicate: false,
        }),
        'utf8',
      );

      const lastPath = path.join(TEST_DATA_DIR, 'last.txt');
      const savedLast = fs.existsSync(lastPath) ? fs.readFileSync(lastPath, 'utf8') : null;
      fs.writeFileSync(lastPath, '2026-08-01T00:00:00.000Z', 'utf8');

      // Patch the shared queueHandler singleton before loading a fresh rssHandler, so
      // rssHandler's own `import queue from './queueHandler.ts'` (no cache-busting query
      // string, unlike the freshly-imported rssHandler below) resolves to this same,
      // already-patched instance.
      const realWriteQueue = queueHandler.writeQueue;
      const queued: QueueItems[] = [];
      queueHandler.writeQueue = async (item: QueueItems) => {
        queued.push(item);
        return queued;
      };

      const rssHandler = (await import(`./rssHandler.ts?t=${crypto.randomUUID()}`)).default;

      try {
        // 0.002 minutes = 120ms, so several polls fire inside the wait below.
        const reader = await rssHandler.init({
          fetch_interval: 0.002,
          fetch_url: new URL(`http://127.0.0.1:${port}/feed.xml`),
        });
        await rssHandler.start();
        await new Promise(resolve => setTimeout(resolve, 500));
        reader.stop();
      } finally {
        queueHandler.writeQueue = realWriteQueue;
        if (savedLast === null) fs.rmSync(lastPath, {force: true});
        else fs.writeFileSync(lastPath, savedLast, 'utf8');
        server.close();
      }
```

with:

```ts
      fs.writeFileSync(
        path.join(testDataDir, 'config.json'),
        JSON.stringify({
          string: '$title',
          publishEmbed: false,
          languages: ['en'],
          truncate: true,
          runInterval: 60,
          dateField: '',
          imageField: '',
          ogUserAgent: 'bsky.rss/test',
          removeDuplicate: false,
        }),
        'utf8',
      );

      fs.writeFileSync(path.join(testDataDir, 'last.txt'), '2026-08-01T00:00:00.000Z', 'utf8');

      // rssHandler now takes its queue dependency directly - no need to monkey-patch a
      // shared singleton anymore, and testDataDir is removed whole in this file's afterEach,
      // so there's no real last.txt to save/restore around this test.
      const queued: QueueItems[] = [];
      const fakeQueue: QueueHandler = {
        writeQueue: async (item: QueueItems) => {
          queued.push(item);
          return queued;
        },
        start: async () => {},
        runQueue: async (): Promise<QueueItems[]> => queued,
      };
      const testRssHandler = createRssHandler(fakeQueue, db);

      try {
        // 0.002 minutes = 120ms, so several polls fire inside the wait below.
        const reader = await testRssHandler.init({
          fetch_interval: 0.002,
          fetch_url: new URL(`http://127.0.0.1:${port}/feed.xml`),
        });
        await testRssHandler.start();
        await new Promise(resolve => setTimeout(resolve, 500));
        reader.stop();
      } finally {
        server.close();
      }
```

Apply the same replacement (adjusting only the `fetch_interval`/wait-duration numbers already present per-test, which stay unchanged) at each of the 6 sites — today's lines 843-890 ("queues a repeated feed item only once across multiple polls"), 928-972 ("queues every item in a newest-first batch exactly once"), 1000-1042 ("substitutes $georss..."), 1069-1112 ("substitutes $key placeholders..."), 1142-1188 ("substitutes $authorName..."), and 1221-1265 ("does not let the mappedValues loop touch a $key-shaped placeholder..."). In every one of the 6 tests, also rename the local variable `const rssHandler = ...` uses (assertions after the `try`/`finally` block already reference `queued`, not `rssHandler`, so no further rename is needed beyond the construction site itself — `testRssHandler` is only used inside the `try` block, matching today's scoping).

- [ ] **Step 5: Run typecheck, confirm the expected transient state**

Run: `yarn typecheck`
Expected: zero errors anywhere in `app/utils/`. Only `app/index.ts` still shows errors (still uses default imports for `bsky`/`reader`/`queue`/`db`) — expected, fixed by Task 5.

- [ ] **Step 6: Run the test file, expect all tests pass**

Run: `npx tsx --test app/utils/rssHandler.test.ts`
Expected: all 61 tests pass (matching today's count).

- [ ] **Step 7: Confirm the real `./data` directory is untouched**

Run: `git status --short data/ 2>/dev/null; ls data/ 2>/dev/null`
Expected: no output from `git status` — confirms `rssHandler.test.ts` (previously the file most exercising the real `./data` directory, via its 6 network-driven tests) no longer touches real local state.

- [ ] **Step 8: Commit**

```bash
git add app/utils/rssHandler.ts app/utils/rssHandler.test.ts
git commit -m "refactor: convert rssHandler to a factory function

createRssHandler(queue, db) takes its dependencies directly instead of
importing the queueHandler/dbHandler module singletons. The 6
'Cross-poll deduplication' tests no longer monkey-patch a shared
queueHandler singleton - they pass a small fake QueueHandler directly
into createRssHandler(), which is simpler and removes the load-order
dependency the monkey-patch relied on. rssHandler.test.ts uses an
isolated fs.mkdtempSync() directory per test instead of the real
./data directory, closing the remaining part of the cross-file
test-isolation race (session task #81)."
```

---

### Task 5: Wire app/index.ts and full verification

**Files:**
- Modify: `app/index.ts` (full rewrite, shown below)

**Interfaces:**
- Consumes: `createDbHandler` (Task 1), `createBskyHandler` (Task 2), `createQueueHandler` (Task 3), `createRssHandler` (Task 4). `healthHandler`'s existing default-export singleton, unchanged.
- Produces: nothing further — this is the last task. The one real production instance chain.

**Expected typecheck state after this task:** zero errors anywhere in the project (`yarn typecheck` clean).

- [ ] **Step 1: Replace `app/index.ts` in full**

```ts
import process from 'process';
import {join} from 'path';
import {createDbHandler} from './utils/dbHandler.ts';
import {createBskyHandler} from './utils/bskyHandler.ts';
import {createQueueHandler} from './utils/queueHandler.ts';
import {createRssHandler} from './utils/rssHandler.ts';
import health from './utils/healthHandler.ts';
import 'dotenv/config';

if (!process.env.IDENTIFIER) throw new Error('No identifier provided.');
if (!process.env.APP_PASSWORD) throw new Error('No app password provided.');
if (!process.env.FETCH_URL) throw new Error('No fetch URL provided.');
if (!process.env.INSTANCE_URL) throw new Error('No instance URL provided.');

let fetch_interval: number;
if (!process.env.FETCH_INTERVAL) fetch_interval = 5;
else fetch_interval = parseFloat(process.env.FETCH_INTERVAL);

const db = createDbHandler(join(import.meta.dirname, '../data'));
const bsky = createBskyHandler(db);
const queue = createQueueHandler(bsky, db);
const reader = createRssHandler(queue, db);

void main();
async function main() {
  try {
    /* Start health check endpoint */
    health.start();

    /* Initialize Bluesky/Atproto API */
    await bsky.init(String(process.env.INSTANCE_URL));
    await bsky.login({
      identifier: String(process.env.IDENTIFIER),
      password: String(process.env.APP_PASSWORD),
    });

    /* Initialize RSS reader */
    console.log(
      `[${new Date().toUTCString()}] - [bsky.rss APP] Started RSS reader. Fetching from ${
        process.env.FETCH_URL
      } every ${fetch_interval} minutes.`,
    );
    await reader.init({
      fetch_interval,
      fetch_url: new URL(String(process.env.FETCH_URL)),
    });
    await reader.start();
    await reader.launch();
    await queue.start();

    /* Mark application as ready */
    health.markReady();
    console.log(`[${new Date().toUTCString()}] - [bsky.rss APP] Application is ready and healthy`);
  } catch (e) {
    if (e === 'Error: Rate Limit Exceeded') {
      console.log(
        `[${new Date().toUTCString()}] - [bsky.rss APP] Authentication rate limit exceeded`,
      );
      return;
    }
    console.log(`[${new Date().toUTCString()}] - [bsky.rss APP] ${e}`);
  }
}
```

`join(import.meta.dirname, '../data')` resolves to the same real directory `dbHandler.ts`'s old hardcoded `import.meta.dirname + '/../../data'` pointed at (`app/index.ts`'s own `import.meta.dirname` is `app/`, so `'../data'` = `<project-root>/data` — the same directory `dbHandler.ts`'s `app/utils/`-relative `'../../data'` resolved to). `main()`'s body is otherwise unchanged — every call site (`bsky.init`, `bsky.login`, `reader.init`, `reader.start`, `reader.launch`, `queue.start`) already used the same names, now bound to constructed instances instead of imported singletons.

- [ ] **Step 2: Full project typecheck**

Run: `yarn typecheck`
Expected: exit 0, zero errors anywhere in the project.

- [ ] **Step 3: Full app test suite**

Run: `yarn test:app`
Expected: all tests pass (same total count as before this plan — no test was added or removed anywhere in this plan, only construction/isolation changed).

- [ ] **Step 4: Lint every file touched across this whole plan**

Run: `npx eslint app/index.ts app/utils/dbHandler.ts app/utils/dbHandler.test.ts app/utils/bskyHandler.ts app/utils/bskyHandler.test.ts app/utils/queueHandler.ts app/utils/queueHandler.test.ts app/utils/rssHandler.ts app/utils/rssHandler.test.ts`
Expected: exit 0, zero errors. (Full-repo `yarn lint`/`eslint .` is known to hang in this sandbox — established in the 2026-08-11 ESM migration — so lint touched files individually, not the whole repo.)

- [ ] **Step 5: Repeat the full app test suite 5 times, confirm no variance**

Run: `for i in 1 2 3 4 5; do yarn test:app 2>&1 | tail -5; done`
Expected: identical pass/fail counts across all 5 runs (this plan's spec, `documentation/specs/2026-08-11-app-handler-factories-design.md`, requires this as direct evidence the cross-file `data/` race is gone, not just less likely — the ESM migration's own investigation found it manifesting in roughly 2 of 3 runs, so 5 consecutive clean runs is meaningful evidence, not a coin flip).

- [ ] **Step 6: Confirm the real `./data` directory is untouched after a full test run**

Run: `git status --short data/ 2>/dev/null; ls -la data/`
Expected: no output from `git status`; `ls -la data/` shows only real files a human or a real bot run would have created (`config.json`, `last.txt`, `persist.json`, `db.txt` if `removeDuplicate` has ever been on) — none of them freshly modified by the test run just executed. Compare `stat data/config.json` (or equivalent) mtime against the time the test run started if in doubt.

- [ ] **Step 7: Update CLAUDE.md's "Conventions already in the code" section**

The line reading (approximately) `` `let` variables hold state (e.g. `bskyAgent`, `queue`, `appConfig`)`` under "Handlers are plain objects exporting a fixed set of functions... module-level `let` variables hold state" needs a correction: for `dbHandler`/`bskyHandler`/`queueHandler`/`rssHandler`, state now lives in a per-instance closure (`createXHandler(...)`), constructed once in `app/index.ts` — not at module level. `healthHandler` is unchanged (still module-level state, still a plain singleton). Read the current exact wording with `grep -n "module-level" CLAUDE.md` and edit that sentence in place; do not rewrite surrounding unrelated text.

- [ ] **Step 8: Commit**

```bash
git add app/index.ts CLAUDE.md
git commit -m "refactor: wire app/index.ts to the new handler factories

Constructs the one real production instance chain (db -> bsky -> queue
-> reader) explicitly instead of relying on module-import side effects.
Closes session tasks #74 (module-level singleton state) and #81
(cross-file test-isolation race in app/utils/*.test.ts) - confirmed via
5 consecutive clean yarn test:app runs and a real ./data directory
left untouched."
```

## Testing

Covered per-task above. Summary of what full verification (Task 5) proves:
- `yarn typecheck` clean across the whole project (not just files touched by this plan).
- `yarn test:app` green, same test count as before this plan (149 tests, per the ESM migration's final count) — no behavior change, only construction/isolation.
- Targeted `eslint` clean on every touched file.
- 5 consecutive `yarn test:app` runs with no variance — direct evidence the `data/` race (session task #81) is gone, not just less likely.
- The real `./data` directory is provably untouched by the test suite before and after this plan lands.

## Rollout

Same as every other change this session: committed directly to `main`, no feature branch (this repo's established pattern for this kind of internal refactor — see the ESM migration and identity-dedup plans). No config format change, no deploy-time behavior change for real users — this can land without a fleet/single-bot redeploy being required, though the next regular deploy will carry it.
