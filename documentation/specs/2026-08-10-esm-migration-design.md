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

4. **`eslint.config.js` → `eslint.config.cjs`**: rename only, no syntax change. `.cjs` is always
   CommonJS regardless of `package.json`'s `"type"` field — the simplest fix, and ESLint's flat
   config loader has explicit, documented support for `.cjs` config files.

5. **Sweep for other CJS-only idioms**: grep the whole tree for `__dirname`, `__filename`,
   `require.resolve`, and any remaining bare `require(...)` calls outside `eslint.config.cjs`.
   None were spotted during this design's exploration, but that was a spot-check, not an
   exhaustive pass — the implementation must verify this directly rather than assume the spec's
   exploration caught everything.

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
