# CommonJS → ESM Migration — Design

## Problem

`bsky.rss` runs entirely as CommonJS today — no `"type"` field in `package.json` (defaults to
`commonjs`), `tsconfig.json` inherits `module: "commonjs"` from `gts/tsconfig-google`, and every
module boundary resolves via Node's classic `require()` semantics.

This became a live blocker: Renovate PR #11 (bumping `@atproto/api` 0.19.19→0.20.38 and
`@atproto/xrpc` 0.7.7→0.8.10) transitively pulls in `multiformats@13.4.2`, a pure ESM package
(`"type": "module"`) whose `./cid` subpath export defines only an `"import"` condition — no
`"require"`. Reproduced directly with `node -e "require('multiformats/cid')"`: a hard Node.js
runtime resolution wall (`ERR_PACKAGE_PATH_NOT_EXPORTED`), not a TypeScript configuration issue —
bumping `tsconfig.json`'s `moduleResolution` to `"bundler"` typechecks clean but still fails at
actual runtime, since that setting only affects TypeScript's type resolution, not Node's real
`require()` resolution.

PR #11 was correctly left open rather than forced through (see the diagnostic comment already
posted on it). But this is a preview of a trend, not a one-off: more of the actively-maintained
npm ecosystem — especially packages tied to `@atproto`'s own toolchain — is going ESM-only over
time. Staying CommonJS means this exact class of breakage recurs on an unpredictable schedule
across future dependency bumps, not just this one. This migration is a deliberate architectural
fix, not a targeted unblock of PR #11 — though closing PR #11 is a direct, verifiable consequence
of it, not a separate step.

## Scope

Both run modes migrate together in one pass: `app/` (single-bot mode) and `fleet/` (fleet mode),
which share `shared/feedSource/` and are otherwise independently deployed. Splitting into two
sequential migrations was considered and rejected — the actual touch-up work is small enough
(see below) that the coordination overhead of a transitional mixed-module-system period isn't
worth it.

Out of scope: no restructuring of the shared feed-parsing layer, no changes to handler patterns
(`app/`'s plain-object exports, `fleet/`'s classes), no cleanup of unrelated dead `tsconfig.json`
settings (e.g. `outDir`, which nothing reads since there's no build step). This is a module-system
change, not a refactor.

## Current State (verified this session, not assumed)

- `fleet/` and `shared/` (60 files) already import sibling modules with explicit `.ts` extensions
  (e.g. `import {BotStore} from './botStore.ts'`) — already ESM-resolution-style.
- `app/` (8 files: `index.ts`, `utils/bskyHandler.ts`, `utils/rssHandler.ts`,
  `utils/queueHandler.ts`, and their `.test.ts` counterparts) uses extension-less relative imports
  (e.g. `import db from './dbHandler'`) — classic CJS-resolution style. This is the concentrated
  area of real work.
- Both production entry points already invoke via `node --import tsx` — `Dockerfile`'s
  `CMD ["node", "--import", "tsx", "app/index.ts"]` and the fleet VPS's `docker-compose.yml`
  `command: ["node", "--import", "tsx", "fleet/runFleet.ts"]`. This is Node's modern
  ESM-aware loader hook mechanism already — no entry-point invocation changes needed.
- Checked every direct dependency's module type: only `multiformats` (transitive, via `@atproto`)
  is CJS-incompatible. Everything else is either already dual-CJS/ESM-safe with a real `exports`
  map (`axios`, `jimp`, `feedsmith`, `html-entities`, `tsx`, `dotenv`, `open-graph-scraper`,
  `eslint`) or a devDependency/tool with no runtime import-graph relevance (`gts`, `typescript`,
  `@types/node`, `underscore-cli`).
- `eslint.config.js` is itself CJS today (`module.exports = [...]`, `require('gts')`). Once
  `package.json` sets `"type": "module"`, a plain `.js` file is interpreted as ESM by Node — this
  file's current syntax would break unless renamed or converted.
- No `engines` field exists in `package.json` today, and none is being added by this migration —
  Node 24 (the actual dev/Docker version in use) supports ESM fully; pinning a floor is an
  unrelated decision, not something this migration needs.

## Changes

1. **`package.json`**: add `"type": "module"`.

2. **`app/`'s 8 files**: add explicit `.ts` extensions to every relative import, matching the
   style already used throughout `fleet/`/`shared/`. Example:
   `import db from './dbHandler'` → `import db from './dbHandler.ts'`.

3. **`tsconfig.json`**: change `"moduleResolution": "node"` → `"nodenext"`, and add
   `"module": "nodenext"` (currently unset, inheriting `gts`'s `"commonjs"` — needs to match the
   project's actual runtime module system now). This is also what makes TypeScript correctly
   resolve `multiformats`'s import-only export condition during `yarn typecheck` — the same
   condition that fails today under `moduleResolution: "node"`.

4. **`eslint.config.js`**: convert to native ESM syntax (`import` + `export default`) rather than
   just renaming to `.cjs` — more consistent with the rest of the migration, and ESLint's flat
   config loader fully supports ESM config files once `package.json` sets `"type": "module"`.
   `require('gts')`'s current CJS `module.exports = [...]` (an array) becomes `import gtsConfig
   from 'gts'` — Node's CJS-from-ESM interop hands the same array to the default import, so the
   config's actual content is unchanged, only its syntax. Same for
   `require('typescript-eslint').plugin` → a named/default import. Verify this interop holds via
   `yarn lint` during implementation; fall back to a `.cjs` rename (keeping today's
   `module.exports`/`require` syntax unchanged) only if the ESM conversion proves awkward.

5. **Sweep for other CJS-only idioms** — the real sweep (done during plan-writing, not just a
   spot-check) found three categories, all confined to `app/`:

   - **`app/index.ts:7`**: bare `require('dotenv').config()` → `import 'dotenv/config';`,
     matching the exact pattern `fleet/runFleet.ts` already uses.
   - **`app/utils/dbHandler.ts`** (8 call sites) plus `app/utils/test-helpers.ts`,
     `app/utils/dbHandler.test.ts`, `app/utils/queueHandler.test.ts`,
     `app/utils/rssHandler.test.ts`, `shared/feedSource/normalize.test.ts`,
     `shared/feedSource/parse.test.ts`, `shared/feedSource/poller.test.ts`: `__dirname` → Node's
     native `import.meta.dirname` (available since Node 20.11 — this project already runs Node
     24 in both Docker and local dev, so no `fileURLToPath(import.meta.url)` fallback dance is
     needed).
   - **`app/utils/healthHandler.ts:40`**: `require('../../package.json').version` → read via
     `fs.readFileSync` + `JSON.parse`, or a JSON module import with an import attribute
     (`import pkg from '../../package.json' with {type: 'json'}`) — pick whichever the
     implementation finds cleaner; both work under Node 24 ESM.
   - **`app/utils/{bskyHandler,queueHandler,rssHandler,dbHandler}.test.ts`** (~40 call sites
     combined): the CJS module-reset pattern `delete require.cache[require.resolve('./x')];
     const x = require('./x').default;`, used because these handlers hold module-level mutable
     `let` state and each test needs a fresh instance. **ESM has no direct equivalent** —
     `require.cache` doesn't exist, and an already-imported ES module is a permanent singleton
     for the life of the process. Resolved via explicit discussion (not assumed): the "correct"
     fix — refactor `app/`'s handlers to factory functions instead of module-level singletons —
     is real production-code restructuring, out of scope for a module-system migration, and is
     tracked as its own separate follow-up (session task #74). **This migration's interim fix**:
     convert every call site to a dynamic `import()` with a cache-busting query string —
     `const x = (await import(\`./x.ts?t=${Date.now()}\`)).default;` — a widely-relied-upon (if
     not first-class-documented) Node ESM pattern for forcing a fresh module instance. Requires
     the enclosing test function to be `async` (most already are; verify each one during
     implementation). No production code changes — purely test-file mechanics. When task #74
     lands later, these call sites collapse to a plain factory call
     (e.g. `const x = createBskyHandler();`), a clean one-line swap per site.

6. **Bump `@atproto/api` to 0.20.38 and `@atproto/xrpc` to 0.8.10** (matching Renovate PR #11's
   target versions) as part of this same change — the direct proof the architectural fix works,
   not a separate follow-up step. PR #11 gets superseded the same way the jimp v1 migration
   superseded PR #19 earlier this session: closed with a comment pointing at the commit that
   subsumes it.

## Verification

Full local suite (`yarn typecheck && yarn test && yarn lint`) must pass clean before anything
ships. Because a module-system flip touches every file's resolution behavior — not just the files
directly edited — also manually smoke-run both entry points locally against a real feed
(`yarn dev:app`, `yarn dev:fleet`) before deploying, not just the automated suite.

## Rollout

Standard rigor: merge, cut a release, deploy to both the fleet VPS (`bsky-rss-fleet`, 60 live
bots, `ssh ob`) and the standalone `seismes-fr-test` bot, watch logs for a sustained clean period.
Matches the deploy pattern already used for every other production change this session — no
special-cased canary/staggered rollout, per explicit decision (the module-system change is
verified by the full test suite plus manual smoke-run before it ever reaches production, which is
the same confidence bar this session's other production changes shipped under).

## Testing

No new tests are added by this migration — it's a module-system change, not new behavior. The
existing 476-test suite (run via `tsx --test`, itself already ESM-aware) is the correctness bar:
if it passes clean under the new module system, the migration is behaviorally equivalent.
