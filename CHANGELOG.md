# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [2.11.3] - 2026-09-03

### Changed
- Bumped `axios` 1.19.0 → 1.20.0 and `@atproto/api` 0.20.41 → 0.20.42 / `@atproto/xrpc` 0.8.10 → 0.8.11
  (patch releases from upstream, PRs #29/#28). No code changes required; `yarn typecheck`/`yarn test`
  verified clean against the new versions.

---

## [2.11.2] - 2026-08-24

### Changed
- Bumped `@atproto/api` 0.20.38 → 0.20.41 (patch release from upstream). No code changes required;
  `yarn typecheck`/`yarn test` verified clean against the new version.

---

## [2.11.1] - 2026-08-12

### Fixed
- **Unbounded network hang on Bluesky API calls**: neither `app/utils/bskyHandler.ts` (single-bot
  mode) nor `fleet/bskyClient.ts` (fleet mode) applied any timeout to `BskyAgent`'s network calls
  (login, session resume, post, image upload) - a stalled connection to the PDS (no response, no
  error, connection never closes) left the `await` pending indefinitely. In single-bot mode this
  wedges `queueHandler.ts`'s `runQueue()`: `queueRunning` stays `true` forever, so every subsequent
  tick returns at the `if (queueRunning) return;` guard before ever reaching
  `health.updateActivity()` - `/health` keeps reporting `healthy` (the staleness threshold is 10
  minutes) while the queue is silently wedged. Observed live on the `seismes-fr-test` canary: a
  post attempt hung for ~10 minutes before an unrelated default eventually unstuck it. Both
  handlers now pass a wrapped `fetch` (`shared/http/timeoutFetch.ts`, new) that aborts any request
  exceeding 30 seconds via `AbortController`, matching the timeout `shared/feedSource/poller.ts`
  already applied to RSS fetches. A timeout is a genuinely uncertain outcome, not a rate limit, so
  it's classified and handled the same as any other non-rate-limit failure (see 2.11.0's fix
  above).

---

## [2.11.0] - 2026-08-12

### Fixed
- **Rate-limit misclassification on non-rate-limit failures**: both places `bskyHandler.post()`
  (single-bot mode) could report a failure - record creation and image upload - had the same root
  bug: any failure, not just a real 429/504, was reported as `{ratelimit: true}`, which
  `queueHandler.ts` retries forever via `unshift` + a 30s timer. The record-creation path now
  classifies the actual error (429 `RateLimitExceeded`/504 `UpstreamTimeout` only) and returns
  `{ratelimit: false}` for anything else - a genuinely uncertain outcome (validation failure,
  expired auth, malformed record, etc.) is now dropped (logged, skipped) instead of retried
  forever. **Behavior change**: a post that fails for a non-rate-limit reason is no longer retried
  - it's skipped. This is deliberate: an uncertain outcome might already have succeeded
  server-side, so blind retry risked either wedging the whole queue behind a permanently-broken
  item, or a duplicate post. If you run with `removeDuplicate: true`, note that the item's URL is
  already written to the dedupe file at queue time, so a dropped item is now permanently skipped,
  not just delayed - it will not be retried on a later run. The image-upload path is intentionally
  left retrying on failure (matching `fleet/bskyClient.ts`'s own `uploadBlob` catch): no record has
  been created yet at that point, so retrying can never produce a duplicate post, unlike the
  record-creation case.
- `yarn fleet:status`/`yarn fleet:log` no longer fail with "malformed snapshot" against a
  `status.json` written by a fleet still running the previous release (i.e. right after `git pull`,
  before the fleet container restarts) - a missing `limiters` field is now defaulted to
  `{ogQueueDepth: 0, imageQueueDepth: 0}` instead of being rejected. Self-heals automatically once
  the fleet restarts and starts writing the field again.

### Changed
- Internal structured logging module renamed from `FleetLogger` to `Logger` (`shared/logging/`) -
  no user-facing effect.
- `yarn fleet:status` output gained a `Limiters` line (shared OpenGraph/image queue depths),
  alongside various internal dead-code and duplication cleanup.

### Removed
- `BotStore.transaction()` - added in `2.10.0` below but never called from anywhere in the
  codebase; removed as unused dead code (confirmed zero callers, zero tests) rather than left as
  an untested, unexercised code path.

---

## [2.10.0] - 2026-08-12

### Fixed
- **Critical error handling gaps**: Empty catch blocks in `bskyHandler.ts` and `rssHandler.ts` that silently swallowed login failures, image upload errors, and image fetch errors now log the actual error before falling back or retrying
- **Error comparison anti-patterns**: Replaced fragile string comparisons (`if (e === 'Error: Rate Limit Exceeded')`) with proper instanceof Error checks and message inspection
- **ENOENT error detection**: Fixed string-parsing error detection (`String(e).startsWith('Error: ENOENT')`) to use proper `NodeJS.ErrnoException.code === 'ENOENT'` checks
- **Unhandled rejection handling**: Fleet mode now implements a circuit breaker pattern - process exits after 3 unhandled rejections in 60 seconds instead of logging and continuing indefinitely (prevents zombie processes)
- **Identity store race condition**: Fixed SQLite write contention when multiple bots share the same Bluesky identity by moving identity store cleanup from per-bot (59 bots × 60s = 59 cleanups/min) to fleet-level coordination (10 identities × 1 hour = 10 cleanups/hour)
- **Post-merge repair**: The commit batch above landed on `main` with a broken build (an incomplete `fleet/logging.ts` → `shared/logging/` rename, and `app/`'s handler factories gaining a required `logger` parameter that 3 test files weren't updated for) - fixed, along with 5 further bugs the resulting test failures surfaced: an empty `db.txt` cleanup writing a stray newline, two tests asserting the identity-store cleanup behavior this same release deliberately removed, a feed-poll test interval below this release's own new minimum, a process-safety test asserting wording this release's own circuit breaker made inaccurate, and an error message miscalculating 0.002 minutes as "7.2 seconds" (it's 0.12 seconds) in two places

### Changed
- **Event loop performance**: Replaced all 17 blocking `fs.*Sync` calls in `app/utils/dbHandler.ts` with async `fs/promises` operations to eliminate event loop blocking in single-bot mode
- **Cleanup efficiency**: Optimized `cleanupOldSeenValues()` to use `array.join()` instead of string concatenation for better performance
- **Fleet startup speed**: Reduced default `staggerSeconds` from 30s to 15s (59 bots: 29.5min → 14.75min startup time) while maintaining rate limit safety; value remains user-adjustable via `fleet.json`
- **Structured logging**: Migrated from ad-hoc `console.log` to structured FleetLogger in both app and fleet modes:
  - Replaced 55 console.log calls in single-bot mode
  - Extracted FleetLogger from `fleet/logging.ts` to `shared/logging/` for use across both modes
  - Added `LOG_LEVEL` environment variable support (`summary`/`verbose`/`debug` levels)
  - Built-in secret redaction for passwords, tokens, bearer auth, and credential-bearing URLs
  - Scoped logging (APP, LOGIN, QUEUE, POST, FETCH, RSS) for filtering
  - Consistent UTC timestamps across all log messages

### Added
- **SQLite concurrency improvements**: Enabled WAL (Write-Ahead Logging) mode for all fleet BotStore databases with NORMAL synchronous mode for better write concurrency when multiple bots share identity stores
- **Transaction support**: Added `transaction<T>(fn: () => T)` wrapper to BotStore for atomic multi-step operations
- **Runtime environment validation**: Added comprehensive startup validation for environment variables:
  - `FETCH_INTERVAL` validated as number >= 0.002 minutes (not NaN)
  - `FETCH_URL` and `INSTANCE_URL` validated as proper URLs with helpful error messages
  - feedSource `intervalMinutes` parameter validated >= 0.002 (0.12 seconds minimum)
  - feedSource `fetchTimeoutMs` validated as positive if provided
  - Type-safe `ValidatedEnv` object replaces raw `process.env` access
- **Bounded queues**: Added queue size limits to `ConcurrencyLimiter` (max 1000 items) to prevent unbounded memory growth when Open Graph fetches or image jobs slow down
- **HTTP connection pooling**: Added connection pool configuration (50 max sockets, 10 free sockets, 60s timeout) to prevent socket exhaustion at scale
- **Image size validation**: Added two-tier image validation to prevent OOM crashes:
  - Raw buffer size limit: 5MB before processing
  - Decompressed size limit: 100MB after JPEG decode (width × height × 4 bytes RGBA)
- **Developer documentation**:
  - `SECURITY.md` with supported versions table, private vulnerability reporting via GitHub Security Advisories, and deployment security best practices
  - `shared/feedSource/README.md` with complete API documentation, examples, and migration guide (455 lines)
  - 11 new convenience scripts in `package.json` (dev:logs, dev:clean, fleet:clean, docker:build, docker:run, docker:compose, test:feedSource, deps:check, deps:update, deps:audit)
- **feedSource API improvements**: Re-exported markdown functions (`extractMarkdownLinks`, `finalizeMarkdownLinks`, `buildFacets`) and types (`MarkdownFacet`, `ExtractedMarkdownLinks`, `MarkdownLinkResult`) from `shared/feedSource/index.ts` for single-import convenience
- **Fleet configuration documentation**: Added complete `fleet.json` documentation in `documentation/fleet.md`:
  - Documented all configuration options (`staggerSeconds`, `runIntervalSeconds`, `freshness`, `sharedLimiters`, `perBotQueueMaxLength`)
  - Explained rate limit context and startup time examples for different fleet sizes
  - Provided guidance on choosing safe stagger values

---

## [2.9.0] - 2026-08-11

### Changed
- Migrated the entire codebase from CommonJS to native ES modules (`"type": "module"`,
  `moduleResolution: "nodenext"`). No config, environment variable, or runtime behavior
  changes for anyone running the published Docker image - this unblocks dependency updates
  that require ESM-only packages.
- Bumped `@atproto/api` to `0.20.38` and `@atproto/xrpc` to `0.8.10` (previously blocked by
  a transitive ESM-only dependency under CommonJS).
- Refactored `app/`'s (single-bot mode) internal handlers from module-level singleton state
  to constructible factory functions, improving internal test isolation. No external
  behavior change.

---

## [2.8.1] - 2026-08-10

### Fixed
- Fleet mode's identity-scoped duplicate check no longer labels an ordinary same-bot re-poll
  skip as "cross-bot duplicate" - verified in production that the majority of these log lines
  came from bots with no shared identity at all (the same "already seen, skip" event that
  always happened, just now caught earlier and mislabeled). The message is identity-neutral now,
  matching the pre-2.8.0 wording.

---

## [2.8.0] - 2026-08-10

**Fleet mode: identity-scoped duplicate detection** - fixes bot configs sharing one Bluesky
account (e.g. multiple FreshRSS category feeds posting to the same identity) sometimes posting
the same story twice

### Fixed
- Fleet mode bot configs that deliberately share one Bluesky identity (different feeds, one
  account) now share duplicate-detection state across those configs, not just within each bot's
  own feed. Previously, the same story appearing in two category feeds could get posted twice to
  the same account, since each bot config only tracked what it had seen on its own. The check
  runs early, before any Open Graph/image work, and applies regardless of a bot's own
  `publishEmbed`/`removeDuplicate` settings.
- `dedupeKey` (the deterministic AT-Proto record key) is now scoped by the Bluesky identifier a
  bot config publishes to, not by its internal bot ID - a genuine cross-bot duplicate now
  collides at the PDS's own atomic per-record-key uniqueness constraint as defense-in-depth,
  even in the rare race window where two bots discover the same story in the same poll cycle.
- Fleet mode's per-bot `seen_items` table is now actually pruned on a 96-hour retention window
  (`BotStore.cleanupOldSeenValues`, implemented since the original fleet consolidation but never
  wired up) - it previously grew unboundedly for every bot with `removeDuplicate` enabled.

### Added
- `documentation/fleet.md` documents the new per-identity SQLite store
  (`data/fleet/identities/<identifier>.sqlite`) used for cross-bot duplicate detection.

---

## [2.7.0] - 2026-08-08

**Markdown-style links** - `[text](url)` syntax for cleaner, shorter clickable links in posts

### Added
- `[text](url)` Markdown-style link syntax for `string`/`imageAlt` - both sides support
  `$placeholders` (e.g. `[$title]($link)`, `[Map]($georss)`), resolved into real Bluesky link
  facets (clickable custom text instead of a raw URL). Bluesky/AT Protocol has no native Markdown
  parsing - this is bsky.rss's own template syntax, translated into facets before posting.

### Fixed
- Truncation no longer lets a link facet survive into the appended `...` ellipsis when its byte
  range lands just past the 277-character cutoff
- A `mappedValues` key containing `_` or `-` (e.g. `author_name`) used inside `[text](url)` no
  longer silently resolves to the wrong value - the placeholder-token charset now matches what
  `mappedValues` keys are actually allowed to be
- An auto-detected link (a bare URL that happens to appear inside a `[text](url)` span's display
  text) can no longer ship as a second, overlapping facet alongside the intended hand-built one

---

## [2.6.2] - 2026-08-08

### Fixed
- Single-bot mode's `/health` endpoint no longer reports `503 unhealthy` after 10 minutes of
  legitimate quiet (no new feed items) - activity is now refreshed on every queue tick, not only
  ticks that found something to post, and on every successful post during a long backlog drain

---

## [2.6.1] - 2026-08-08

### Fixed
- `mappedValues`: a malformed config shape (e.g. an object instead of an array) no longer throws
  and gets misreported as a feed-fetch failure - malformed entries are now skipped instead
- `mappedValues`: two keys that are prefixes of each other (e.g. `author`/`authorName`) no longer
  corrupt each other's substitution - keys are substituted longest-first
- `mappedValues`: substitution now runs before `$title`/`$link`/`$description`/`$georss` and
  guards against the original template, so feed-supplied content that happens to contain
  `$key`-shaped text can no longer be mistaken for a real placeholder
- `itunes:author` documentation now states explicitly that it reads the item-level
  `<itunes:author>` element only, with no fallback to the channel/show-level element

### Added
- Test coverage for the 6 previously-untested recognized `mappedValues` values (`dc:date`,
  `dc:subject`, `dc:publisher`, `itunes:episode`, `itunes:season`, `itunes:author`)

---

## [2.6.0] - 2026-08-08

### Added
- `$georss` now also resolves coordinates from the W3C Basic Geo namespace (`geo:lat`/`geo:long`) when a feed carries no `<georss:point>` - fixes feeds (e.g. BGS's world-earthquake RSS feed) that publish coordinates only that way. `georss:point` still wins when both are present.
- `mappedValues` config option - maps `dc:creator`/`dc:date`/`dc:subject`/`dc:publisher` and
  `itunes:duration`/`itunes:episode`/`itunes:season`/`itunes:explicit`/`itunes:author` feed fields
  into new `$key` template placeholders

---

## [2.5.0] - 2026-08-07

**GeoRSS Support** - a `$georss` template placeholder for feeds carrying geographic coordinates

### Added
- `$georss` template placeholder (`config.string`/`config.imageAlt`) - renders as an OpenStreetMap link built from a feed item's `<georss:point>` coordinates, if present

### Changed
- Atom entries with no `<link>` element now fall back to `<id>` as the link, when `<id>` is a real `http(s)://` URL - fixes feeds (e.g. Environment and Climate Change Canada's earthquake alerts) that previously failed with "No link provided from RSS reader" under `publishEmbed: true` or a `$link` template

---

## [2.4.0] - 2026-08-06

**Feed Parser Migration** - replaced the abandoned `feedsub`/`feedme` RSS parser with the actively-maintained `feedsmith` library

### Added
- `shared/feedSource/` module: shared feed polling, parsing, and normalization used by both single-bot mode (`app/utils/rssHandler.ts`) and fleet mode (`fleet/feedReader.ts`)
- Native RSS, Atom, JSON Feed, and RDF support (previously RSS/RDF-only via `feedme`)
- Feed body size cap (20MB) and re-entrancy guard against overlapping polls
- Quick-start deployment guides for all platforms (QUICKSTART.md)
- FAQ, config reference, examples, and architecture documentation

### Changed
- `imageField` config values (`"enclosure"`, `"media:content"`) now resolved via a dedicated image resolver instead of a raw `feedme` property walk; existing bot configs required no changes
- Poll-level failures (feed fetch/parse) and item-level failures (one bad item) are now reported with distinct error scopes, so a single malformed item no longer affects fleet-wide feed-health state

### Removed
- `feedsub` and `feedme` dependencies

## [2.3.0] - 2026-08-05

### Added
- Multi-cloud deployment configurations (Fly.io, Railway, Render, DigitalOcean App Platform)
- Health check HTTP endpoint (`/health`, port 8080) wired into fleet mode
- Comprehensive deployment documentation (DEPLOYMENT.md, PLATFORM-COMPARISON.md)
- Interactive deployment helper scripts (`scripts/deploy-fly.sh`, `scripts/deploy-railway.sh`)
- Renovate configuration for automated dependency management (RENOVATE.md), with auto-merge rules for minor/patch updates and security vulnerability auto-updates
- Comprehensive test suite for `app/` modules
- CONTRIBUTING.md and CHANGELOG.md

### Changed
- Reorganized README to treat Docker as equal deployment option alongside cloud platforms
- Resolved all `no-explicit-any` findings across production and test code
- Fixed CI so typecheck/lint failures are no longer silently misreported
- Declared `eslint` as a direct devDependency

## [2.2.0] - 2026-07-30

**Fleet Mode Release** - Major feature release enabling multi-bot deployments

### Added

#### Fleet Mode Infrastructure
- Multi-bot fleet runner supporting unlimited independent bots in a single process
- On-disk configuration loader with per-bot error isolation
- AuthCoordinator for staggered, error-isolated bot activation
- BotWorker with durable queue and freshness policy
- FeedReader with concurrent feed processing
- BskyClient with rkey-based posting and duplicate detection
- Shared resource limiters (concurrency, size, timeout guards)
- Process-wide crash-isolation safety net
- PID-file lock enforcing single-publisher-per-account
- Graceful SIGTERM/SIGINT shutdown handling

#### Fleet Mode Tools
- Legacy fleet importer for migration from single-bot deployments
- Rollback exporter for reverting to single-bot mode
- Benchmark CLI and synthetic multi-bot harness
- Manual empirical verification script for duplicate detection

#### Docker & CI/CD
- Slim, single-stage Docker image (356MB)
- Multi-arch builds (linux/amd64, linux/arm64)
- Tag-triggered GitHub Action publishing to ghcr.io/rmdes/bsky.rss
- Proper SIGTERM handling in containers
- Multi-stage build optimization
- Pruned devDependencies from shipped images

#### Documentation
- `documentation/fleet.md` - Fleet architecture and operations runbook
- Docker Compose template for fleet mode
- Single-service deployment template
- Migration guides (v1 to v2)

### Changed
- Reclassified `tsx` as runtime dependency (not devDependency)
- Updated package.json repository field to point to fork
- Exec fleet directly in Docker Compose instead of via yarn
- README now highlights fleet mode prominently

### Fixed
- Proper AT-Proto TID encoding for post rkey instead of raw hash
- Attached error listener to FeedSub instead of relying on global safety net
- Supplied missing intermediate cert for rappel.conso.gouv.fr
- SIGTERM-during-stagger race condition in fleet runner exit path
- Stack-overflow risk in benchmark harness
- Enforced uniqueness on queue_items.dedupe_key
- Extracted guid/id text before hashing into dedupe key
- Classified error fallthrough as uncertain instead of rate-limit
- Stopped re-querying server.address() per-request in benchmark mock server
- Enforced mode 0600 on imported secrets file

---

## [2.1.0] - 2025-05-23

### Added
- Adaptive posting interval feature
- Minimum spacing enforcement between posts
- `adaptiveSpacing` configuration option
- `minSpacing` configuration option (default: 1 second)
- `maxSpacing` configuration option (default: 60 seconds)
- `spacingWindow` configuration option (default: 600 seconds)
- Timestamp-based post interval tracking

### Fixed
- Adaptive spacing calculation for two consecutive posts
- Rate limit timer logic (condition was inverted)
- Malformed og:url protocols missing colon (e.g., `https//` → `https://`)
- URL validation regex to require proper protocol
- Improved Open Graph fetch reliability with better headers and timeout

---

## [2.0.0] - 2024-2025

**Major version with significant dependency updates and improvements**

### Changed
- Upgraded to TypeScript 6.0.3
- Upgraded to Node.js 24 (LTS)
- Upgraded to Yarn 4.14.1
- Updated all major dependencies:
  - @atproto/api: 0.19.19
  - axios: 1.16.1
  - tsx: 4.22.2
  - @types/node: 24.12.4
  - dotenv: 17.4.2
  - open-graph-scraper: 6.11.0
  - jimp: 0.22.12
  - html-entities: 2.6.0

### Added
- Automated dependency updates via Renovate
- Enhanced type safety with TypeScript 6
- Improved stability with latest dependencies

---

## [1.2.0] - 2023

### Added
- Open Graph support for external link embeds
- Card-style link previews with metadata extraction
- og:image, og:title, og:description parsing
- External link cards in posts

### Changed
- Moved away from cardyb library
- Enhanced RSS handler for better Open Graph integration
- Improved embed handling

---

## [1.1.0] - 2023

### Added
- Multi-language support with ISO 639-1 language codes
- `languages` configuration array
- Post truncation feature
- `truncate` configuration option
- Ability to use different RSS date fields
- `dateField` configuration option

### Changed
- More verbose logging
- Snapshot queue implementation
- Cleaned up TypeScript typings
- Custom run interval support

---

## [1.0.0] - 2023

**Initial Release**

### Added
- RSS feed monitoring and parsing
- Automated posting to Bluesky
- Template string support ($title, $link, $description)
- Configuration file (config.json)
- Environment variable configuration
- Docker support with docker-compose
- Queue-based posting system
- Rate limit handling
- Session persistence
- Duplicate prevention (date-based)
- HTML entity decoding
- Image embed support
- Custom user agent for Open Graph fetching

### Configuration Options
- `string`: Post template with variable substitution
- `publishEmbed`: Enable/disable embeds
- `embedType`: Choose between "card" and "image" embeds
- `runInterval`: Queue processing interval (seconds)
- `publishDate`: Use RSS item date as post date
- `imageField`: Custom RSS image field
- `imageAlt`: Alt text template for images
- `forceDescriptionEmbed`: Force RSS description in embed
- `removeDuplicate`: Text-based deduplication
- `descriptionClearHTML`: Strip HTML from descriptions
- `titleClearHTML`: Strip HTML from titles
- `ogUserAgent`: Custom User-Agent for Open Graph requests

### Technical Stack
- TypeScript
- Node.js
- @atproto/api for Bluesky integration
- feedsub for RSS parsing
- jimp for image processing
- open-graph-scraper for metadata extraction
- Docker for containerization

---

## [Unreleased] - Upcoming Features

Planned improvements and features under consideration:

- GitHub Actions CI/CD workflow for automated testing
- Additional deployment platforms (AWS, Google Cloud)
- Web dashboard for configuration management
- Metrics and analytics
- Support for additional feed formats (Atom, JSON Feed)
- Webhook support for real-time updates
- Database backend option (PostgreSQL, SQLite)

---

## Fork Information

This is the leading continued development fork of bsky.rss:
- **Original:** milanmdev/bsky.rss (archived)
- **Fork:** rmdes/bsky.rss (active development)
- **Fork created:** 2026-07-28

All development has moved to this fork as the upstream repository is no longer maintained.

---

[Unreleased]: https://github.com/rmdes/bsky.rss/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/rmdes/bsky.rss/releases/tag/v2.2.0
