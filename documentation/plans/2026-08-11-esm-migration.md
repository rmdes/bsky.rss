# CommonJS to ESM Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip bsky.rss from CommonJS to native ESM (`"type": "module"`) in one migration covering both `app/` and `fleet/`, closing Renovate PR #11 (`@atproto/api`/`@atproto/xrpc` bump, blocked by an ESM-only transitive dependency) as a verified consequence, not a separate step.

**Architecture:** `package.json` gets `"type": "module"`; `tsconfig.json`'s `module`/`moduleResolution` move to `"nodenext"`; every extension-less relative import in `app/` (the only place they exist — `fleet/`/`shared/` already use explicit `.ts` extensions) gets one; `eslint.config.js` converts to native ESM syntax; every CJS-only runtime idiom found during the real sweep (`require()`, `__dirname`, `require.cache`) gets its ESM equivalent. `app/`'s 4 test files that reset module-level singleton state via `require.cache` invalidation use an interim dynamic-`import()`-with-cache-busting-query-string fix (a real architectural fix — refactoring the handlers off singleton state — is tracked separately as session task #74, explicitly out of scope here).

**Tech Stack:** TypeScript (via `tsx`, no build step), `node:test`, ESLint 9 flat config, `node:sqlite`.

## Global Constraints

- Both `app/` and `fleet/` migrate together, in this one plan — not split (per approved design).
- No restructuring beyond what the module-system change requires: no touching the shared feed-parsing layer, no changing handler patterns, no cleanup of unrelated dead `tsconfig.json` settings (`outDir` etc. stay as-is).
- No new `engines` field — not needed, out of scope (per spec).
- `eslint.config.js` converts to native ESM syntax (`import`/`export default`), not a `.cjs` rename — explicit user preference, revised from the design's first draft.
- `app/`'s require.cache-busting test pattern gets the dynamic-`import()`-with-cache-busting-query-string interim fix, using `crypto.randomUUID()` as the busting key (not `Date.now()` — a millisecond-collision would silently return a stale cached module instead of a fresh one, which would specifically break the one test that exists to verify reload-gives-fresh-state).
- `@atproto/api` bumps to exactly `0.20.38`, `@atproto/xrpc` to exactly `0.8.10` — Renovate PR #11's target versions, verbatim.
- Full local suite (`yarn typecheck && yarn test && yarn lint`) must pass clean, plus a manual smoke-run of both entry points (`yarn dev:app`, `yarn dev:fleet` against a real feed) before this plan is considered done.
- Design reference: `documentation/specs/2026-08-10-esm-migration-design.md` (approved, revised twice — `812c3dd` for the eslint.config.js preference, `d3b41f8` recording the real CJS-idiom sweep findings this plan is built from).

---

### Task 1: Core ESM flip

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `eslint.config.js`
- Modify: `app/index.ts`
- Modify: `app/utils/bskyHandler.ts`
- Modify: `app/utils/rssHandler.ts`
- Modify: `app/utils/queueHandler.ts`
- Modify: `app/utils/healthHandler.ts`
- Modify: `app/utils/dbHandler.ts`
- Modify: `app/utils/test-helpers.ts`
- Modify: `shared/feedSource/normalize.test.ts`
- Modify: `shared/feedSource/parse.test.ts`
- Modify: `shared/feedSource/poller.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks — this is the foundation.
- Produces: a working ESM project for everything *except* `app/`'s 4 test files that use `require.cache` invalidation (`bskyHandler.test.ts`, `queueHandler.test.ts`, `rssHandler.test.ts`, `dbHandler.test.ts`) — those are fixed in Tasks 2-5. `yarn typecheck`, `yarn lint`, and `yarn test:fleet` must all pass after this task. `yarn test:app` is **expected to fail** with `ReferenceError: require is not defined` in exactly those 4 files — this is documented, not a bug, and gets fixed by Tasks 2-5.

- [ ] **Step 1: Flip `package.json` to ESM**

Add `"type": "module"` right after `"license"` (exact current content, only this one line added):

```json
  "license": "MIT",
  "type": "module",
```

Also bump the dependency versions now (small enough to fold into this same step rather than a separate commit — they don't change any code, just what Task 6 will build on):

```json
  "dependencies": {
    "@atproto/api": "0.20.38",
    "@atproto/xrpc": "0.8.10",
```

- [ ] **Step 2: Update `tsconfig.json`'s module settings**

Current `compilerOptions` has `"moduleResolution": "node"` and no `"module"` key (inherits `gts`'s `"commonjs"`). Change to:

```json
    "moduleResolution": "nodenext",
    "module": "nodenext",
```

Insert `"module": "nodenext"` immediately before `"moduleResolution": "nodenext"` in the existing `compilerOptions` block — every other key stays exactly as-is.

- [ ] **Step 3: Convert `eslint.config.js` to native ESM syntax**

Current file (`module.exports = [...]`, `require('gts')`, `require('typescript-eslint').plugin`) becomes:

```js
import gtsConfig from 'gts';
import tseslint from 'typescript-eslint';

export default [
  {ignores: ['.remember/']},
  ...gtsConfig,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {argsIgnorePattern: '^_', varsIgnorePattern: '^_'},
      ],
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {from: 'package', name: 'test', package: 'node:test'},
            {from: 'package', name: 'describe', package: 'node:test'},
            {from: 'package', name: 'it', package: 'node:test'},
            {from: 'package', name: 'before', package: 'node:test'},
            {from: 'package', name: 'after', package: 'node:test'},
            {from: 'package', name: 'beforeEach', package: 'node:test'},
            {from: 'package', name: 'afterEach', package: 'node:test'},
          ],
        },
      ],
    },
  },
];
```

Node's CJS-from-ESM interop hands `gts`'s `module.exports = [...]` array to `import gtsConfig from 'gts'` unchanged — `...gtsConfig` spreads the exact same config entries as `...require('gts')` did. Same for `typescript-eslint`'s default export providing `.plugin` — but since this config file no longer explicitly registers the `@typescript-eslint` plugin at all (removed in commit `736f89e` earlier this session — `gts`'s own spread already provides it), the `tseslint` import isn't actually referenced anywhere in this file's body. Remove the unused `import tseslint from 'typescript-eslint';` line entirely rather than leaving an unused import — the file only needs the `gtsConfig` import.

- [ ] **Step 4: Fix `app/index.ts`'s CJS idioms and import extensions**

Current:

```ts
import process from 'process';
import bsky from './utils/bskyHandler';
import reader from './utils/rssHandler';
import queue from './utils/queueHandler';
import health from './utils/healthHandler';

require('dotenv').config();
```

Becomes:

```ts
import process from 'process';
import bsky from './utils/bskyHandler.ts';
import reader from './utils/rssHandler.ts';
import queue from './utils/queueHandler.ts';
import health from './utils/healthHandler.ts';
import 'dotenv/config';
```

(`import 'dotenv/config';` matches the exact pattern `fleet/runFleet.ts` already uses.)

- [ ] **Step 5: Fix `app/utils/bskyHandler.ts`'s import extension**

Line 12, `import db from './dbHandler';` → `import db from './dbHandler.ts';`. No other changes to this file in this task (its `require.cache`-related test fixes are Task 2).

- [ ] **Step 6: Fix `app/utils/rssHandler.ts`'s import extensions**

Lines 3-4:

```ts
import queue from './queueHandler';
import db from './dbHandler';
```

Become:

```ts
import queue from './queueHandler.ts';
import db from './dbHandler.ts';
```

- [ ] **Step 7: Fix `app/utils/queueHandler.ts`'s import extensions**

Current:

```ts
import bsky from './bskyHandler';
import db from './dbHandler';
import health from './healthHandler';
```

Becomes:

```ts
import bsky from './bskyHandler.ts';
import db from './dbHandler.ts';
import health from './healthHandler.ts';
```

- [ ] **Step 8: Fix `app/utils/healthHandler.ts`'s `require()` for the package version**

Read the file first to find the exact current line (around line 40): `version: require('../../package.json').version,`. Replace the CJS `require()` with a `fs.readFileSync` + `JSON.parse` read (simpler and more portable than a JSON import attribute, and this file already imports `http` at the top so adding `fs`/`path`/`url` imports is consistent with its existing style):

```ts
import http from 'http';
import {readFileSync} from 'fs';
import {fileURLToPath} from 'url';
import {join, dirname} from 'path';

const packageJson = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf-8'),
) as {version: string};
```

Add this near the top of the file (after the existing imports), then replace `require('../../package.json').version` with `packageJson.version` at its original call site.

- [ ] **Step 9: Fix `app/utils/dbHandler.ts`'s `__dirname` usage**

All 8 occurrences of `__dirname` in this file → `import.meta.dirname` (native since Node 20.11; this project runs Node 24 in both Docker and local dev, confirmed this session — no `fileURLToPath` fallback needed). Example — line 6-7:

```ts
  if (!fs.existsSync(__dirname + '/../../data/last.txt')) {
    fs.writeFileSync(__dirname + '/../../data/last.txt', '', 'utf8');
```

Becomes:

```ts
  if (!fs.existsSync(import.meta.dirname + '/../../data/last.txt')) {
    fs.writeFileSync(import.meta.dirname + '/../../data/last.txt', '', 'utf8');
```

Apply this identical `__dirname` → `import.meta.dirname` substitution to all 8 occurrences in this file (lines 6, 7, 10, 16, 21, 22, 25, 31, 37, 55, 56, 59, 67, 76, 77, 82, 100 per this session's sweep — re-verify exact line numbers when editing, since they may have shifted).

- [ ] **Step 10: Fix `__dirname` in the remaining non-test-reset files**

Same `__dirname` → `import.meta.dirname` substitution, one occurrence each, in:
- `app/utils/test-helpers.ts` (line 12: `return readFileSync(join(__dirname, '../../test-fixtures', path), 'utf-8');`)
- `shared/feedSource/normalize.test.ts` (line 9, same pattern)
- `shared/feedSource/parse.test.ts` (line 9, same pattern)
- `shared/feedSource/poller.test.ts` (line 11, same pattern)

- [ ] **Step 11: Fix the extension-less imports in `app/`'s test files that don't need `require.cache` fixes**

`app/utils/healthHandler.test.ts` (imports `./test-helpers` and `./healthHandler`) and `app/utils/queueHandler.test.ts` (imports `./healthHandler`) have extension-less relative imports but no `require.cache` usage of their own module under test. Fix:

`app/utils/healthHandler.test.ts` line 3 and line 6:
```ts
import {sleep} from './test-helpers.ts';
import healthHandler from './healthHandler.ts';
```

`app/utils/queueHandler.test.ts` line 5:
```ts
import healthHandler from './healthHandler.ts';
```

(`queueHandler.test.ts`'s own `require.cache` usage of `./queueHandler` itself is fixed in Task 3 — this step only fixes its *other* import.)

`app/utils/dbHandler.test.ts` line 7 (`import dbHandler from './dbHandler';`) → `import dbHandler from './dbHandler.ts';` (this file's own `require.cache` handling is fixed in Task 5, but the top-level import extension is independent and belongs here).

- [ ] **Step 12: Run typecheck, lint, and fleet tests — confirm the expected app test failure**

```bash
yarn typecheck
```
Expected: PASS, no output.

```bash
yarn lint
```
Expected: PASS, no output — confirms the `eslint.config.js` ESM conversion works.

```bash
yarn test:fleet
```
Expected: PASS, 255/255 (fleet/ was already ESM-style, unaffected by this task — this proves the core flip itself works, independent of app/'s known remaining breakage).

```bash
yarn test:app
```
Expected: FAIL — every test in `bskyHandler.test.ts`, `queueHandler.test.ts`, `rssHandler.test.ts`, `dbHandler.test.ts` throws `ReferenceError: require is not defined`. Confirm the failures are *exactly* this error class and nothing else (no unrelated errors) — Tasks 2-5 fix these four files specifically.

- [ ] **Step 13: Commit**

```bash
git add package.json tsconfig.json eslint.config.js app/index.ts app/utils/bskyHandler.ts app/utils/rssHandler.ts app/utils/queueHandler.ts app/utils/healthHandler.ts app/utils/dbHandler.ts app/utils/test-helpers.ts app/utils/healthHandler.test.ts app/utils/queueHandler.test.ts app/utils/dbHandler.test.ts shared/feedSource/normalize.test.ts shared/feedSource/parse.test.ts shared/feedSource/poller.test.ts
git commit -m "feat: flip bsky.rss to native ESM

package.json gets type:module; tsconfig's module/moduleResolution move
to nodenext; eslint.config.js converts to native ESM syntax; every
extension-less relative import in app/ (fleet/ and shared/ already used
explicit .ts extensions) gets one; the real CJS-idiom sweep found and
fixed require('dotenv').config(), a require('../../package.json')
version read, and __dirname usage across 5 files - all replaced with
their ESM equivalents (import 'dotenv/config', fs.readFileSync +
JSON.parse, import.meta.dirname).

app/'s 4 test files using require.cache invalidation to reset
module-level singleton state between tests are NOT yet fixed - they
fail with 'require is not defined' until Tasks 2-5 land, since ESM has
no equivalent to require.cache and each file's fix needs individual
care (see documentation/specs/2026-08-10-esm-migration-design.md)."
```

---

### Task 2: Fix `app/utils/bskyHandler.test.ts`

**Files:**
- Modify: `app/utils/bskyHandler.test.ts`

**Interfaces:**
- Consumes: Task 1's ESM project state.
- Produces: `bskyHandler.test.ts` passing under ESM. No other task depends on this one's internals.

Verified this file has no cross-module state sharing anywhere (unlike `rssHandler.test.ts`'s queueHandler monkey-patching) — every one of its 16 `require('./bskyHandler').default` occurrences (with or without a preceding `delete require.cache` line) can safely use a uniform fresh cache-busted dynamic import, since nothing else in the file depends on getting the *same* stale instance back.

- [ ] **Step 1: Hoist the stateless `@atproto/api` import**

Add to the top of the file (after the existing `node:test`/`node:assert` imports):

```ts
import {RichText} from '@atproto/api';
```

Then at line 313, replace `const {RichText} = require('@atproto/api');` — delete that line entirely (the top-level import already provides `RichText`).

- [ ] **Step 2: Replace every `require('./bskyHandler')` occurrence with a cache-busted dynamic import**

For every occurrence of the pattern:

```ts
      delete require.cache[require.resolve('./bskyHandler')];
      const bskyHandler = require('./bskyHandler').default;
```

Replace with:

```ts
      const bskyHandler = (await import(`./bskyHandler.ts?t=${crypto.randomUUID()}`)).default;
```

(one line replacing two, `delete require.cache[...]` line removed entirely). This applies at the current lines 26-27, 35-36, 65-66, 82-83, 116-117, 130-131, 158-159, 241-242, 262-263, 297-298, 341-342, 382-383 (12 occurrences — re-verify exact numbers when editing, since removing lines shifts everything below).

For the two occurrences with **no** preceding `delete require.cache` (current lines 15 and 288 — `const bskyHandler = require('./bskyHandler').default;` alone), apply the same replacement (still use the cache-busting dynamic import, for uniformity — these two don't strictly need freshness, but there's no reason to special-case them differently from the rest of the file):

```ts
      const bskyHandler = (await import(`./bskyHandler.ts?t=${crypto.randomUUID()}`)).default;
```

For the special two-step reassignment case (current lines 51-52 and 56-57, "should create agent with different service URLs" — two *separate* fresh instances in the same test, not a reassignment):

```ts
      delete require.cache[require.resolve('./bskyHandler')];
      const bskyHandler1 = require('./bskyHandler').default;
      const agent1 = await bskyHandler1.init('https://bsky.social');
      assert(agent1);

      delete require.cache[require.resolve('./bskyHandler')];
      const bskyHandler2 = require('./bskyHandler').default;
      const agent2 = await bskyHandler2.init('https://custom.bsky.host');
      assert(agent2);
```

Becomes:

```ts
      const bskyHandler1 = (await import(`./bskyHandler.ts?t=${crypto.randomUUID()}`)).default;
      const agent1 = await bskyHandler1.init('https://bsky.social');
      assert(agent1);

      const bskyHandler2 = (await import(`./bskyHandler.ts?t=${crypto.randomUUID()}`)).default;
      const agent2 = await bskyHandler2.init('https://custom.bsky.host');
      assert(agent2);
```

And for the true reassignment case (current lines 271-283, "should reset state when module is reloaded" — this is the test that specifically verifies reload gives fresh state, the exact reason `crypto.randomUUID()` was chosen over `Date.now()`):

```ts
    it('should reset state when module is reloaded', async () => {
      delete require.cache[require.resolve('./bskyHandler')];
      let bskyHandler = require('./bskyHandler').default;
      await bskyHandler.init('https://bsky.social');

      // Reload module
      delete require.cache[require.resolve('./bskyHandler')];
      bskyHandler = require('./bskyHandler').default;

      // Should be able to init again
      const agent = await bskyHandler.init('https://bsky.social');
      assert(agent);
    });
```

Becomes:

```ts
    it('should reset state when module is reloaded', async () => {
      let bskyHandler = (await import(`./bskyHandler.ts?t=${crypto.randomUUID()}`)).default;
      await bskyHandler.init('https://bsky.social');

      // Reload module
      bskyHandler = (await import(`./bskyHandler.ts?t=${crypto.randomUUID()}`)).default;

      // Should be able to init again
      const agent = await bskyHandler.init('https://bsky.social');
      assert(agent);
    });
```

- [ ] **Step 3: Verify every enclosing test function is `async`**

Every `it(...)` callback containing an `await import(...)` must be declared `async`. Check each of the 14 modified test bodies — most already are (they already `await bskyHandler.init(...)` etc.), but confirm each one explicitly rather than assuming; if any non-async `it('...', () => {...})` now contains an `await`, add `async` to its callback signature.

- [ ] **Step 4: Run this file's tests**

```bash
yarn test:app -- --test-name-pattern "bskyHandler"
```

Actually this project's `test:app` script globs `app/**/*.test.ts` with no name-pattern filtering support built in cleanly across files sharing describe names — run the file directly instead:

```bash
npx tsx --test app/utils/bskyHandler.test.ts
```

Expected: PASS, all tests green, same count as before this task (16 `it`/`test` blocks in this file's describe tree).

- [ ] **Step 5: Commit**

```bash
git add app/utils/bskyHandler.test.ts
git commit -m "fix: migrate bskyHandler.test.ts off require.cache invalidation

Interim fix (session task #74 tracks the real one - refactoring
bskyHandler off module-level singleton state): every require.cache-bust
+ re-require pair becomes a dynamic import() with a crypto.randomUUID()
cache-busting query string. UUID, not Date.now() - this file has a test
that specifically verifies reload-gives-fresh-state, and a millisecond
timestamp collision would silently defeat that guarantee."
```

---

### Task 3: Fix `app/utils/queueHandler.test.ts`

**Files:**
- Modify: `app/utils/queueHandler.test.ts`

**Interfaces:**
- Consumes: Task 1's ESM project state. Independent of Task 2.
- Produces: `queueHandler.test.ts` passing under ESM.

This file's `beforeEach` already resets `queueHandler`'s cache before *every* test — every individual test's own `require('./queueHandler').default` call (with or without its own redundant extra `delete require.cache`) is really just "get the reference `beforeEach` just made fresh." The clean ESM equivalent centralizes this: one describe-scope variable, set fresh in `beforeEach`, used directly by every test body — removing the ~8 redundant per-test require lines rather than mechanically translating each one.

- [ ] **Step 1: Add a describe-scope `queueHandler` variable and make `beforeEach` set it fresh**

Current (lines 15-53):

```ts
describe('queueHandler', () => {
  const TEST_DATA_DIR = path.join(__dirname, '../../data');

  before(() => {
    // Ensure data directory exists
    if (!fs.existsSync(TEST_DATA_DIR)) {
      fs.mkdirSync(TEST_DATA_DIR, {recursive: true});
    }
  });

  beforeEach(() => {
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

    fs.writeFileSync(path.join(TEST_DATA_DIR, 'config.json'), JSON.stringify(testConfig), 'utf8');

    // Clear module cache to reset queue state
    delete require.cache[require.resolve('./queueHandler')];
  });
```

Becomes:

```ts
describe('queueHandler', () => {
  const TEST_DATA_DIR = path.join(import.meta.dirname, '../../data');
  let queueHandler: typeof import('./queueHandler.ts').default;

  before(() => {
    // Ensure data directory exists
    if (!fs.existsSync(TEST_DATA_DIR)) {
      fs.mkdirSync(TEST_DATA_DIR, {recursive: true});
    }
  });

  beforeEach(async () => {
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

    fs.writeFileSync(path.join(TEST_DATA_DIR, 'config.json'), JSON.stringify(testConfig), 'utf8');

    queueHandler = (await import(`./queueHandler.ts?t=${crypto.randomUUID()}`)).default;
  });
```

- [ ] **Step 2: Remove every per-test `require('./queueHandler')` call, use the shared variable directly**

Every occurrence of `const queueHandler = require('./queueHandler').default;` (current lines 65, 74, 93, 117, 145, 175, 200, 216, 236 — 9 occurrences, some preceded by a now-redundant `delete require.cache[require.resolve('./queueHandler')];` at lines 92, 116, 144, 174, 199) — delete both the require line and any preceding delete line entirely. The test body's remaining references to `queueHandler.writeQueue(...)`, `queueHandler.start`, etc. now resolve to the describe-scope variable `beforeEach` already set fresh.

Example — current (lines 91-93):
```ts
    it('should accept item with embed', async () => {
      delete require.cache[require.resolve('./queueHandler')];
      const queueHandler = require('./queueHandler').default;

      const item = {
```
Becomes:
```ts
    it('should accept item with embed', async () => {
      const item = {
```

Apply this same deletion to all 9 occurrences.

- [ ] **Step 3: Fix the remaining `__dirname` and import extension**

`__dirname` at line 16 already updated in Step 1 above (`import.meta.dirname`). The `import healthHandler from './healthHandler';` extension fix was already done in Task 1, Step 11 — nothing further needed here.

- [ ] **Step 4: Run this file's tests**

```bash
npx tsx --test app/utils/queueHandler.test.ts
```

Expected: PASS, same test count as before (this task removes lines, not tests — every `it()`/`describe()` block stays).

- [ ] **Step 5: Commit**

```bash
git add app/utils/queueHandler.test.ts
git commit -m "fix: migrate queueHandler.test.ts off require.cache invalidation

beforeEach already reset the module before every test - centralizing
via one describe-scope variable set fresh in beforeEach (using a
crypto.randomUUID()-busted dynamic import) removes the redundant
per-test require() calls entirely, rather than mechanically translating
each one. Interim fix - session task #74 tracks the real one."
```

---

### Task 4: Fix `app/utils/rssHandler.test.ts`

**Files:**
- Modify: `app/utils/rssHandler.test.ts`

**Interfaces:**
- Consumes: Task 1's ESM project state. Independent of Tasks 2-3.
- Produces: `rssHandler.test.ts` passing under ESM.

Same `beforeEach`-resets-every-test structure as Task 3's `queueHandler.test.ts`, **plus** 6 tests that monkey-patch the shared `queueHandler` singleton *before* freshly loading `rssHandler`, relying on `rssHandler.ts`'s own internal `import queue from './queueHandler.ts'` resolving to that same patched instance (not a fresh one) — this only works if `queueHandler` itself is accessed via a plain, non-busted reference. Getting this wrong would silently break the one thing these 6 tests exist to verify.

- [ ] **Step 1: Hoist the stateless `html-entities` import and add the plain `queueHandler` import**

Add to the top of the file (after the existing imports):

```ts
import {decode} from 'html-entities';
import queueHandler from './queueHandler.ts';
```

Then delete every occurrence of `const {decode} = require('html-entities');` (4 occurrences, current lines 467, 485, 496, 508) — the hoisted import already provides `decode`.

- [ ] **Step 2: Add a describe-scope `rssHandler` variable and make `beforeEach` set it fresh**

Current (lines 15-50):

```ts
describe('rssHandler', () => {
  const TEST_DATA_DIR = path.join(__dirname, '../../data');

  beforeEach(() => {
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

    if (!fs.existsSync(TEST_DATA_DIR)) {
      fs.mkdirSync(TEST_DATA_DIR, {recursive: true});
    }

    fs.writeFileSync(path.join(TEST_DATA_DIR, 'config.json'), JSON.stringify(testConfig), 'utf8');

    // Clear module cache to reset state
    delete require.cache[require.resolve('./rssHandler')];
  });
```

Becomes:

```ts
describe('rssHandler', () => {
  const TEST_DATA_DIR = path.join(import.meta.dirname, '../../data');
  let rssHandler: typeof import('./rssHandler.ts').default;

  beforeEach(async () => {
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

    if (!fs.existsSync(TEST_DATA_DIR)) {
      fs.mkdirSync(TEST_DATA_DIR, {recursive: true});
    }

    fs.writeFileSync(path.join(TEST_DATA_DIR, 'config.json'), JSON.stringify(testConfig), 'utf8');

    rssHandler = (await import(`./rssHandler.ts?t=${crypto.randomUUID()}`)).default;
  });
```

- [ ] **Step 3: Remove the 11 plain per-test `require('./rssHandler')` calls**

Every occurrence of `const rssHandler = require('./rssHandler').default;` with **no** preceding `delete require.cache` (current lines 54, 166, 187, 207, 227, 247, 268, 290, 318, 344, 364 — 11 occurrences) — delete the line entirely. The test body's remaining references to `rssHandler.init(...)` etc. now resolve to the describe-scope variable `beforeEach` already set fresh.

- [ ] **Step 4: Fix the 6 monkey-patch tests**

These 6 tests (current lines ~875-903, ~957-985, ~1030-1058, ~1101-1129, ~1178-1206, ~1256-1284 — re-verify exact ranges when editing, since Steps 1-3 shift line numbers) share this exact setup shape before diverging into different assertions. Current:

```ts
      // Patch the shared queueHandler singleton before requiring rssHandler, so
      // rssHandler's own `import queue from './queueHandler'` resolves to this object.
      const queueHandler = require('./queueHandler').default;
      const realWriteQueue = queueHandler.writeQueue;
      const queued: {title: string}[] = [];
      queueHandler.writeQueue = async (item: {title: string}) => {
        queued.push(item);
      };

      delete require.cache[require.resolve('./rssHandler')];
      const rssHandler = require('./rssHandler').default;
```

Becomes:

```ts
      // Patch the shared queueHandler singleton before loading a fresh rssHandler, so
      // rssHandler's own `import queue from './queueHandler.ts'` (no cache-busting query
      // string, unlike the freshly-imported rssHandler below) resolves to this same,
      // already-patched instance.
      const realWriteQueue = queueHandler.writeQueue;
      const queued: {title: string}[] = [];
      queueHandler.writeQueue = async (item: {title: string}) => {
        queued.push(item);
      };

      const rssHandler = (await import(`./rssHandler.ts?t=${crypto.randomUUID()}`)).default;
```

Note this **shadows** the describe-scope `rssHandler` variable with a test-local `const` — deliberate: these 6 tests need their own instance loaded *after* the patch, not the `beforeEach`-provided one (which would have already resolved its internal `queue` reference *before* this test body ever ran, missing the patch entirely). The top-level `import queueHandler from './queueHandler.ts';` added in Step 1 replaces the old inline `require('./queueHandler').default` — same object either way, since it's a plain, unbusted import.

Apply this identical transformation to all 6 occurrences — each one's *setup* is identical; only the assertions after it (checking `queued`, restoring `realWriteQueue`, etc.) differ and stay untouched.

Also check each of these 6 tests restores `queueHandler.writeQueue = realWriteQueue;` in a `finally` block or equivalent cleanup — since `queueHandler` is now a shared top-level import used across the whole file (not a fresh instance scoped to just this test), a missing restore would leak the patched `writeQueue` into whichever test runs next. Read each of the 6 tests' full bodies to confirm this cleanup already exists (it should, per the original CJS code's own correctness — re-requiring `queueHandler` fresh next `beforeEach` cycle isn't happening for `queueHandler` specifically since only `rssHandler` gets busted here, so the ORIGINAL code already had to rely on manual restoration too); if any test is missing it, that's a pre-existing bug worth flagging, not something to silently fix as a side effect of this task — note it in the task's completion report rather than changing test behavior unprompted.

- [ ] **Step 5: Run this file's tests**

```bash
npx tsx --test app/utils/rssHandler.test.ts
```

Expected: PASS, same test count as before this task.

- [ ] **Step 6: Commit**

```bash
git add app/utils/rssHandler.test.ts
git commit -m "fix: migrate rssHandler.test.ts off require.cache invalidation

Same beforeEach-centralization as queueHandler.test.ts, plus special
handling for the 6 tests that monkey-patch the shared queueHandler
singleton before loading a fresh rssHandler - those need queueHandler
accessed via a plain (non-busted) import so rssHandler's own internal
import resolves to the same patched instance, not a fresh unpatched one.
Interim fix - session task #74 tracks the real one."
```

---

### Task 5: Fix `app/utils/dbHandler.test.ts`

**Files:**
- Modify: `app/utils/dbHandler.test.ts`

**Interfaces:**
- Consumes: Task 1's ESM project state (including its already-fixed `import dbHandler from './dbHandler.ts';` top-level import, Task 1 Step 11). Independent of Tasks 2-4.
- Produces: `dbHandler.test.ts` passing under ESM. This is the last of the 4 test-file fixes — after this task, `yarn test:app` should be fully green again.

This file's structure differs from Tasks 3-4: it already has a **top-level static** `import dbHandler from './dbHandler';` (not per-test requires), used by every test in the file except one. Its `beforeEach`'s `delete require.cache[require.resolve('./dbHandler')]` (current lines 50-52) is a **no-op for every test using that top-level import** — deleting a require-cache entry never changes an already-resolved import binding, only affects *future* `require()` calls. Verified by tracing test execution order: the one test that needs (and gets) genuinely fresh module state — "should throw error if config not initialized" (current lines 227-240) — does its *own* explicit `delete require.cache` + fresh `require()`, which is what actually matters; `beforeEach`'s copy was already redundant with that under the current CJS code, not just under this migration.

- [ ] **Step 1: Remove `beforeEach`'s inert `require.cache` line and fix `__dirname`**

Current (lines 10-11, 40-53):

```ts
  const TEST_DATA_DIR = path.join(__dirname, '../../data-test');
  const ORIGINAL_DATA_DIR = path.join(__dirname, '../../data');
```

```ts
  beforeEach(() => {
    // Clean data directory before each test
    const files = ['last.txt', 'persist.json', 'db.txt', 'config.json'];
    files.forEach(file => {
      const filePath = path.join(ORIGINAL_DATA_DIR, file);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });

    // Reset module state by reimporting
    // This clears the cached appConfig
    delete require.cache[require.resolve('./dbHandler')];
  });
```

Becomes:

```ts
  const TEST_DATA_DIR = path.join(import.meta.dirname, '../../data-test');
  const ORIGINAL_DATA_DIR = path.join(import.meta.dirname, '../../data');
```

```ts
  beforeEach(() => {
    // Clean data directory before each test
    const files = ['last.txt', 'persist.json', 'db.txt', 'config.json'];
    files.forEach(file => {
      const filePath = path.join(ORIGINAL_DATA_DIR, file);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });
  });
```

(The `require.cache` line is deleted, not translated — it had no real effect on the shared top-level-imported `dbHandler` instance even under the original CJS code, since import bindings are resolved once and `delete require.cache[...]` only affects future `require()` calls, of which there weren't any relying on it. Every test's actual isolation comes from the file cleanup above it, not this line.)

- [ ] **Step 2: Fix the one test that needs a genuinely fresh instance**

Current (lines 227-240):

```ts
    it('should throw error if config not initialized', async () => {
      // Reload module to clear cached config
      delete require.cache[require.resolve('./dbHandler')];
      const freshDbHandler = require('./dbHandler').default;

      await assert.rejects(
        async () => {
          await freshDbHandler.readConfig();
        },
        {
          message: 'Config not initialized.',
        },
      );
    });
```

Becomes:

```ts
    it('should throw error if config not initialized', async () => {
      // Load a fresh instance to get an unset appConfig - the shared top-level
      // `dbHandler` import may already have config cached from earlier tests in
      // this file (initConfig() caches it in module-level state).
      const freshDbHandler = (await import(`./dbHandler.ts?t=${crypto.randomUUID()}`)).default;

      await assert.rejects(
        async () => {
          await freshDbHandler.readConfig();
        },
        {
          message: 'Config not initialized.',
        },
      );
    });
```

- [ ] **Step 3: Run this file's tests**

```bash
npx tsx --test app/utils/dbHandler.test.ts
```

Expected: PASS, same test count as before this task.

- [ ] **Step 4: Run the complete `app/` suite and confirm full recovery**

```bash
yarn test:app
```

Expected: PASS — this is the first point since Task 1 that the full `app/` suite is green again.

- [ ] **Step 5: Commit**

```bash
git add app/utils/dbHandler.test.ts
git commit -m "fix: migrate dbHandler.test.ts off require.cache invalidation

beforeEach's require.cache-delete was already inert for every test using
the shared top-level dbHandler import (import bindings don't change when
the cache is cleared, only future require() calls do) - removed rather
than translated. The one test that genuinely needs fresh module state
already did its own explicit re-require; that becomes a
crypto.randomUUID()-busted dynamic import. Interim fix - session task
#74 tracks the real one. yarn test:app is fully green again after this
task."
```

---

### Task 6: Verify the ATProto bump, close PR #11, full verification

**Files:**
- No further file changes beyond what Task 1 already staged (`@atproto/api`/`@atproto/xrpc` versions in `package.json`) — this task installs, verifies, and closes out.

**Interfaces:**
- Consumes: Tasks 1-5's fully-working ESM project.
- Produces: nothing further consumed by other tasks — this is the plan's final task.

- [ ] **Step 1: Install the bumped dependencies**

```bash
yarn install
```

Expected: resolves `@atproto/api@0.20.38` and `@atproto/xrpc@0.8.10` (and their `multiformats` transitive dependency) cleanly — no quarantine, no peer-dependency errors beyond the pre-existing, unrelated `typescript`/`@typescript-eslint` warning already present on `main` (not something this task introduces or needs to fix).

- [ ] **Step 2: Run the complete verification suite**

```bash
yarn typecheck && yarn test && yarn lint
```

Expected: all three pass clean. `yarn test` should report the same total test count as `main` had before this migration started (no tests added or removed — this is a module-system change, not new behavior).

- [ ] **Step 3: Manually smoke-run both entry points against a real feed**

Single-bot mode:
```bash
yarn dev:app
```
Expected: starts cleanly, logs show config loaded, session resumed or fresh login, feed polling begins. Let it run long enough to see at least one poll cycle complete, then stop it (Ctrl+C) — confirm clean shutdown, no unhandled errors.

Fleet mode:
```bash
yarn dev:fleet
```
Expected: same — bots activate, health endpoint starts, at least one poll cycle completes cleanly. Stop it and confirm clean shutdown.

(Both require real `data/config.json` / fleet config to be present locally, matching this repo's existing local-dev setup — use whatever local config already exists for manual testing; don't create new throwaway config as part of this task unless none exists.)

- [ ] **Step 4: Close PR #11 as superseded**

```bash
gh pr comment 11 --repo rmdes/bsky.rss --body "Superseded by the ESM migration (documentation/specs/2026-08-10-esm-migration-design.md) - this project now runs native ESM, which correctly resolves multiformats's import-only export condition. Bumped to these exact versions as part of that migration; closing as subsumed."
gh pr close 11 --repo rmdes/bsky.rss --delete-branch
```

- [ ] **Step 5: Commit**

```bash
git add package.json yarn.lock
git commit -m "chore(deps): bump @atproto/api to 0.20.38, @atproto/xrpc to 0.8.10

Renovate PR #11's exact target versions. Verifies the ESM migration's
real motivation: multiformats (a transitive dependency of these
packages) is ESM-only and previously failed under this project's old
CommonJS setup with ERR_PACKAGE_PATH_NOT_EXPORTED - now resolves
cleanly. Closes #11 as superseded."
```

(If `yarn install` in Step 1 already modified `package.json`/`yarn.lock` beyond what Task 1 staged, this commit captures the final resolved lockfile state - `package.json`'s version numbers were already correct from Task 1, so this is really just the `yarn.lock` resolution.)

---

## Self-Review

**Spec coverage:** Core flip (package.json, tsconfig, eslint.config.js) → Task 1. `app/`'s 8 files' import extensions → Task 1 (source files) + Task 1 Step 11 (test files without their own require.cache handling). CJS-idiom sweep findings (`require('dotenv')`, `__dirname`, package.json version read, the 4 test files' `require.cache` pattern) → Task 1 Steps 8-10 for the small ones, Tasks 2-5 for the 4 test files. ATProto bump → Task 6. PR #11 closure → Task 6 Step 4. Full verification (typecheck/test/lint + manual smoke-run) → Task 6 Steps 2-3.

**Placeholder scan:** No TBD/TODO. Every step shows complete code. Task 4's "apply this identical transformation to all 6 occurrences" and Task 2's "apply to all 12 occurrences" name the exact pattern being repeated (shown in full once) rather than describing it vaguely — consistent with how this session's earlier plans handled genuinely repetitive mechanical edits (e.g. the fleet identity-dedup plan's 7 `new FeedReader(...)` call sites).

**Type consistency:** `queueHandler`/`rssHandler` describe-scope variable names and `typeof import('./x.ts').default` type annotations are consistent between Tasks 3 and 4 (same pattern, different module). The `crypto.randomUUID()` cache-busting convention is identical across Tasks 2, 3, 4, and 5 - no task invents a different busting scheme.

**One open risk flagged, not silently resolved:** Task 4 Step 4 notes that if any of the 6 monkey-patch tests turns out to be missing its `queueHandler.writeQueue` restoration, that's a pre-existing bug to report, not fix unprompted - keeping this task scoped to the module-system migration, not a test-quality audit.
