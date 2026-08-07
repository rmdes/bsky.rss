# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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
