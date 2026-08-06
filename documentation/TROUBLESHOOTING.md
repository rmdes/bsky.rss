# Troubleshooting Guide

Common issues and solutions for bsky.rss deployments. Issues are organized by symptom for quick diagnosis.

---

## Table of Contents

- [Authentication Issues](#authentication-issues)
- [No Posts Appearing](#no-posts-appearing)
- [RSS Feed Problems](#rss-feed-problems)
- [Image Upload Failures](#image-upload-failures)
- [Duplicate Posts](#duplicate-posts)
- [Rate Limiting](#rate-limiting)
- [Configuration Errors](#configuration-errors)
- [Deployment Issues](#deployment-issues)
- [Health Check Failures](#health-check-failures)
- [Performance Issues](#performance-issues)

---

## Authentication Issues

### ❌ "Invalid identifier or password" Error

**Symptoms:**
```
[bsky.rss AUTH] Error: Invalid identifier or password
[bsky.rss AUTH] Authentication failed, retrying in 60 seconds
```

**Causes & Solutions:**

#### 1. Wrong Identifier Format

**Problem:** Username missing `.bsky.social` suffix

❌ Wrong:
```bash
IDENTIFIER=myusername
```

✅ Correct:
```bash
IDENTIFIER=myusername.bsky.social
# OR use email
IDENTIFIER=me@example.com
```

#### 2. Invalid App Password

**Problem:** Using account password instead of app password, or app password was revoked

**Fix:**
1. Log into Bluesky → **Settings** → **App Passwords**
2. Create a new app password
3. Update `APP_PASSWORD` environment variable
4. Restart deployment

**Common mistake:** Copying the app password name instead of the actual password value.

#### 3. Spaces in Password

**Problem:** Accidental spaces when copying app password

**Fix:**
```bash
# Remove any spaces from the password
APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

---

## No Posts Appearing

### ✅ Health Check OK, But No Posts on Bluesky

**Check logs for these patterns:**

#### Scenario 1: No New Items in Feed

**Logs show:**
```
[bsky.rss RSS] Fetched 3 items from feed
[bsky.rss RSS] No new items to post (all older than last post date)
```

**Cause:** Bot tracks the last post date and only posts newer items.

**Solutions:**

**Option A: Post a specific existing item** (testing)
1. Delete `/build/data/last.txt` (via volume access or SSH)
2. Restart - bot will post the latest item

**Option B: Reset to post all items**
1. Delete `/build/data/last.txt`
2. Delete `/build/data/db.txt` (if using `removeDuplicate: true`)
3. Restart - bot will catch up (respects `maxCatchupItems` in fleet mode)

**Option C: Wait for new feed items**
- Normal operation - bot is working correctly

#### Scenario 2: Feed Check Interval Too Long

**Config shows:**
```json
{
  "runInterval": 3600
}
```

**Cause:** Bot only checks feed every hour (3600 seconds).

**Fix:** Reduce interval for faster posting:
```json
{
  "runInterval": 60
}
```

**Recommended intervals:**
- High-frequency feeds (news): `60` seconds
- Medium-frequency (blogs): `300` seconds (5 min)
- Low-frequency (weekly): `3600` seconds (1 hour)

#### Scenario 3: Rate Limited (Expected Behavior)

**Logs show:**
```
[bsky.rss POST] Post rate limit exceeded, retrying after 30 seconds
```

**Cause:** Bluesky rate limits (normal during initial catch-up or high-volume feeds)

**Fix:** Enable adaptive spacing to prevent hitting limits:
```json
{
  "adaptiveSpacing": true,
  "spacingWindow": 600,
  "minSpacing": 30,
  "maxSpacing": 120
}
```

**How it works:** If queue has 10 items, spreads them over 10 minutes (600/10 = 60 seconds apart).

#### Scenario 4: Config File Not Loaded

**Logs show:**
```
[bsky.rss CONFIG] Config file not found
Error: Config not initialized
```

**Cause:** Missing or incorrectly mounted `config.json`

**Fix by platform:**

**Docker:**
```yml
volumes:
  - ./data:/build/data  # Ensure config.json is in ./data/
```

**Railway/Render:**
1. Create volume mounted at `/build/data`
2. Upload `config.json` to volume
3. Redeploy

**Fly.io:**
```bash
# SSH into the VM
fly ssh console
# Check if config exists
cat /build/data/config.json
```

---

## RSS Feed Problems

### ❌ "Failed to fetch feed" Error

**Logs show:**
```
[bsky.rss RSS] Error fetching feed: getaddrinfo ENOTFOUND example.com
[bsky.rss RSS] Failed to parse feed: Invalid XML
```

#### 1. Invalid Feed URL

**Test the feed:**
```bash
curl -I https://your-feed-url.xml
```

**Check for:**
- ✅ Returns `200 OK`
- ✅ `Content-Type: application/rss+xml` or `application/xml`
- ❌ Returns `404` → Feed URL is wrong
- ❌ Returns `403` → Feed blocks scrapers (see User Agent fix below)

#### 2. Feed Requires User Agent

**Some feeds block default user agents.**

**Fix:** Add custom user agent to config:
```json
{
  "ogUserAgent": "Mozilla/5.0 (compatible; MyBot/1.0; +https://mysite.com)"
}
```

#### 3. Feed Uses Authentication

**Some feeds require authentication (common with private/paywalled feeds).**

**Not currently supported.** Workaround:
- Use a public version of the feed
- Self-host a feed proxy that handles auth

#### 4. Malformed XML

**Logs show:**
```
[bsky.rss RSS] Failed to parse feed: XML parse error at line 45
```

**Cause:** Feed has invalid XML (unclosed tags, encoding issues)

**Test feed validity:**
- Visit https://validator.w3.org/feed/
- Paste your feed URL
- Fix any errors at the source

**Workaround:** If you can't fix the feed, use an RSS proxy like [FetchRSS](https://fetchrss.com) to clean it.

### ❌ "No items in feed" But Feed Has Content

**Cause:** Bot can't parse the feed's date format or namespace.

**Check logs:**
```
[bsky.rss RSS] Fetched 0 items from feed
```

**Fix:** Specify date field explicitly:
```json
{
  "dateField": "pubDate"
}
```

**Common date field names:**
- `pubDate` (RSS 2.0)
- `published` (Atom)
- `dc:date` (Dublin Core)
- `date`

---

## Image Upload Failures

### ❌ Images Not Appearing in Posts

**Symptoms:** Posts appear but without images, or logs show image errors.

#### Scenario 1: Using Card Embed Instead of Image

**Config shows:**
```json
{
  "embedType": "card"
}
```

**Cause:** Card embeds show link previews, not uploaded images.

**Fix:** Use image embed to upload images:
```json
{
  "embedType": "image",
  "imageField": "enclosure",
  "imageAlt": "$title"
}
```

#### Scenario 2: Image Too Large

**Logs show:**
```
[bsky.rss IMAGE] Image exceeds size limit (10MB max)
[bsky.rss IMAGE] Image processing failed: File too large
```

**Cause:** Bluesky limits image uploads to ~1MB per image.

**Fix:** Images are automatically resized by default. If still failing:
1. Use smaller source images
2. Fleet mode limits: `"maxImageDownloadBytes": 10000000` (10MB download limit)

#### Scenario 3: Invalid Image URL

**Logs show:**
```
[bsky.rss IMAGE] Failed to download image: 404 Not Found
[bsky.rss IMAGE] Image URL is not accessible
```

**Cause:** The `imageField` points to a broken URL.

**Fix:** Check which field contains the image:
```bash
curl -s https://your-feed-url.xml | grep -i "image\|media\|enclosure"
```

**Common image fields:**
- `media:content` → `imageField: "media:content"`
- `enclosure` → `imageField: "enclosure"`

Only `"media:content"` and `"enclosure"` are recognized. `<enclosure>` entries whose
`type` is not `image/*` (podcast audio, video) are skipped. For JSON Feed, any non-empty
value opts in to the item's native `image` field.

#### Scenario 4: Image Format Not Supported

**Cause:** Bluesky supports JPEG, PNG, GIF, WEBP.

**Unsupported:** SVG, TIFF, BMP

**Fix:** Bot automatically converts supported formats. For unsupported formats, the feed source needs to provide standard image formats.

---

## Duplicate Posts

### ❌ Bot Posts Same Item Multiple Times

**Symptoms:** Same article posted 2+ times.

#### Cause 1: `removeDuplicate` Disabled

**Config shows:**
```json
{
  "removeDuplicate": false
}
```

**How default dedup works:**
- Tracks last post **date only**
- If feed items have same/no date → duplicates possible

**Fix:** Enable text-based deduplication:
```json
{
  "removeDuplicate": true
}
```

**How it works:** Stores post URLs/titles in `/build/data/db.txt`, keeps 96-hour history.

#### Cause 2: Data Volume Lost

**If `/build/data` volume is not persistent:**
- Every restart = fresh state
- Bot forgets what it posted

**Fix by platform:**

**Docker:** Ensure volume is mounted:
```yml
volumes:
  - ./data:/build/data  # Persistent across restarts
```

**Railway/Render:** Volumes must be explicitly created.

**Fly.io:** Volume must exist:
```bash
fly volumes list  # Check volume exists
```

#### Cause 3: Multiple Instances Running

**Cause:** Accidentally running 2+ instances of the same bot.

**Check:**
- Docker: `docker ps | grep bsky-rss`
- Railway/Render: Check you don't have multiple deployments
- Fly.io: `fly scale show` (should be 1 machine)

**Fix:** Stop duplicate instances.

---

## Rate Limiting

### ⚠️ "Post rate limit exceeded" (Normal During Catch-Up)

**Logs show:**
```
[bsky.rss POST] Post rate limit exceeded, retrying after 30 seconds
[bsky.rss POST] Rate limited, 5 items still in queue
```

**Cause:** Bluesky enforces rate limits (~1 post per 30-60 seconds varies by account age/reputation).

**Expected scenarios:**
- Initial deployment (catching up on feed history)
- Feed publishes many items at once
- Bot was offline and catching up

**Solutions:**

#### 1. Enable Adaptive Spacing (Recommended)

**Prevents hitting limits:**
```json
{
  "adaptiveSpacing": true,
  "spacingWindow": 600,
  "minSpacing": 30,
  "maxSpacing": 120
}
```

**Example:** 10 items in queue → posts every 60 seconds (600/10) instead of immediately.

#### 2. Reduce Catch-Up Volume (Fleet Mode)

**Fleet mode config:**
```json
{
  "freshness": {
    "maxCatchupItems": 5,
    "maxItemAgeMinutes": 120
  }
}
```

**On startup:** Only posts up to 5 items that are less than 2 hours old.

#### 3. Just Wait (Single-Bot Mode)

**Bot automatically retries after backoff period.** Queue persists across restarts.

**Check queue status:**
- Logs show: `5 items still in queue`
- Bot will work through them gradually

---

## Configuration Errors

### ❌ "Config not valid JSON" Error

**Logs show:**
```
Error: Unexpected token } in JSON at position 123
Config file is not valid JSON
```

**Cause:** Syntax error in `config.json`.

**Fix:** Validate JSON:
1. Copy your `config.json` content
2. Paste into [JSONLint](https://jsonlint.com)
3. Fix errors highlighted
4. Re-upload config

**Common mistakes:**
- Trailing comma: `"key": "value",}` ❌
- Missing comma: `"key1": "value1" "key2": "value2"` ❌
- Unquoted strings: `{key: value}` ❌

### ❌ Post Text Missing Variables

**Posts appear as:** `"$title - $link"` (literally)

**Cause:** Variables not being replaced.

**Check:**
1. Verify RSS feed has these fields (view feed XML in browser)
2. Use correct variable names:
   - ✅ `$title`, `$link`, `$description`
   - ❌ `$Title`, `${title}`, `{{title}}`

**Debug:** Check logs for the actual feed data:
```
[bsky.rss RSS] Item: {"title": "...", "link": "...", ...}
```

---

## Deployment Issues

### ❌ Container Keeps Restarting

**Docker logs show:**
```
[bsky.rss] Container exited with code 1
[bsky.rss] Restarting container...
```

**Check logs for root cause:**
```bash
docker logs bsky-rss --tail 50
```

**Common causes:**

#### 1. Missing Environment Variables

**Error:** `IDENTIFIER is required`

**Fix:** Set all required env vars:
```bash
IDENTIFIER=user.bsky.social
APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
FETCH_URL=https://feed.xml
INSTANCE_URL=https://bsky.social
```

#### 2. Volume Permission Issues

**Error:** `EACCES: permission denied, open '/build/data/config.json'`

**Fix (Docker):**
```bash
# Fix permissions on host
chmod -R 777 ./data
```

**Fix (SELinux):**
```bash
# Add :z flag to volume mount
volumes:
  - ./data:/build/data:z
```

#### 3. Out of Memory

**Error:** `JavaScript heap out of memory`

**Fix:**

**Docker:**
```yml
services:
  bsky-rss:
    deploy:
      resources:
        limits:
          memory: 512M  # Increase from 256M
```

**Railway/Render:** Upgrade plan for more RAM.

**Fly.io:**
```toml
[[vm]]
  memory = '512mb'  # Increase from 256mb
```

### ❌ Health Check Timeout

**Platform shows:** "Deployment failed: Health check timeout"

**Cause:** Health endpoint not responding on expected port.

**Fix:**

#### 1. Verify Port Configuration

**Environment variable:**
```bash
HEALTH_CHECK_PORT=8080  # Default
```

**Fly.io `fly.toml`:**
```toml
[env]
  HEALTH_CHECK_PORT = "8080"

[[services]]
  internal_port = 8080  # Must match
```

#### 2. Increase Grace Period

**Fly.io:**
```toml
[[services.http_checks]]
  grace_period = "30s"  # Give more time for startup
```

**Railway/Render:** Adjust health check settings in dashboard.

---

## Health Check Failures

### ❌ `/health` Returns 503 (Unhealthy)

**Response:**
```json
{
  "status": "unhealthy",
  "ready": true,
  "timeSinceActivity": "720s"
}
```

**Cause:** Bot hasn't run successfully in 10+ minutes (600 seconds).

**Check logs for errors:**
- Authentication failures
- RSS fetch failures
- Config errors

**Fix root cause,** then health will automatically recover.

### ❌ `/health` Returns 503 (Not Ready)

**Response:**
```json
{
  "status": "unhealthy",
  "ready": false
}
```

**Cause:** Bot is starting up but hasn't completed initialization.

**Solutions:**
- **Wait 30-60 seconds** - normal startup time
- If persists, check logs for initialization errors

---

## Performance Issues

### ⚠️ Bot Running Slow / High Memory Usage

**Symptoms:** Logs show delays, platform reports high RAM usage.

#### 1. Too Many Concurrent Image Downloads (Fleet Mode)

**Fleet config:**
```json
{
  "sharedLimiters": {
    "maxConcurrentImageJobs": 10  // Too high
  }
}
```

**Fix:** Reduce concurrency:
```json
{
  "sharedLimiters": {
    "maxConcurrentImageJobs": 2,
    "maxConcurrentOpenGraphFetches": 6
  }
}
```

#### 2. Large RSS Feeds (1000+ items)

**Symptom:** Slow feed parsing, high memory.

**Fix:** Feed bodies are fetched whole (capped at 20MB) and parsed in memory by
`feedsmith`. Not a current issue at real feed sizes, but if problems occur:
1. Use a feed that only shows recent items
2. Reduce `maxCatchupItems` in fleet mode

#### 3. Excessive Logging in Production

**If running with debug logs:**
```bash
NODE_ENV=development  # ❌ Don't use in production
```

**Fix:**
```bash
NODE_ENV=production  # ✅ Reduces log volume
```

---

## Getting Help

### Before Opening an Issue

1. **Check this guide** for your specific error
2. **Check logs** for the exact error message
3. **Test your feed** in a feed validator
4. **Verify environment variables** are set correctly

### When Opening an Issue

Include:

1. **Platform:** Fly.io, Railway, Docker, etc.
2. **Version:** Check `/health` endpoint for version number
3. **Config:** Sanitized `config.json` (remove sensitive data)
4. **Logs:** Last 50 lines showing the error
5. **Feed URL:** (If public and relevant to issue)

**Use issue templates:** [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md)

---

## Quick Fixes Summary

| Symptom | Quick Fix |
|---------|-----------|
| Invalid credentials | Regenerate app password, check identifier format |
| No posts appearing | Check logs, verify feed URL, check `runInterval` |
| Duplicate posts | Enable `removeDuplicate: true` |
| Rate limited | Enable `adaptiveSpacing: true` |
| Config not loading | Check volume mount, verify `config.json` exists |
| Images not showing | Change `embedType` to `"image"`, set `imageField` |
| Container restarting | Check logs for errors, verify env vars, check permissions |
| Health check 503 | Check logs for underlying errors, wait for activity |

---

**Still stuck?** Open an issue: https://github.com/rmdes/bsky.rss/issues
