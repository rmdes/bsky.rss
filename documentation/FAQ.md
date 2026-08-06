# Frequently Asked Questions (FAQ)

Quick answers to common questions about bsky.rss.

---

## Table of Contents

- [General](#general)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [Posting Behavior](#posting-behavior)
- [Deployment & Hosting](#deployment--hosting)
- [Fleet Mode](#fleet-mode)
- [Troubleshooting](#troubleshooting)
- [Advanced](#advanced)

---

## General

### What is bsky.rss?

bsky.rss is an automated RSS-to-Bluesky poster. It monitors RSS feeds and automatically posts new items to your Bluesky account.

**Use cases:**
- Auto-post blog updates to Bluesky
- Share news feed items as they're published
- Syndicate content from multiple sources
- Run announcement bots for organizations

### How does it work?

1. **Monitors RSS feed** - Checks your feed every 60 seconds (configurable)
2. **Detects new items** - Tracks what's already been posted
3. **Formats post** - Uses your template (e.g., `$title - $link`)
4. **Posts to Bluesky** - Creates post with optional link card or image
5. **Repeats** - Continues monitoring for new items

### Is it free?

**The software:** Yes, MIT licensed and open source.

**Hosting costs:**
- **Free tier:** Render.com (sleeps after inactivity, wakes on health check)
- **Paid:** $5-10/month on Railway, Fly.io, DigitalOcean
- **Self-hosted:** Just your server costs

**Bluesky:** Free (no API fees)

### Is my Bluesky password safe?

**Yes, if you use an app password** (recommended):
- Generate at Settings → App Passwords in Bluesky
- If compromised, revoke it without changing main password
- Limited scope (can't change account settings)

**Don't use your main account password** - use app passwords only.

### Can I run multiple bots?

**Yes, two ways:**

1. **Multiple deployments** (single-bot mode)
   - Deploy once per bot/feed combination
   - Simple but more expensive ($5/month × number of bots)

2. **Fleet mode** (multi-bot mode)
   - One deployment, many bots
   - Shared resources, lower cost
   - See [Fleet Mode Documentation](fleet.md)

---

## Getting Started

### How do I get started quickly?

**Fastest path:** [Quick Start Guide](QUICKSTART.md) - 10 minutes using Railway

**Steps:**
1. Get Bluesky app password
2. Find your RSS feed URL
3. Deploy to Railway (one click)
4. Upload config.json
5. Verify health endpoint

### What RSS feeds work?

**Supported formats:**
- RSS 2.0 (most common)
- Atom 1.0
- RDF

**Where to find feeds:**
- Blogs: Look for RSS icon or `/feed`, `/rss`, `/feed.xml`
- News sites: Usually have RSS for sections/categories
- Reddit: Add `.rss` to subreddit URL: `https://reddit.com/r/technology/.rss`
- YouTube: Channel RSS via `https://www.youtube.com/feeds/videos.xml?channel_id=CHANNEL_ID`
- Podcasts: Use the podcast RSS feed URL

**Test your feed:** Visit the URL in a browser - you should see XML.

### Do I need coding knowledge?

**No, for basic setup:**
- Quick Start uses Railway's web interface
- Config is JSON (easy to copy/paste)
- No code required

**Yes, for advanced customization:**
- Self-hosting requires Docker/CLI knowledge
- Custom modifications need TypeScript knowledge

### Which deployment platform should I choose?

**Quick comparison:**

| Platform | Best For | Cost | Ease |
|----------|----------|------|------|
| **Railway** | Beginners | $5/mo | Easiest ⭐⭐⭐⭐⭐ |
| **Fly.io** | Production | $5-10/mo | Moderate ⭐⭐⭐ |
| **Render** | Testing | Free tier | Easy ⭐⭐⭐⭐ |
| **Docker** | Self-hosting | Server cost | Technical ⭐⭐ |

**See:** [Platform Comparison](PLATFORM-COMPARISON.md) for detailed matrix.

---

## Configuration

### What does `runInterval` do?

Controls how often the bot checks the RSS feed for new items.

**Value:** Seconds between checks

**Examples:**
```json
{"runInterval": 60}     // Check every minute (recommended)
{"runInterval": 300}    // Check every 5 minutes (low-frequency feeds)
{"runInterval": 3600}   // Check every hour (very low-frequency)
```

**Recommendation:** 
- High-frequency feeds (news): `60` seconds
- Blogs/personal sites: `300` seconds
- Weekly updates: `3600` seconds

**Does NOT control posting frequency** - see adaptive spacing below.

### What is adaptive spacing?

Prevents spam by spreading posts over time instead of posting all at once.

**Without adaptive spacing:**
- Feed publishes 10 articles at once
- Bot posts all 10 immediately (likely hits rate limit)

**With adaptive spacing:**
```json
{
  "adaptiveSpacing": true,
  "spacingWindow": 600,
  "minSpacing": 30,
  "maxSpacing": 120
}
```
- 10 items in queue → posts every 60 seconds (600/10)
- 5 items → every 120 seconds (respects maxSpacing)
- 1 item → every 30 seconds (respects minSpacing)

**When to use:**
- High-volume feeds (news sites)
- Feeds that batch-publish multiple items
- Avoiding rate limits

**When NOT needed:**
- Low-frequency feeds (1 post/day)
- Feeds that publish one item at a time

### How do I customize post format?

Use the `string` config with variables:

**Variables available:**
- `$title` - Article title
- `$link` - Article URL
- `$description` - Article description/summary

**Examples:**

**Simple (default):**
```json
{"string": "$title - $link"}
```
→ `"Article Title - https://example.com/article"`

**With description:**
```json
{"string": "$title\n\n$description\n\n🔗 $link"}
```
→ 
```
Article Title

This is the article description...

🔗 https://example.com/article
```

**Title only (link in card):**
```json
{"string": "$title", "publishEmbed": true}
```
→ `"Article Title"` + link card preview

**Custom prefix:**
```json
{"string": "📰 New article: $title\n$link"}
```
→ `"📰 New article: Article Title\nhttps://example.com/article"`

### Should I use link cards or images?

**Link cards (`embedType: "card"`):**
- Shows title, description, preview image from link
- Fetched automatically via Open Graph
- Best for: News, blogs, general links
- No upload required

```json
{
  "publishEmbed": true,
  "embedType": "card"
}
```

**Images (`embedType: "image"`):**
- Uploads image from RSS feed
- You control alt text
- Best for: Photo blogs, media feeds
- Requires image URL in feed

```json
{
  "embedType": "image",
  "imageField": "enclosure",
  "imageAlt": "$title"
}
```

**Neither:**
```json
{"publishEmbed": false}
```
Just text, no media.

### How do I avoid duplicate posts?

**Two methods:**

**1. Date-based (default):**
```json
{"removeDuplicate": false}
```
- Tracks last post date in `/build/data/last.txt`
- Only posts items newer than last date
- Fast, simple
- **Limitation:** If feed items have same date → possible duplicates

**2. Text-based (recommended):**
```json
{"removeDuplicate": true}
```
- Stores post URLs/titles in `/build/data/db.txt`
- Checks each item against database
- Keeps 96-hour history (auto-cleanup)
- **Better:** Catches true duplicates even with same dates

**Use text-based if:**
- Feed has items with identical timestamps
- You're seeing duplicate posts
- You want stronger deduplication

---

## Posting Behavior

### How often does it post?

**Depends on feed activity + configuration.**

**Typical flow:**
1. Bot checks feed every `runInterval` seconds (default 60)
2. If new items found → adds to queue
3. Posts immediately (or uses adaptive spacing if enabled)
4. Repeats

**With adaptive spacing:**
- Queue = 10 items, spacing window = 600s → 1 post every 60 seconds
- Spreads posts over 10 minutes instead of all at once

**Without adaptive spacing:**
- Posts as fast as Bluesky allows (~1 per 30-60 seconds)
- May hit rate limits if many items at once

### What happens on first run?

**Default behavior:** Posts the **latest item** from the feed.

**Why not all items?**
- Prevents flooding your timeline with old posts
- Starts clean, then monitors for new items going forward

**Fleet mode:** Configurable via `maxCatchupItems`:
```json
{
  "freshness": {
    "maxCatchupItems": 5,      // Post up to 5 items on startup
    "maxItemAgeMinutes": 120   // Only if published in last 2 hours
  }
}
```

**To post all items (not recommended):**
- Delete `/build/data/last.txt` before deploying
- Bot will catch up (may hit rate limits)

### Does it handle rate limits?

**Yes, automatically.**

**What happens:**
1. Bot attempts to post
2. Bluesky returns rate limit error
3. Bot waits the required backoff period (usually 30-60 seconds)
4. Retries automatically
5. Queue persists across restarts

**You'll see in logs:**
```
[bsky.rss POST] Post rate limit exceeded, retrying after 30 seconds
```

**This is normal during:**
- Initial deployment (catching up)
- Feed publishes many items at once
- Bot was offline and catching up

**Prevention:** Enable adaptive spacing.

### Can I post old items retroactively?

**Yes, but carefully:**

**Method 1: Reset last post date**
1. Delete `/build/data/last.txt`
2. Restart bot
3. Posts latest item, then monitors for new

**Method 2: Clear duplicate database**
1. Delete `/build/data/db.txt` (if using `removeDuplicate: true`)
2. Delete `/build/data/last.txt`
3. Restart
4. May post multiple old items (respects rate limits)

**Warning:** Can flood your timeline. Consider:
- Using fleet mode's `maxCatchupItems`
- Enabling adaptive spacing first
- Testing with a small feed

### Can I schedule posts for specific times?

**Not directly.** bsky.rss posts items as they appear in the feed.

**Workarounds:**

**1. Use a scheduling RSS service:**
- Services like Buffer, Hootsuite can generate scheduled RSS feeds
- Point bsky.rss at that feed

**2. Self-host a scheduled feed:**
- Create a script that generates RSS at specific times
- Host it, point bsky.rss at it

**3. Adaptive spacing (simulates scheduling):**
- Posts spread over time window
- Not true scheduling but controls flow

---

## Deployment & Hosting

### How much does hosting cost?

**Platform pricing:**

| Platform | Free Tier | Paid Plan | Best For |
|----------|-----------|-----------|----------|
| **Render** | Yes (sleeps after 15min) | $7/mo | Testing |
| **Railway** | $5 credit/mo | $5/mo | Production |
| **Fly.io** | $5 credit/mo | ~$5-10/mo | Production |
| **DigitalOcean** | No | $5/mo | Existing DO users |
| **Self-hosted** | - | Server cost | Full control |

**Typical usage:** 1 bot uses ~256MB RAM, minimal CPU

### Can I run it for free?

**Yes, with limitations:**

**Render free tier:**
- Sleeps after 15 minutes of inactivity
- Wakes on HTTP request (health check)
- Use a free uptime monitor (UptimeRobot) to ping every 5 minutes
- Works for low-frequency feeds

**Railway/Fly.io credits:**
- $5 free credit per month
- Enough for 1 bot
- May need payment method on file

**Self-hosted:**
- If you already have a server
- No platform fees

### How do I monitor uptime?

**Built-in health check:**
- Endpoint: `https://your-app.com/health`
- Returns JSON with status

**Use external monitoring:**
- [UptimeRobot](https://uptimerobot.com) (free)
- [Healthchecks.io](https://healthchecks.io) (free tier)
- Set up alerts for downtime

**Example UptimeRobot setup:**
1. Add new monitor → HTTP(s)
2. URL: `https://your-app.railway.app/health`
3. Interval: 5 minutes
4. Alert contacts: Your email

### Can I self-host on a Raspberry Pi?

**Yes!** bsky.rss works on ARM devices.

**Requirements:**
- Raspberry Pi 3+ (4 recommended)
- Docker installed
- Reliable internet connection
- 512MB+ RAM free

**Setup:**
```bash
# On Raspberry Pi
git clone https://github.com/rmdes/bsky.rss.git
cd bsky.rss

# Create config
cp data/config.example.json data/config.json
# Edit config.json

# Create .env
cat > .env << EOF
IDENTIFIER=your-username.bsky.social
APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
FETCH_URL=https://your-feed.xml
INSTANCE_URL=https://bsky.social
EOF

# Run with Docker
docker-compose up -d
```

**Pros:** No hosting costs
**Cons:** You manage uptime, backups, security updates

---

## Fleet Mode

### What is fleet mode?

Fleet mode runs **multiple bots in a single process** instead of one container per bot.

**Use case:** Running 5+ bots efficiently.

**Example:**
- Single-bot mode: 5 bots = 5 containers = 5 × $5/month = $25/month
- Fleet mode: 5 bots = 1 container = 1 × $7/month = $7/month

**See:** [Fleet Mode Documentation](fleet.md) for details.

### When should I use fleet mode?

**Use fleet mode if:**
- Running 3+ bots
- Want to save money (shared resources)
- Need centralized management
- Want staggered login (avoids rate limits)

**Use single-bot mode if:**
- Running 1-2 bots
- Want simplicity (easier to debug)
- Need complete isolation
- Each bot has different resource needs

### Can I migrate from single-bot to fleet mode?

**Yes,** fleet mode includes import/export tools.

**Process:**
1. Export single-bot data (last.txt, db.txt, config.json)
2. Create fleet bot configuration
3. Import data into fleet bot directory
4. Deploy fleet mode

**See:** [Fleet Mode Migration](fleet.md#migrating-from-single-bot-mode)

---

## Troubleshooting

### Bot isn't posting anything

**Check logs for:**

**1. "No new items"**
- Feed has no new content since last post
- **Fix:** Wait for new feed items, or reset last.txt to post latest

**2. "Invalid credentials"**
- Wrong username or password
- **Fix:** Check IDENTIFIER format (needs `.bsky.social`), regenerate app password

**3. "Rate limit exceeded"**
- Normal during catch-up
- **Fix:** Enable adaptive spacing, wait (auto-retries)

**4. "Failed to fetch feed"**
- Feed URL is wrong or inaccessible
- **Fix:** Test feed URL in browser, check for 200 OK response

**See:** [Troubleshooting Guide](TROUBLESHOOTING.md) for detailed solutions.

### Health check returns "unhealthy"

**Cause:** Bot hasn't run successfully in 10+ minutes.

**Check logs for errors:**
- Authentication failures
- RSS fetch failures
- Config errors

**Fix root cause,** health automatically recovers after successful run.

### Images aren't showing in posts

**Check config:**

**Using card embed?**
```json
{"embedType": "card"}  // Shows link preview, NOT uploaded image
```

**To upload images:**
```json
{
  "embedType": "image",
  "imageField": "enclosure",
  "imageAlt": "$title"
}
```

**Also check:**
- Feed has image URLs in `imageField`
- Images are < 1MB (auto-resized)
- Images are JPEG/PNG/GIF/WEBP (not SVG/TIFF)

**See:** [Troubleshooting - Images](TROUBLESHOOTING.md#image-upload-failures)

### Getting duplicate posts

**Enable text-based deduplication:**
```json
{"removeDuplicate": true}
```

**Also ensure:**
- `/build/data` volume is persistent (not ephemeral)
- Not running multiple instances of same bot
- Config file is loading correctly

**See:** [Troubleshooting - Duplicates](TROUBLESHOOTING.md#duplicate-posts)

---

## Advanced

### Can I use a custom Bluesky instance?

**Yes,** set `INSTANCE_URL`:

```bash
INSTANCE_URL=https://your-instance.com
```

**Default:** `https://bsky.social` (official instance)

**Use case:** Self-hosted ATProto PDS instances.

### Can I post to multiple accounts from one feed?

**Yes, two ways:**

**1. Fleet mode (recommended):**
- One feed, multiple bot configs
- Each bot posts to different account
- Shared feed processing (efficient)

**2. Multiple single-bot deployments:**
- Deploy once per account
- Point all at same feed URL
- Simpler but more expensive

### How do I filter feed items?

**Not built-in,** but workarounds:

**1. Use a filtered feed:**
- Services like [FetchRSS](https://fetchrss.com) can filter feeds
- Point bsky.rss at the filtered feed

**2. Feed supports filtering:**
- Some feeds have category-specific URLs
- Example: `https://blog.com/feed?category=tech`

**3. Fork and modify:**
- Edit `app/utils/rssHandler.ts`
- Add custom filtering logic
- Maintain your own fork

### Can I add hashtags automatically?

**Yes,** in the `string` template:

```json
{
  "string": "$title - $link #automation #rss #bluesky"
}
```

**Or dynamic based on content:**
- Not built-in
- Would require custom modification
- Fork and edit `app/utils/rssHandler.ts`

### Is there a web dashboard?

**No,** bsky.rss is backend-only (no UI).

**Monitoring:**
- View logs via your platform's dashboard
- Health check endpoint: `/health`
- Bluesky profile shows posted items

**Fleet mode status:**
- `yarn fleet:status` command (SSH into container)
- Shows all bots, queue lengths, last activity

### Can I contribute?

**Yes!** Open source, MIT licensed.

**Ways to contribute:**
- Report bugs (use issue templates)
- Suggest features
- Submit pull requests
- Improve documentation
- Share your use case

**See:** [Contributing Guide](../CONTRIBUTING.md)

---

## Getting Help

**Documentation:**
- [Quick Start](QUICKSTART.md) - 10-minute setup
- [Troubleshooting](TROUBLESHOOTING.md) - Common issues
- [Deployment Guide](DEPLOYMENT.md) - Platform-specific setup
- [Configuration Reference](CONFIGURATION.md) - All config options

**Support:**
- [GitHub Issues](https://github.com/rmdes/bsky.rss/issues) - Bug reports, feature requests
- [GitHub Discussions](https://github.com/rmdes/bsky.rss/discussions) - Questions, community

**Before asking:**
1. Check this FAQ
2. Check Troubleshooting Guide
3. Search existing issues
4. Review logs for errors
