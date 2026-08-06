# Architecture Documentation

Technical overview of bsky.rss system design, data flow, and component architecture.

---

## Table of Contents

- [System Overview](#system-overview)
- [Deployment Modes](#deployment-modes)
- [Single-Bot Architecture](#single-bot-architecture)
- [Fleet Mode Architecture](#fleet-mode-architecture)
- [Data Flow](#data-flow)
- [Component Reference](#component-reference)
- [Data Persistence](#data-persistence)
- [Extension Points](#extension-points)

---

## System Overview

bsky.rss is a Node.js/TypeScript application that bridges RSS feeds to Bluesky's ATProto network. It operates as a long-running process that:

1. Monitors RSS feeds for new items
2. Processes and formats content
3. Posts to Bluesky accounts
4. Manages rate limits and deduplication
5. Exposes health check endpoints

**Technology Stack:**
- **Runtime:** Node.js 22+
- **Language:** TypeScript 6.0+
- **Package Manager:** Yarn 4+
- **Key Dependencies:**
  - `@atproto/api` - Bluesky/ATProto client
  - `feedsub` - RSS feed monitoring
  - `open-graph-scraper` - Link preview metadata
  - `jimp` - Image processing
  - `axios` - HTTP requests

**Deployment:**
- Containerized via Docker
- Cloud platforms (Fly.io, Railway, Render)
- Self-hosted (Docker, manual)

---

## Deployment Modes

### Single-Bot Mode

**Entry point:** `app/index.ts`  
**Command:** `yarn start`

- One bot per process/container
- Simple, isolated architecture
- Easy to debug and deploy
- Suitable for 1-5 bots

### Fleet Mode

**Entry point:** `fleet/runFleet.ts`  
**Command:** `yarn fleet`

- Multiple bots in one process
- Shared resources and rate limiters
- Staggered authentication
- Cost-efficient for 5+ bots

**See:** [Fleet Mode Documentation](fleet.md) for detailed architecture.

---

## Single-Bot Architecture

### High-Level Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        app/index.ts                          │
│                      (Entry Point)                           │
└────┬─────────────┬──────────────┬──────────────┬───────────┘
     │             │              │              │
     ▼             ▼              ▼              ▼
┌──────────┐ ┌──────────┐  ┌──────────┐  ┌──────────────┐
│  bsky    │ │   rss    │  │  queue   │  │   health     │
│ Handler  │ │ Handler  │  │ Handler  │  │   Handler    │
└────┬─────┘ └────┬─────┘  └────┬─────┘  └──────────────┘
     │            │             │
     │            │             │
     ▼            ▼             ▼
┌──────────────────────────────────────┐
│           dbHandler                  │
│      (File Persistence)              │
└──────────────────────────────────────┘
     │
     ▼
┌──────────────────────────────────────┐
│        /build/data/                  │
│  - config.json                       │
│  - last.txt                          │
│  - db.txt                            │
│  - persist.json                      │
└──────────────────────────────────────┘
```

### Component Responsibilities

**app/index.ts** (Entry Point)
- Initialize environment
- Start health check server
- Authenticate with Bluesky
- Launch RSS reader
- Start queue processor
- Handle shutdown

**app/utils/bskyHandler.ts** (Bluesky Integration)
- ATProto API client initialization
- Session management (login, refresh)
- Post creation (text, embeds, images)
- Rate limit detection and handling
- Error handling and retries

**app/utils/rssHandler.ts** (Feed Processing)
- RSS feed subscription via `feedsub`
- Item parsing and normalization
- HTML entity decoding
- Content extraction (title, link, description)
- Date field resolution
- Open Graph metadata fetching
- Image URL resolution
- Item filtering and validation

**app/utils/queueHandler.ts** (Post Queue)
- FIFO queue management
- Adaptive spacing calculation
- Post scheduling and execution
- Rate limit backoff
- Queue persistence across restarts
- Error handling and retry logic

**app/utils/dbHandler.ts** (Data Persistence)
- Config file loading
- Last post date tracking
- Duplicate detection database
- Persistent data storage
- File I/O operations

**app/utils/healthHandler.ts** (Monitoring)
- HTTP server for health checks
- Readiness state tracking
- Activity timestamp tracking
- Health status reporting

---

## Fleet Mode Architecture

### High-Level Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                     fleet/runFleet.ts                         │
│                      (Entry Point)                            │
└────┬──────────────┬────────────────┬────────────────┬────────┘
     │              │                │                │
     ▼              ▼                ▼                ▼
┌──────────┐  ┌──────────┐    ┌──────────┐    ┌──────────┐
│  config  │  │   auth   │    │ shared   │    │  health  │
│  Loader  │  │Coordinator│   │Limiters  │    │ Handler  │
└────┬─────┘  └────┬─────┘    └────┬─────┘    └──────────┘
     │             │               │
     │             │               │
     ▼             ▼               ▼
┌────────────────────────────────────────────────────────┐
│              BotWorker[] (N instances)                 │
│  ┌─────────────────────────────────────────────────┐  │
│  │  botWorker.ts                                   │  │
│  │  ├─ feedReader.ts (RSS monitoring)              │  │
│  │  ├─ bskyClient.ts (Bluesky posting)             │  │
│  │  ├─ botStore.ts (SQLite persistence)            │  │
│  │  └─ queue (per-bot post queue)                  │  │
│  └─────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
     │
     ▼
┌──────────────────────────────────────┐
│      config.example/bots/            │
│  ├─ bot-1/                           │
│  │  ├─ bot.json                      │
│  │  ├─ posting.json                  │
│  │  └─ bot.db (SQLite)               │
│  ├─ bot-2/                           │
│  └─ ...                              │
└──────────────────────────────────────┘
```

### Fleet Mode Components

**fleet/runFleet.ts** (Orchestrator)
- Loads fleet configuration
- Spawns bot workers
- Coordinates shutdown
- Manages shared resources

**fleet/authCoordinator.ts** (Staggered Auth)
- Prevents simultaneous logins
- Staggers bot authentication
- Reduces rate limit risk
- Coordinates bot startup

**fleet/botWorker.ts** (Per-Bot Worker)
- Independent bot lifecycle
- RSS monitoring
- Post queue management
- Bluesky posting
- Error isolation

**fleet/feedReader.ts** (RSS Processing)
- Similar to single-bot rssHandler
- Per-bot feed monitoring
- Item extraction and parsing

**fleet/bskyClient.ts** (Bluesky Integration)
- Similar to single-bot bskyHandler
- Session management
- Post creation
- Rate limit handling

**fleet/botStore.ts** (SQLite Persistence)
- Per-bot SQLite database
- Last post tracking
- Duplicate detection
- Session persistence

**fleet/sharedLimiters.ts** (Resource Management)
- Fleet-wide rate limiters
- Concurrent Open Graph fetches
- Concurrent image processing
- Prevents resource exhaustion

**fleet/configLoader.ts** (Configuration)
- Loads fleet.json
- Loads per-bot configs
- Validates configuration
- Handles secrets

---

## Data Flow

### Single-Bot Mode Flow

```
1. RSS Feed Monitor (rssHandler)
   │
   ├─ Polls feed every runInterval seconds
   │
   ▼
2. New Item Detected
   │
   ├─ Parse item (title, link, description, date)
   ├─ Check if newer than last post (dbHandler.readLast)
   │
   ▼
3. Item Processing (rssHandler)
   │
   ├─ Decode HTML entities
   ├─ Clean HTML if configured
   ├─ Fetch Open Graph metadata (if embedType: card)
   ├─ Resolve image URL (if embedType: image)
   │
   ▼
4. Duplicate Check (dbHandler)
   │
   ├─ Check against db.txt if removeDuplicate: true
   ├─ Skip if duplicate
   │
   ▼
5. Queue Item (queueHandler)
   │
   ├─ Add to FIFO queue
   ├─ Calculate adaptive spacing if enabled
   │
   ▼
6. Post to Bluesky (bskyHandler)
   │
   ├─ Format post text (replace variables)
   ├─ Upload image if embedType: image
   ├─ Create post with embed
   ├─ Handle rate limits (retry with backoff)
   │
   ▼
7. Update State (dbHandler)
   │
   ├─ Write item URL to db.txt
   ├─ Update last.txt with post date
   │
   ▼
8. Health Update (healthHandler)
   │
   └─ Update lastActivityTime
```

### Fleet Mode Flow

```
1. Fleet Startup
   │
   ├─ Load fleet.json config
   ├─ Discover bot configs in bots/ directory
   │
   ▼
2. Staggered Bot Launch (authCoordinator)
   │
   ├─ Bot 1 starts → wait staggerSeconds
   ├─ Bot 2 starts → wait staggerSeconds
   ├─ Bot N starts
   │
   ▼
3. Per-Bot Worker Loop (botWorker)
   │
   ├─ Authenticate with Bluesky (bskyClient)
   ├─ Start RSS monitor (feedReader)
   ├─ Load bot state from SQLite (botStore)
   │
   ▼
4. RSS Monitoring (feedReader)
   │
   ├─ Each bot polls its own feed
   ├─ Processes items independently
   ├─ Respects sharedLimiters for OG/image fetches
   │
   ▼
5. Post Queue (per-bot)
   │
   ├─ Each bot has independent queue
   ├─ Adaptive spacing per bot
   ├─ No cross-bot coordination
   │
   ▼
6. Bluesky Posting (bskyClient)
   │
   ├─ Per-bot session management
   ├─ Independent rate limiting
   ├─ Retry logic
   │
   ▼
7. State Persistence (botStore)
   │
   └─ Update SQLite database per bot
```

---

## Component Reference

### bskyHandler / bskyClient

**Responsibilities:**
- ATProto client lifecycle
- Session management
- Post creation
- Image uploads
- Rate limit handling

**Key Methods:**

```typescript
// Single-bot (bskyHandler.ts)
async function init(instanceUrl: string): Promise<void>
async function login(creds: {identifier: string, password: string}): Promise<void>
async function post(postText: string, embed?: object): Promise<PostResponse>
async function uploadImage(imageUrl: string, altText: string): Promise<BlobRef>

// Fleet (bskyClient.ts)
class BskyClient {
  async login(identifier: string, password: string): Promise<void>
  async createPost(text: string, embed?: object): Promise<PostResponse>
  async uploadBlob(imageBuffer: Buffer): Promise<BlobRef>
}
```

**Error Handling:**
- Rate limit errors → return `{ratelimit: true, retryAfter: seconds}`
- Auth errors → retry with backoff, eventually throw
- Network errors → retry with exponential backoff

**Session Refresh:**
- Automatic refresh on session expiry
- Persisted across restarts (fleet mode via SQLite)

---

### rssHandler / feedReader

**Responsibilities:**
- RSS feed subscription
- Item parsing and normalization
- Open Graph metadata fetching
- Image resolution
- HTML cleaning

**Key Methods:**

```typescript
// Single-bot (rssHandler.ts)
async function init(opts: {fetch_interval: number, fetch_url: URL}): Promise<void>
async function start(): Promise<void>
async function launch(): Promise<void>

// Fleet (feedReader.ts)
class FeedReader {
  async start(): Promise<void>
  private async processItem(item: FeedItem): Promise<void>
}
```

**Feed Monitoring:**
- Uses `feedsub` library for RSS subscription
- Emits `item` event for each new item
- Handles feed errors (network, parse errors)
- Respects `runInterval` / `fetchIntervalMinutes`

**Open Graph Fetching:**
- Uses `open-graph-scraper` library
- Respects `ogUserAgent` config
- Timeout: 10 seconds (fleet) / default (single-bot)
- Fallback to feed data if OG fetch fails

**HTML Processing:**
- Decodes HTML entities (`&amp;` → `&`, `&quot;` → `"`)
- Strips HTML tags if `descriptionClearHTML` / `titleClearHTML`
- Truncates to 300 chars if `truncate: true`

---

### queueHandler

**Responsibilities:**
- FIFO queue management
- Adaptive spacing calculation
- Post scheduling
- Rate limit backoff

**Key Methods:**

```typescript
async function add(item: QueueItem): Promise<void>
async function start(): Promise<void>
async function runQueue(): Promise<QueueRunResult>
function calculateDelay(queueSize: number): number
```

**Queue Structure:**
```typescript
interface QueueItem {
  text: string;
  embed?: object;
  timestamp: number;
}
```

**Adaptive Spacing Algorithm:**
```typescript
const delay = Math.max(
  config.minSpacing,
  Math.min(
    config.maxSpacing,
    config.spacingWindow / queueSize
  )
);
```

**Rate Limit Handling:**
- On rate limit → set `rateLimited = true`
- Start backoff timer (30-60 seconds)
- Queue items persist
- Resume after backoff

---

### dbHandler / botStore

**Responsibilities:**
- Configuration loading
- Last post date persistence
- Duplicate detection
- Session data storage

**Single-bot (dbHandler.ts) - File-based:**

```typescript
async function readConfig(): Promise<Config>
async function readLast(): Promise<string>
async function writeDate(date: Date): Promise<void>
async function valueExists(value: string): Promise<boolean>
async function writeValue(value: string): Promise<void>
async function cleanupOldValues(): Promise<void>
```

**Files:**
- `config.json` - Bot configuration
- `last.txt` - Last post ISO date
- `db.txt` - Duplicate detection (URL|timestamp per line)
- `persist.json` - Custom persistent data

**Fleet (botStore.ts) - SQLite:**

```typescript
class BotStore {
  async getLastPostDate(): Promise<Date | null>
  async setLastPostDate(date: Date): Promise<void>
  async hasSeenUrl(url: string): Promise<boolean>
  async markUrlSeen(url: string): Promise<void>
  async cleanup(): Promise<void>
}
```

**Database Schema:**
```sql
CREATE TABLE state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

CREATE TABLE seen_urls (
  url TEXT PRIMARY KEY,
  seen_at INTEGER
);
```

---

### healthHandler

**Responsibilities:**
- HTTP health check endpoint
- Readiness state tracking
- Activity monitoring

**API Endpoint:**

```
GET /health
GET /

Response 200 (healthy):
{
  "status": "healthy",
  "ready": true,
  "lastActivity": "2026-08-06T12:34:56.789Z",
  "timeSinceActivity": "30s",
  "uptime": 1234.56,
  "version": "2.2.0"
}

Response 503 (unhealthy):
{
  "status": "unhealthy",
  "ready": false,
  "lastActivity": "2026-08-06T12:00:00.000Z",
  "timeSinceActivity": "720s",
  ...
}
```

**Health Criteria:**
- `ready: true` - Bot initialized successfully
- `timeSinceActivity < 600s` - Active in last 10 minutes
- Both required for `status: "healthy"`

---

## Data Persistence

### Single-Bot Mode (File-based)

**Location:** `/build/data/` (container path)

**Files:**

| File | Purpose | Format | Cleanup |
|------|---------|--------|---------|
| config.json | Bot configuration | JSON object | Manual |
| last.txt | Last post date | ISO 8601 string | Overwritten |
| db.txt | Duplicate URLs | `date\|URL\n` | Auto (96 hours) |
| persist.json | Custom data | JSON object | Manual |

**Persistence Requirements:**
- Must mount volume at `/build/data`
- Files survive restarts
- No database required

**Cleanup:**
- `db.txt` auto-cleaned every run (removes entries > 96 hours)
- Other files persist indefinitely

---

### Fleet Mode (SQLite)

**Location:** `config.example/bots/{bot-id}/bot.db`

**Advantages:**
- ACID transactions
- Concurrent access safe
- Structured queries
- Better performance

**Schema:**
```sql
-- State table (last post date, session tokens)
CREATE TABLE state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

-- Duplicate detection
CREATE TABLE seen_urls (
  url TEXT PRIMARY KEY,
  seen_at INTEGER
);

-- Automatic cleanup
DELETE FROM seen_urls WHERE seen_at < (strftime('%s', 'now') - 345600);
```

**Backup:**
- SQLite files can be copied while bot running
- No special export needed

---

## Extension Points

### Adding a New Feed Parser

**Location:** `app/utils/rssHandler.ts` or `fleet/feedReader.ts`

**Steps:**
1. Add custom field extraction in `processItem()`
2. Update `Config` interface in `app/types/index.d.ts`
3. Add config option to `config.example.json`
4. Test with sample feed

**Example - Custom date field:**
```typescript
const dateField = config.dateField || 'pubDate';
const pubDate = item[dateField] || item.pubDate || item.date;
```

---

### Adding a New Embed Type

**Location:** `app/utils/bskyHandler.ts` or `fleet/bskyClient.ts`

**Current embed types:**
- `card` - Link preview (Open Graph)
- `image` - Uploaded image

**To add new type (e.g., `video`):**
1. Add to `Config` type: `embedType: "card" | "image" | "video"`
2. Implement embed creation in `post()` method:
```typescript
if (config.embedType === 'video') {
  embed = await createVideoEmbed(videoUrl);
}
```
3. Update configuration documentation

---

### Custom Rate Limiting

**Location:** `app/utils/queueHandler.ts`

**Current algorithm:** Fixed adaptive spacing

**To customize:**
1. Modify `calculateDelay()` function
2. Add new config options (e.g., `rateLimitStrategy`)
3. Implement strategy:
```typescript
if (config.rateLimitStrategy === 'time-based') {
  // Post only during certain hours
  const hour = new Date().getHours();
  if (hour < 9 || hour > 17) return;
}
```

---

### Adding Monitoring / Metrics

**Location:** Create `app/utils/metricsHandler.ts`

**Metrics to track:**
- Posts per hour
- Queue depth over time
- Rate limit hits
- Feed fetch errors
- Duplicate rate

**Export options:**
- Prometheus endpoint (`/metrics`)
- StatsD integration
- CloudWatch / Datadog

**Example:**
```typescript
export function recordPost() {
  postsTotal++;
  postsPerHour[currentHour]++;
}

export function getMetrics() {
  return {
    posts_total: postsTotal,
    queue_depth: queue.length,
    rate_limits_hit: rateLimitCount
  };
}
```

Add endpoint in `healthHandler.ts`:
```typescript
if (req.url === '/metrics') {
  const metrics = metricsHandler.getMetrics();
  res.end(JSON.stringify(metrics));
}
```

---

### Adding Database Backend

**Current:** File-based (single-bot), SQLite (fleet)

**To add PostgreSQL/MySQL:**

1. Create `app/utils/dbAdapter.ts` interface:
```typescript
interface DbAdapter {
  readConfig(): Promise<Config>;
  readLast(): Promise<Date>;
  writeDate(date: Date): Promise<void>;
  valueExists(value: string): Promise<boolean>;
  writeValue(value: string): Promise<void>;
}
```

2. Implement adapters:
```typescript
class FileDbAdapter implements DbAdapter { ... }
class PostgresDbAdapter implements DbAdapter { ... }
```

3. Select adapter based on env var:
```typescript
const adapter = process.env.DB_TYPE === 'postgres'
  ? new PostgresDbAdapter()
  : new FileDbAdapter();
```

---

## Testing Architecture

**Test Framework:** Node.js native test runner (`node:test`)

**Test Location:** Co-located with source files
- `app/utils/*.test.ts`
- `fleet/*.test.ts`

**Test Strategy:**
- **Unit tests:** Pure functions (parsing, formatting)
- **Integration tests:** Component interactions (mocked I/O)
- **Contract tests:** External API shapes (Bluesky, RSS)

**Test Coverage:** 90%+ (both single-bot and fleet modes)

**See:** [TESTING.md](TESTING.md) for detailed testing guide.

---

## Deployment Architecture

### Cloud Platforms

**Common pattern:**
```
┌─────────────────────┐
│  Platform (Fly.io,  │
│  Railway, Render)   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐      ┌──────────────┐
│  Container          │      │  Volume      │
│  ┌───────────────┐  │◄────►│              │
│  │  bsky.rss     │  │      │  /build/data │
│  │  (Node app)   │  │      │  - config    │
│  └───────────────┘  │      │  - state     │
│                     │      └──────────────┘
│  Port 8080          │
│  /health endpoint   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Health Checks      │
│  - HTTP /health     │
│  - TCP port 8080    │
└─────────────────────┘
```

**Key components:**
- Container running Node.js app
- Persistent volume for `/build/data`
- Health check endpoint on port 8080
- Environment variables for secrets

---

## Performance Considerations

**Memory Usage:**
- Single-bot: ~128-256MB
- Fleet (5 bots): ~256-512MB
- Scales linearly with bot count

**CPU Usage:**
- Mostly idle (event-driven)
- Spikes during:
  - RSS feed parsing
  - Image processing
  - Open Graph fetching

**Network:**
- RSS feed polls (every 60-3600s per feed)
- Open Graph fetches (per new item)
- Image downloads (if embedType: image)
- Bluesky API calls (per post)

**Optimization:**
- Fleet mode: Shared limiters prevent unbounded concurrent work
- Adaptive spacing: Reduces rate limit hits
- Image resizing: Keeps uploads under 1MB

---

## Security Considerations

**Secrets Management:**
- App passwords via environment variables
- Never commit to version control
- Rotate regularly

**Network Security:**
- HTTPS for all external requests
- Validate RSS feed URLs
- Sanitize user-controlled config

**Container Security:**
- Run as non-root user
- Minimal base image
- Regular dependency updates (Renovate)

**Rate Limit Abuse:**
- Adaptive spacing prevents self-DDoS
- Backoff on rate limits
- Fleet mode staggers auth

---

## Debugging

**Logs:**
```
[2026-08-06T12:00:00.000Z] - [bsky.rss AUTH] Logged in successfully
[2026-08-06T12:00:01.000Z] - [bsky.rss RSS] Fetched 5 items from feed
[2026-08-06T12:00:02.000Z] - [bsky.rss POST] Posted new item: "Title"
```

**Log levels:**
- INFO: Normal operation
- ERROR: Failures (with stack traces)

**Common debug points:**
- RSS parsing: Check feed XML structure
- Open Graph: Inspect OG tags on target page
- Rate limits: Check Bluesky account age/reputation
- Duplicates: Inspect `db.txt` or SQLite database

**Fleet mode debugging:**
```bash
yarn fleet:status  # Show all bots, queue lengths, last activity
yarn fleet:log     # Live log streaming
```

---

## Further Reading

- **[Quick Start Guide](QUICKSTART.md)** - Deploy in 10 minutes
- **[Configuration Reference](CONFIGURATION.md)** - All config options
- **[Troubleshooting Guide](TROUBLESHOOTING.md)** - Common issues
- **[Fleet Mode Documentation](fleet.md)** - Multi-bot architecture
- **[Testing Guide](TESTING.md)** - Test patterns and coverage
- **[Contributing Guide](../CONTRIBUTING.md)** - Development workflow
