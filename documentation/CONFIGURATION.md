# Configuration Reference

Complete reference for all `config.json` options in bsky.rss. Each option includes explanation, use cases, examples, and common pitfalls.

---

## Table of Contents

- [Configuration File Location](#configuration-file-location)
- [Complete Example](#complete-example)
- [Post Content Options](#post-content-options)
- [Embed Options](#embed-options)
- [Feed Processing Options](#feed-processing-options)
- [Timing & Spacing Options](#timing--spacing-options)
- [Duplicate Detection Options](#duplicate-detection-options)
- [Content Processing Options](#content-processing-options)
- [Advanced Options](#advanced-options)
- [Common Configurations](#common-configurations)

---

## Configuration File Location

**Single-bot mode:**
- Path: `/build/data/config.json` (inside container)
- Docker: Mount your local `./data/config.json` to `/build/data/config.json`
- Manual: `data/config.json` in project root

**Fleet mode:**
- Per-bot configs: `config.example/bots/{bot-id}/posting.json`
- See [Fleet Mode Documentation](fleet.md) for details

**Validation:**
- Must be valid JSON (use [JSONLint](https://jsonlint.com))
- Bot validates on startup, logs errors if invalid
- Changes require restart to take effect

---

## Complete Example

```json
{
  "string": "$title - $link",
  "publishEmbed": true,
  "embedType": "card",
  "languages": ["en"],
  "ogUserAgent": "bsky.rss/2.0 (Bot; +https://github.com/rmdes/bsky.rss)",
  "truncate": true,
  "runInterval": 60,
  "dateField": "",
  "publishDate": false,
  "imageField": "",
  "imageAlt": "$title",
  "forceDescriptionEmbed": false,
  "removeDuplicate": true,
  "descriptionClearHTML": true,
  "titleClearHTML": false,
  "adaptiveSpacing": true,
  "spacingWindow": 600,
  "minSpacing": 30,
  "maxSpacing": 120
}
```

---

## Post Content Options

### `string`

**Type:** `string`  
**Required:** Yes  
**Default:** No default (must specify)

**What it does:** Template for post text. Variables are replaced with RSS feed data.

**Available variables:**
- `$title` - Item title
- `$link` - Item URL
- `$description` - Item description/summary
- `$georss` - An OpenStreetMap link built from the item's geographic coordinates, if the feed provides any. Checks `<georss:point>` (GeoRSS Simple) first, falling back to `geo:lat`/`geo:long` (W3C Basic Geo) when a feed carries coordinates only that way. Renders as an empty string when the item has neither. GeoRSS-GML encoding (`<georss:where><gml:Point>...`) is not supported.

**Examples:**

**Simple (title + link):**
```json
{"string": "$title - $link"}
```
→ `"How to Deploy Apps - https://example.com/article"`

**Multi-line with description:**
```json
{"string": "$title\n\n$description\n\n🔗 $link"}
```
→
```
How to Deploy Apps

This guide shows you how to deploy apps to production...

🔗 https://example.com/article
```

**Title only (use with embed for link):**
```json
{"string": "$title"}
```
→ `"How to Deploy Apps"` (link shown in card embed)

**Custom formatting:**
```json
{"string": "📰 New: $title\n\nRead more: $link"}
```

**Use cases:**
- News feeds: Include description for context
- Blogs: Title + link is often enough
- Announcements: Custom prefix/emoji for branding

**Common pitfalls:**
- Don't use `${title}` or `{{title}}` - only `$title` works
- Variables are case-sensitive: `$Title` won't work
- Missing variables show as empty: `$link` → ` ` if feed has no link

**Character limit:**
- Bluesky posts: 300 characters
- If `truncate: true`, automatically cuts at 300 chars
- Plan your template to fit within limit

---

## Embed Options

### `publishEmbed`

**Type:** `boolean`  
**Default:** `true`

**What it does:** Whether to attach media (link card or image) to the post.

```json
{"publishEmbed": true}   // Attach media
{"publishEmbed": false}  // Text-only post
```

**When to disable:**
- Text-only posts (no preview)
- Feed already includes full content in `$description`
- Want minimal posts

**Note:** If disabled, `embedType` and `imageField` are ignored.

---

### `embedType`

**Type:** `"card"` | `"image"`  
**Default:** `"card"`  
**Requires:** `publishEmbed: true`

**What it does:** Type of media to attach to post.

**Option: `"card"`** (Link preview card)
```json
{
  "publishEmbed": true,
  "embedType": "card"
}
```

**How it works:**
- Fetches Open Graph metadata from `$link`
- Shows title, description, preview image
- Like Twitter/X link previews

**Fetched data:**
- `og:title` - Card title
- `og:description` - Card description  
- `og:image` - Card preview image
- `og:url` - Link destination

**Use cases:**
- News articles (rich previews)
- Blog posts (show excerpt)
- External links (let OG handle preview)

**Pros:**
- Automatic (no image URL needed in feed)
- Rich previews with description
- No upload required

**Cons:**
- Depends on target site having Open Graph tags
- Can't control preview image
- Requires network fetch per post

---

**Option: `"image"`** (Upload image from feed)
```json
{
  "publishEmbed": true,
  "embedType": "image",
  "imageField": "enclosure",
  "imageAlt": "$title"
}
```

**How it works:**
- Reads image URL from RSS feed field
- Downloads and uploads to Bluesky
- Attaches to post as image

**Requires:**
- `imageField` must point to valid image URL in feed
- Feed must include image data

**Use cases:**
- Photo blogs (featured images)
- Media feeds (podcast cover art)
- Custom images (you control what shows)

**Pros:**
- You control exact image
- Works even if link has no Open Graph
- Can use custom alt text

**Cons:**
- Requires image in feed
- Upload time per post
- Size limits (1MB after compression)

**Supported formats:** JPEG, PNG, GIF, WEBP

---

### `imageField`

**Type:** `string`  
**Default:** `""` (empty)  
**Requires:** `embedType: "image"`

**What it does:** Names which feed element the item's image URL comes from. Only two
values are recognized: `"media:content"` and `"enclosure"`.

**Media RSS:**
```json
{"imageField": "media:content"}
```
Feed structure (also matched inside a `<media:group>`):
```xml
<item>
  <media:content url="https://example.com/image.jpg" type="image/jpeg" />
</item>
```

**Enclosure (podcasts, media):**
```json
{"imageField": "enclosure"}
```
Feed structure:
```xml
<item>
  <enclosure url="https://example.com/image.jpg" type="image/jpeg" />
</item>
```

**JSON Feed:** JSON Feed has no `media:content`/`enclosure` distinction. Setting
`imageField` to any non-empty value opts in to the item's native `image` field; leaving
it empty means no field-driven image.

**Finding the right value:**
1. View the feed in a browser
2. Find the element carrying the image URL
3. Set `imageField` to `"media:content"` or `"enclosure"` accordingly

**Fallback behavior:**
- If `imageField` is empty or unrecognized → no field-driven image; Open Graph is used
- If the element's `type` is not `image/*` (e.g. a podcast `audio/mpeg` enclosure) →
  skipped, and the next matching element is tried
- If field not found → no image uploaded
- If URL is invalid → logs error, no image
- If image too large → auto-resized (max 1MB)

---

### `imageAlt`

**Type:** `string`  
**Default:** `"$title"`  
**Requires:** `embedType: "image"`

**What it does:** Alt text for uploaded images (accessibility).

**Supports variables:**
```json
{"imageAlt": "$title"}  // Use article title as alt text
```

**Best practices:**
- Describe image content for screen readers
- Keep concise (< 100 chars recommended)
- Don't just duplicate title if image adds different info

**Examples:**
```json
{"imageAlt": "$title"}                          // "How to Deploy Apps"
{"imageAlt": "Featured image for $title"}       // "Featured image for How to Deploy Apps"
{"imageAlt": "Podcast cover art"}               // Static alt text
```

---

### `mappedValues`

**Type:** `Array<{key: string; value: string}>`
**Default:** `[]` (empty)

**What it does:** Maps specific Dublin Core or iTunes/Podcast feed fields into new `$key`
template placeholders, usable in `string` and `imageAlt` alongside `$title`/`$link`/`$description`/
`$georss`.

**Recognized `value` strings:**
- `dc:creator` - item author/byline (joined with `, ` if a feed lists more than one)
- `dc:date` - item's Dublin Core date (first value if repeated)
- `dc:subject` - item's Dublin Core subject (joined with `, ` if more than one)
- `dc:publisher` - item's Dublin Core publisher (joined with `, ` if more than one)
- `itunes:duration` - podcast episode duration in seconds
- `itunes:episode` - podcast episode number
- `itunes:season` - podcast season number
- `itunes:explicit` - `"true"` or `"false"`
- `itunes:author` - podcast episode/show author

**Example:**
```json
{
  "string": "$title by $author",
  "mappedValues": [{"key": "author", "value": "dc:creator"}]
}
```

**Fallback behavior:**
- An unrecognized `value` resolves that `$key` to an empty string - never an error
- A `value` whose field is absent on a given item resolves to an empty string for that item
- `mappedValues` only resolves for RSS/Atom/RDF feeds - JSON Feed has no namespace concept, so
  every `$key` resolves to empty string there

---

### `forceDescriptionEmbed`

**Type:** `boolean`  
**Default:** `false`  
**Requires:** `embedType: "card"`

**What it does:** Use RSS `$description` for card description instead of Open Graph `og:description`.

```json
{
  "embedType": "card",
  "forceDescriptionEmbed": true
}
```

**Without (default):**
- Fetches `og:description` from link
- Uses website's Open Graph tags

**With:**
- Uses `$description` from RSS feed
- Ignores Open Graph description

**When to use:**
- Feed has better descriptions than Open Graph
- Target site has poor/missing `og:description`
- Want consistent description source

**Example:**
RSS feed:
```xml
<description>This comprehensive guide covers deployment strategies...</description>
```

Open Graph:
```html
<meta property="og:description" content="Learn about deployment" />
```

With `forceDescriptionEmbed: true` → uses RSS description (more detailed)

---

## Feed Processing Options

### `languages`

**Type:** `string[]` (array of ISO 639-1 codes)  
**Default:** `["en"]`

**What it does:** Sets language tags on Bluesky posts.

**Examples:**
```json
{"languages": ["en"]}           // English
{"languages": ["fr"]}           // French
{"languages": ["en", "fr"]}     // Bilingual
{"languages": ["es", "ca"]}     // Spanish + Catalan
```

**ISO 639-1 codes:** [Full list](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes)

**Common codes:**
- `en` - English
- `es` - Spanish
- `fr` - French
- `de` - German
- `pt` - Portuguese
- `ja` - Japanese
- `zh` - Chinese
- `ar` - Arabic

**Use cases:**
- Helps Bluesky users filter by language
- Improves discoverability in language-specific feeds
- Supports multilingual feeds

**Multi-language feeds:**
```json
{"languages": ["en", "es"]}  // If feed has both languages
```

---

### `dateField`

**Type:** `string`  
**Default:** `""` (auto-detect)

**What it does:** Specifies which RSS field contains the item publication date.

**When empty (default):**
- Bot tries: `pubDate`, `published`, `date` (in that order)
- Works for most feeds

**When to specify:**

**Feed uses non-standard date field:**
```json
{"dateField": "dc:date"}  // Dublin Core date
```

**Feed uses custom field:**
```json
{"dateField": "customPublishDate"}
```

**Common date fields:**
- `pubDate` - RSS 2.0 standard
- `published` - Atom standard
- `date` - Generic
- `dc:date` - Dublin Core
- `updated` - Last modified date

**Finding the field:**
View feed XML, find date element:
```xml
<item>
  <pubDate>Mon, 06 Aug 2026 12:00:00 GMT</pubDate>
</item>
```
→ `"dateField": "pubDate"`

**Use cases:**
- Feed uses non-standard date field
- Bot can't detect dates automatically (posts all items repeatedly)
- Want to use specific date (e.g., `updated` vs `published`)

---

### `publishDate`

**Type:** `boolean`  
**Default:** `false`

**What it does:** Use RSS item's date for Bluesky post's `createdAt` timestamp.

```json
{"publishDate": false}  // Post timestamp = now (when bot posts)
{"publishDate": true}   // Post timestamp = RSS item date
```

**When `false` (default):**
- Post shows current time on Bluesky
- Natural for real-time posting

**When `true`:**
- Post shows original article publish date
- Can backdate posts

**Use cases for `true`:**
- Archiving old content (preserve original dates)
- Migrating from another platform
- Want post dates to match article dates

**Limitations:**
- Bluesky may have restrictions on backdating
- Can confuse followers if old dates appear in feed
- Timeline ordering affected

**Recommendation:** Leave `false` unless specifically archiving.

---

## Timing & Spacing Options

### `runInterval`

**Type:** `number` (seconds)  
**Default:** `60`

**What it does:** How often the bot checks RSS feed for new items.

```json
{"runInterval": 60}     // Check every minute
{"runInterval": 300}    // Check every 5 minutes
{"runInterval": 3600}   // Check every hour
```

**Recommendations:**

| Feed Type | Interval | Reason |
|-----------|----------|--------|
| News/high-traffic | 60 | Posts frequently, check often |
| Blogs | 300-600 | Posts 1-2x/day, don't need constant checking |
| Weekly newsletters | 3600 | Posts rarely, hourly check enough |
| Podcasts | 3600-7200 | Episodes infrequent |

**Does NOT control posting frequency** - only feed check frequency.

**Trade-offs:**
- Lower interval = faster detection, more CPU/network
- Higher interval = slower detection, less resource use

**Platform considerations:**
- Most platforms charge by compute time
- Very low intervals (< 30s) waste resources if feed doesn't update often

---

### `adaptiveSpacing`

**Type:** `boolean`  
**Default:** `false`

**What it does:** Automatically space posts over time instead of posting all at once.

```json
{
  "adaptiveSpacing": true,
  "spacingWindow": 600,
  "minSpacing": 30,
  "maxSpacing": 120
}
```

**Without adaptive spacing:**
- Feed publishes 10 articles
- Bot tries to post all 10 immediately
- Likely hits rate limits
- Queue drains as fast as Bluesky allows

**With adaptive spacing:**
- Queue = 10 items
- Spacing window = 600 seconds
- Posts every `600 / 10 = 60 seconds`
- Spreads posts over 10 minutes
- Avoids rate limits

**When to enable:**
- High-volume feeds (news sites)
- Feeds that batch-publish multiple items
- Initial deployment (catch-up phase)
- Want to avoid rate limits

**When to disable:**
- Low-frequency feeds (1 post per day)
- Feeds that publish one item at a time
- Want immediate posting

---

### `spacingWindow`

**Type:** `number` (seconds)  
**Default:** `600`  
**Requires:** `adaptiveSpacing: true`

**What it does:** Time window over which to spread posts.

**Formula:** `delay = spacingWindow / queueSize`

**Examples:**

**spacingWindow = 600** (10 minutes):
- 10 items → 60 seconds between posts
- 5 items → 120 seconds (but capped by maxSpacing)
- 20 items → 30 seconds

**spacingWindow = 1800** (30 minutes):
- 10 items → 180 seconds (3 minutes)
- 30 items → 60 seconds

**Choosing a value:**
- Higher value = more spread out posts
- Lower value = faster posting
- Typical: 600-1800 (10-30 minutes)

**Use cases:**
- News feeds: 600 (process quickly but avoid spam)
- High-volume: 1800 (spread over 30 minutes)
- Moderate: 900 (15 minutes)

---

### `minSpacing`

**Type:** `number` (seconds)  
**Default:** `1`  
**Requires:** `adaptiveSpacing: true`

**What it does:** Minimum time between posts (floor).

```json
{"minSpacing": 30}  // Never post faster than every 30 seconds
```

**Why it matters:**
- Prevents hitting rate limits even with small queue
- Bluesky allows ~1 post per 30-60 seconds (varies by account)

**Example:**
- Queue = 1 item
- `spacingWindow = 600`
- Without minSpacing: `600 / 1 = 600 seconds` delay (too slow)
- With `minSpacing: 30`: Uses 30 seconds (faster)

**Recommendation:** Set to `30` (conservative, avoids rate limits)

---

### `maxSpacing`

**Type:** `number` (seconds)  
**Default:** `60`  
**Requires:** `adaptiveSpacing: true`

**What it does:** Maximum time between posts (ceiling).

```json
{"maxSpacing": 120}  // Never wait longer than 2 minutes
```

**Why it matters:**
- Large queue could calculate huge delays
- Keeps posts flowing at reasonable pace

**Example:**
- Queue = 1 item
- `spacingWindow = 600`
- Calculated delay: `600 / 1 = 600 seconds`
- With `maxSpacing: 120`: Uses 120 seconds instead (faster)

**Recommendation:** Set to `60-120` for responsive posting

---

## Duplicate Detection Options

### `removeDuplicate`

**Type:** `boolean`  
**Default:** `false`

**What it does:** Use text-based duplicate detection instead of date-based.

**Date-based (false - default):**
```json
{"removeDuplicate": false}
```
- Tracks last post date in `/build/data/last.txt`
- Only posts items newer than last date
- Fast, simple
- **Limitation:** Items with same timestamp can duplicate

**Text-based (true):**
```json
{"removeDuplicate": true}
```
- Stores post URLs/titles in `/build/data/db.txt`
- Checks each item against database
- Keeps 96-hour history (auto-cleanup)
- **Better:** Catches true duplicates even with same dates

**When to enable:**
- Seeing duplicate posts
- Feed items have identical timestamps
- Feed occasionally re-publishes items
- Want stronger duplicate protection

**When to keep disabled:**
- Low-frequency feed (duplicates unlikely)
- Date-based works fine
- Want faster processing (skip database check)

**Database file:** `/build/data/db.txt`
- Format: `ISO-date|URL\n`
- Auto-cleans entries > 96 hours old
- Persists across restarts (if volume mounted)

---

## Content Processing Options

### `truncate`

**Type:** `boolean`  
**Default:** `true`

**What it does:** Automatically cut post text at 300 characters (Bluesky limit).

```json
{"truncate": true}   // Auto-cut at 300 chars
{"truncate": false}  // Fail if > 300 chars
```

**With truncate:**
- Long text → cut to 300 chars + "..."
- Post succeeds

**Without truncate:**
- Long text → bot logs error, post skipped
- Useful for debugging template issues

**Recommendation:** Keep `true` unless debugging.

**Character counting:**
- Counts UTF-8 characters (not bytes)
- Emoji count as 1-2 characters
- Links count as their full length

---

### `descriptionClearHTML`

**Type:** `boolean`  
**Default:** `false`

**What it does:** Strip HTML tags from `$description`.

**Without (false):**
```
$description = "<p>This is <strong>great</strong> content</p>"
```

**With (true):**
```
$description = "This is great content"
```

**When to enable:**
- Feed descriptions include HTML
- Want clean text-only descriptions
- Using `$description` in post text

**When to disable:**
- Feed already provides clean text
- Want to preserve some formatting

**What it removes:**
- All HTML tags: `<p>`, `<strong>`, `<a>`, etc.
- HTML entities decoded: `&amp;` → `&`, `&quot;` → `"`

**Use with:**
```json
{
  "string": "$title\n\n$description",
  "descriptionClearHTML": true
}
```

---

### `titleClearHTML`

**Type:** `boolean`  
**Default:** `false`

**What it does:** Strip HTML tags from `$title`.

**Same behavior as `descriptionClearHTML` but for titles.**

**When to enable:**
- Feed titles include HTML
- Seeing tags in post titles

**Example:**
RSS title: `<![CDATA[How to <em>Deploy</em> Apps]]`

With `titleClearHTML: true` → `"How to Deploy Apps"`

---

### `ogUserAgent`

**Type:** `string`  
**Default:** `"bsky.rss/{version} (Open Graph Scraper)"`

**What it does:** User agent sent when fetching Open Graph data.

**Why it matters:**
- Some sites block default user agents
- Some require specific user agents
- Identifies bot to website owners

**Examples:**

**Default:**
```json
{"ogUserAgent": ""}  // Uses bsky.rss default
```

**Custom:**
```json
{"ogUserAgent": "Mozilla/5.0 (compatible; MyBot/1.0; +https://mysite.com)"}
```

**Bypass bot detection:**
```json
{"ogUserAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
```

**When to customize:**
- Getting 403 errors fetching Open Graph
- Site requires specific user agent
- Want to identify your bot

**Best practice:** Include contact URL so site owners can reach you.

---

## Advanced Options

### Environment Variables

Some options are set via environment variables instead of `config.json`:

**Required:**
```bash
IDENTIFIER=username.bsky.social  # or email
APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
FETCH_URL=https://feed.xml
INSTANCE_URL=https://bsky.social
```

**Optional:**
```bash
HEALTH_CHECK_PORT=8080          # Health endpoint port
NODE_ENV=production             # Environment mode
```

---

## Common Configurations

### News Feed (High Volume)

```json
{
  "string": "$title - $link",
  "publishEmbed": true,
  "embedType": "card",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 60,
  "removeDuplicate": true,
  "descriptionClearHTML": true,
  "adaptiveSpacing": true,
  "spacingWindow": 600,
  "minSpacing": 30,
  "maxSpacing": 120
}
```

**Why:**
- `runInterval: 60` - Check frequently
- `adaptiveSpacing: true` - Spread posts to avoid spam
- `removeDuplicate: true` - News sites sometimes re-publish

---

### Personal Blog (Low Volume)

```json
{
  "string": "$title\n\n$description\n\n🔗 $link",
  "publishEmbed": true,
  "embedType": "image",
  "imageField": "enclosure",
  "imageAlt": "$title",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 300,
  "descriptionClearHTML": true,
  "removeDuplicate": false,
  "adaptiveSpacing": false
}
```

**Why:**
- Includes description (more context)
- Uses featured images
- Checks every 5 min (blogs post infrequently)
- No adaptive spacing (1 post at a time usually)

---

### Podcast Feed

```json
{
  "string": "🎙️ New episode: $title\n\nListen: $link",
  "publishEmbed": true,
  "embedType": "image",
  "imageField": "media:content",
  "imageAlt": "Podcast cover art",
  "languages": ["en"],
  "runInterval": 3600,
  "removeDuplicate": true,
  "adaptiveSpacing": false
}
```

**Why:**
- Custom emoji branding
- Episode art as image
- Hourly check (episodes are infrequent)
- Duplicate detection (podcast feeds sometimes republish)

---

### Minimal (Text Only, No Embeds)

```json
{
  "string": "$title - $link",
  "publishEmbed": false,
  "languages": ["en"],
  "truncate": true,
  "runInterval": 60,
  "removeDuplicate": true,
  "adaptiveSpacing": false
}
```

**Why:**
- No media (faster, simpler)
- Good for announcement-style feeds
- Low resource usage

---

## Validation & Debugging

### Testing Your Config

**1. Validate JSON:**
- Copy config to [JSONLint](https://jsonlint.com)
- Fix syntax errors

**2. Check logs on startup:**
```
[bsky.rss CONFIG] Config loaded successfully
```

**3. Test with one item:**
- Set `runInterval: 60`
- Wait for next feed check
- Verify post appears on Bluesky

**4. Monitor health endpoint:**
```bash
curl https://your-app.com/health
```

### Common Mistakes

**Trailing commas:**
```json
{
  "string": "$title",  // ❌ Trailing comma before }
}
```

**Unquoted values:**
```json
{
  "runInterval": "60"  // ✅ Numbers can be quoted or not
}
```

**Wrong variable syntax:**
```json
{"string": "${title}"}  // ❌ Wrong
{"string": "$title"}    // ✅ Correct
```

---

## Getting Help

- **Quick Start:** [QUICKSTART.md](QUICKSTART.md)
- **Troubleshooting:** [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- **FAQ:** [FAQ.md](FAQ.md)
- **Issues:** [GitHub Issues](https://github.com/rmdes/bsky.rss/issues)
