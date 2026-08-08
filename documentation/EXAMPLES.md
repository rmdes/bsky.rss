# Configuration Examples

Real-world configuration examples for common use cases. Copy, customize, and deploy.

---

## Table of Contents

- [News & Media](#news--media)
- [Blogs & Personal Sites](#blogs--personal-sites)
- [Podcasts & Audio](#podcasts--audio)
- [Social Media Bridges](#social-media-bridges)
- [Organization Announcements](#organization-announcements)
- [Multi-Language Content](#multi-language-content)
- [Custom Use Cases](#custom-use-cases)

---

## News & Media

### High-Volume News Feed

**Use case:** Major news site publishing 20-50 articles/day

**Challenge:** Posts arrive in batches, risk hitting rate limits

**Solution:**
```json
{
  "string": "📰 $title - $link",
  "publishEmbed": true,
  "embedType": "card",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 60,
  "descriptionClearHTML": true,
  "removeDuplicate": true,
  "adaptiveSpacing": true,
  "spacingWindow": 900,
  "minSpacing": 45,
  "maxSpacing": 180
}
```

**Why:**
- `runInterval: 60` - Check every minute for breaking news
- `adaptiveSpacing: true` - Spread posts over 15 minutes (900s)
- `minSpacing: 45` - Never faster than 45s (safe rate limit)
- `maxSpacing: 180` - Keep flowing (max 3 min between posts)
- `removeDuplicate: true` - News sites sometimes update/republish

**Expected behavior:**
- 15 articles arrive → posts every 60 seconds over 15 minutes
- 5 articles arrive → posts every 180 seconds (respects maxSpacing)

**Example feeds:**
- CNN: `http://rss.cnn.com/rss/cnn_latest.rss`
- BBC: `http://feeds.bbci.co.uk/news/rss.xml`
- Reuters: `https://www.reutersagency.com/feed/`

---

### Tech News Aggregator

**Use case:** Hacker News, Reddit /r/technology, tech blogs

**Features:** Include description for context, clean HTML

**Config:**
```json
{
  "string": "$title\n\n$description\n\n🔗 $link",
  "publishEmbed": true,
  "embedType": "card",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 180,
  "descriptionClearHTML": true,
  "titleClearHTML": true,
  "removeDuplicate": true,
  "adaptiveSpacing": true,
  "spacingWindow": 600,
  "minSpacing": 60,
  "maxSpacing": 120
}
```

**Why:**
- Includes `$description` for article summary
- `descriptionClearHTML: true` - Clean up HTML in descriptions
- `runInterval: 180` - Check every 3 min (moderate frequency)
- Adaptive spacing prevents bursts

**Example feeds:**
- Hacker News: `https://hnrss.org/frontpage`
- Reddit tech: `https://www.reddit.com/r/technology/.rss`

---

### Local News Bot

**Use case:** Local newspaper, community news

**Features:** Simple format, hourly check (low volume)

**Config:**
```json
{
  "string": "📍 Local news: $title\n\n$link",
  "publishEmbed": true,
  "embedType": "card",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 3600,
  "descriptionClearHTML": true,
  "removeDuplicate": false,
  "adaptiveSpacing": false
}
```

**Why:**
- `runInterval: 3600` - Hourly check (local news posts infrequently)
- No adaptive spacing (usually 1-2 posts at a time)
- Simple, clean format

---

## Blogs & Personal Sites

### Personal Blog (Image-First)

**Use case:** Blog with featured images for each post

**Features:** Upload featured image, include excerpt

**Config:**
```json
{
  "string": "$title\n\n$description",
  "publishEmbed": true,
  "embedType": "image",
  "imageField": "enclosure",
  "imageAlt": "$title",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 600,
  "descriptionClearHTML": true,
  "removeDuplicate": false,
  "adaptiveSpacing": false
}
```

**Why:**
- `embedType: "image"` - Uploads featured image
- `imageField: "enclosure"` - WordPress/common blog format
- `runInterval: 600` - Check every 10 min (blogs post infrequently)
- No link shown in text (image embed includes link)

**Works with:**
- WordPress blogs (with featured images)
- Ghost blogs
- Medium publications

**Alternative image fields:**
```json
{"imageField": "media:content"}  // Media RSS
{"imageField": "enclosure"}      // RSS enclosure
```

---

### Photography Blog

**Use case:** Photo blog where image is the focus

**Features:** Minimal text, image only

**Config:**
```json
{
  "string": "📷 $title",
  "publishEmbed": true,
  "embedType": "image",
  "imageField": "media:content",
  "imageAlt": "$title",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 1800,
  "removeDuplicate": true,
  "adaptiveSpacing": false
}
```

**Why:**
- Minimal text (image is the content)
- `runInterval: 1800` - Check every 30 min (photos post rarely)
- `removeDuplicate: true` - Prevent duplicate images

---

### Link Blog (Text Only)

**Use case:** Link-sharing blog, minimal style

**Features:** No embeds, just title + link

**Config:**
```json
{
  "string": "$title - $link",
  "publishEmbed": false,
  "languages": ["en"],
  "truncate": true,
  "runInterval": 300,
  "removeDuplicate": true,
  "adaptiveSpacing": false
}
```

**Why:**
- `publishEmbed: false` - Text only, no media
- Fast, simple
- Good for link aggregation

---

## Podcasts & Audio

### Podcast Episode Feed

**Use case:** Podcast RSS feed with episode announcements

**Features:** Episode art, custom formatting, listen links

**Config:**
```json
{
  "string": "🎙️ New episode: $title\n\nListen now: $link",
  "publishEmbed": true,
  "embedType": "image",
  "imageField": "media:content",
  "imageAlt": "Podcast cover art",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 3600,
  "removeDuplicate": true,
  "adaptiveSpacing": false
}
```

**Why:**
- 🎙️ emoji for branding
- `imageField: "media:content"` - Episode art, when the feed carries `<media:content>`
  (podcast `<enclosure>` elements hold the audio file, not an image, so they are skipped)
- `runInterval: 3600` - Hourly check (episodes are infrequent)
- `removeDuplicate: true` - Podcast feeds sometimes republish

**Works with:**
- Apple Podcasts feeds
- Spotify RSS
- Self-hosted podcast feeds

**Alternative:**
```json
{
  "string": "🎧 $title\n\n$description\n\nListen: $link",
  "embedType": "card",
  "descriptionClearHTML": true
}
```
Uses link card instead of image, includes description.

---

### Music Release Feed

**Use case:** Artist releasing new tracks/albums

**Features:** Album art, release info

**Config:**
```json
{
  "string": "🎵 New release: $title\n\n$description\n\nStream: $link",
  "publishEmbed": true,
  "embedType": "image",
  "imageField": "enclosure",
  "imageAlt": "Album art for $title",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 7200,
  "descriptionClearHTML": true,
  "removeDuplicate": true,
  "adaptiveSpacing": false
}
```

**Why:**
- `runInterval: 7200` - Check every 2 hours (music releases are rare)
- Includes description (release notes, credits)

---

## Social Media Bridges

### Reddit Subreddit Feed

**Use case:** Post top posts from a subreddit

**Feed URL format:** `https://www.reddit.com/r/{subreddit}/.rss`

**Config:**
```json
{
  "string": "$title\n\n$link",
  "publishEmbed": true,
  "embedType": "card",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 300,
  "descriptionClearHTML": true,
  "removeDuplicate": true,
  "adaptiveSpacing": true,
  "spacingWindow": 600,
  "minSpacing": 60,
  "maxSpacing": 120
}
```

**Example feeds:**
- r/technology: `https://www.reddit.com/r/technology/.rss`
- r/programming: `https://www.reddit.com/r/programming/.rss`
- User posts: `https://www.reddit.com/user/{username}/submitted/.rss`

**Why:**
- `runInterval: 300` - Check every 5 min
- `descriptionClearHTML: true` - Reddit descriptions include HTML
- Adaptive spacing prevents bursts

---

### YouTube Channel Feed

**Use case:** Post new video uploads

**Feed URL format:** `https://www.youtube.com/feeds/videos.xml?channel_id={CHANNEL_ID}`

**Config:**
```json
{
  "string": "📺 New video: $title\n\nWatch: $link",
  "publishEmbed": true,
  "embedType": "card",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 600,
  "removeDuplicate": true,
  "adaptiveSpacing": false
}
```

**Finding channel ID:**
1. Go to channel page
2. View source (right-click → View Page Source)
3. Search for `"channelId"`
4. Copy the ID (e.g., `UCXuqSBlHAE6Xw-yeJA0Tunw`)

**Why:**
- `runInterval: 600` - Check every 10 min
- Link card shows video thumbnail automatically

---

## Organization Announcements

### Company Blog / Status Updates

**Use case:** Organization posting updates, announcements

**Features:** Formal tone, include full context

**Config:**
```json
{
  "string": "📢 $title\n\n$description\n\nRead more: $link",
  "publishEmbed": true,
  "embedType": "card",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 300,
  "descriptionClearHTML": true,
  "forceDescriptionEmbed": true,
  "removeDuplicate": true,
  "adaptiveSpacing": false
}
```

**Why:**
- Includes description (full context)
- `forceDescriptionEmbed: true` - Use your description, not OG tags
- 📢 emoji for official announcements

---

### Status Page Feed

**Use case:** Service status updates (Statuspage.io, etc.)

**Features:** Real-time alerts, clean format

**Config:**
```json
{
  "string": "🚨 $title\n\n$description\n\nDetails: $link",
  "publishEmbed": false,
  "languages": ["en"],
  "truncate": true,
  "runInterval": 60,
  "descriptionClearHTML": true,
  "removeDuplicate": false,
  "adaptiveSpacing": false
}
```

**Why:**
- `runInterval: 60` - Check every minute for urgent updates
- `publishEmbed: false` - Text only for speed
- 🚨 emoji for urgency

---

### Event Calendar Feed

**Use case:** Upcoming events from calendar RSS

**Features:** Event details, date/time info

**Config:**
```json
{
  "string": "📅 $title\n\n$description\n\nDetails: $link",
  "publishEmbed": true,
  "embedType": "card",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 3600,
  "descriptionClearHTML": true,
  "removeDuplicate": true,
  "adaptiveSpacing": false
}
```

**Works with:**
- Google Calendar RSS
- Meetup.com feeds
- Event platform exports

---

## Multi-Language Content

### Bilingual Feed (English + Spanish)

**Use case:** Content published in both languages

**Config:**
```json
{
  "string": "$title - $link",
  "publishEmbed": true,
  "embedType": "card",
  "languages": ["en", "es"],
  "truncate": true,
  "runInterval": 300,
  "descriptionClearHTML": true,
  "removeDuplicate": true,
  "adaptiveSpacing": false
}
```

**Why:**
- `languages: ["en", "es"]` - Tags posts with both languages
- Helps Bluesky users filter by language preference

**Alternative:** Run two bots (fleet mode), one per language:

**Bot 1 (English):**
```json
{
  "languages": ["en"],
  "string": "$title - $link"
}
```

**Bot 2 (Spanish):**
```json
{
  "languages": ["es"],
  "string": "$title - $link"
}
```

Each posts to different account or uses filtered feed URL.

---

### French News Feed

**Config:**
```json
{
  "string": "📰 $title - $link",
  "publishEmbed": true,
  "embedType": "card",
  "languages": ["fr"],
  "truncate": true,
  "runInterval": 120,
  "descriptionClearHTML": true,
  "removeDuplicate": true,
  "adaptiveSpacing": true,
  "spacingWindow": 600,
  "minSpacing": 60,
  "maxSpacing": 120
}
```

**Example feeds:**
- Le Monde: `https://www.lemonde.fr/rss/une.xml`
- France 24: `https://www.france24.com/fr/rss`

---

## Custom Use Cases

### GitHub Releases Feed

**Use case:** Post when new software releases are published

**Feed URL:** `https://github.com/{user}/{repo}/releases.atom`

**Config:**
```json
{
  "string": "🚀 New release: $title\n\n$description\n\nDownload: $link",
  "publishEmbed": true,
  "embedType": "card",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 3600,
  "descriptionClearHTML": true,
  "removeDuplicate": true,
  "adaptiveSpacing": false
}
```

**Example:**
- `https://github.com/rmdes/bsky.rss/releases.atom`

---

### Job Postings Feed

**Use case:** Auto-post job listings from job board RSS

**Config:**
```json
{
  "string": "💼 Job opening: $title\n\n$description\n\nApply: $link",
  "publishEmbed": true,
  "embedType": "card",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 1800,
  "descriptionClearHTML": true,
  "removeDuplicate": true,
  "adaptiveSpacing": true,
  "spacingWindow": 3600,
  "minSpacing": 300,
  "maxSpacing": 600
}
```

**Why:**
- `runInterval: 1800` - Check every 30 min
- Adaptive spacing spreads multiple openings over 1 hour
- `minSpacing: 300` - At least 5 min between posts

---

### Weather Alerts Feed

**Use case:** NOAA weather alerts, severe weather warnings

**Config:**
```json
{
  "string": "⚠️ WEATHER ALERT: $title\n\n$description\n\nDetails: $link",
  "publishEmbed": false,
  "languages": ["en"],
  "truncate": true,
  "runInterval": 60,
  "descriptionClearHTML": true,
  "removeDuplicate": false,
  "adaptiveSpacing": false
}
```

**Why:**
- `runInterval: 60` - Check every minute for urgent alerts
- `publishEmbed: false` - Text only for speed
- `removeDuplicate: false` - Alerts can update, want fresh posts

**Example feed:**
- NOAA CAP alerts: `https://alerts.weather.gov/cap/{state}.atom`

---

### Disaster & Hazard Alerts Feed (Markdown Links + GeoRSS)

**Use case:** Multi-hazard alert feeds (earthquakes, wildfires, floods, cyclones) - clean, short
clickable links instead of raw URLs, with a map link straight to the event's coordinates.

**Config:**
```json
{
  "string": "$title\n\n🔗 [Source]($link)\n🗺️ [Map]($georss)",
  "publishEmbed": true,
  "embedType": "image",
  "imageField": "enclosure",
  "imageAlt": "$title",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 60,
  "removeDuplicate": true,
  "adaptiveSpacing": true,
  "spacingWindow": 3600,
  "minSpacing": 180,
  "maxSpacing": 600
}
```

**Why:**
- `[Source]($link)` / `[Map]($georss)` - Markdown-style link syntax (see
  [CONFIGURATION.md](CONFIGURATION.md#string)) turns two long raw URLs into two short clickable
  words. The blank line (`\n\n`) after `$title` separates the headline from the link row, and the
  🔗/🗺️ emoji prefixes sit outside the brackets - they're plain text, not part of the clickable
  span, so only "Source"/"Map" themselves are links.
- `$georss` - resolves to a real link only when the feed carries coordinates (`<georss:point>` or
  `geo:lat`/`geo:long` as a fallback); if an item has neither, "🗺️ Map" quietly degrades to plain,
  non-clickable text instead of erroring or leaving a dead link.
- `imageField: "enclosure"` - many hazard feeds (e.g. GDACS) publish a generated map/severity image
  per item; falls back to no image, not a broken post, when an item's enclosure is empty (common
  for feeds still generating imagery for a just-published event).
- `adaptiveSpacing` tuned wide (`minSpacing: 180`, `spacingWindow: 3600`) - multi-hazard feeds can
  queue dozens of items in a single poll (a first-time feed switch, or a busy wildfire season); a
  3-minute floor keeps posting from flooding the timeline the way a tighter default would.

**Example feed:**
- GDACS (multi-hazard, global): `https://www.gdacs.org/xml/rss.xml`
- BGS World Earthquakes (GeoRSS via W3C Basic Geo fallback): `http://earthquakes.bgs.ac.uk/feeds/WorldSeismology.xml`
- USGS earthquakes: `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.atom`

---

### Book Reviews / Reading Log

**Use case:** Auto-post book reviews, reading updates

**Config:**
```json
{
  "string": "📚 $title\n\n$description\n\nRead my review: $link",
  "publishEmbed": true,
  "embedType": "image",
  "imageField": "enclosure",
  "imageAlt": "Book cover for $title",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 3600,
  "descriptionClearHTML": true,
  "removeDuplicate": true,
  "adaptiveSpacing": false
}
```

**Works with:**
- Goodreads RSS (if available)
- Personal blog book review feeds
- Book club update feeds

---

## Fleet Mode Multi-Bot Example

**Scenario:** Run 3 bots from one deployment

**Structure:**
```
config.example/
├── fleet.json
└── bots/
    ├── news-bot/
    │   ├── bot.json
    │   └── posting.json
    ├── blog-bot/
    │   ├── bot.json
    │   └── posting.json
    └── podcast-bot/
        ├── bot.json
        └── posting.json
```

**fleet.json:**
```json
{
  "staggerSeconds": 30,
  "runIntervalSeconds": 60,
  "freshness": {
    "maxCatchupItems": 5,
    "maxItemAgeMinutes": 120
  },
  "sharedLimiters": {
    "maxConcurrentOpenGraphFetches": 6,
    "maxConcurrentImageJobs": 2
  }
}
```

**bots/news-bot/bot.json:**
```json
{
  "id": "news-bot",
  "enabled": true,
  "identifier": "news.bsky.social",
  "instanceUrl": "https://bsky.social",
  "feedUrl": "https://rss.cnn.com/rss/cnn_latest.rss",
  "secretKey": "news-bot-secret",
  "fetchIntervalMinutes": 1
}
```

**bots/news-bot/posting.json:**
```json
{
  "string": "📰 $title - $link",
  "publishEmbed": true,
  "embedType": "card",
  "languages": ["en"],
  "adaptiveSpacing": true,
  "spacingWindow": 600
}
```

**See:** [Fleet Mode Documentation](fleet.md) for complete setup.

---

## Testing Your Config

**Step 1: Validate JSON**
- Paste into [JSONLint](https://jsonlint.com)
- Fix syntax errors

**Step 2: Deploy to staging**
- Use Render free tier or test environment
- Point at test RSS feed
- Verify posts appear

**Step 3: Monitor logs**
```
[bsky.rss CONFIG] Config loaded successfully
[bsky.rss RSS] Fetched 5 items from feed
[bsky.rss POST] Posted new item: "Article Title"
```

**Step 4: Check health endpoint**
```bash
curl https://your-app.com/health
# Should return {"status": "healthy", ...}
```

---

## Troubleshooting Configs

**No posts appearing:**
- Check `runInterval` isn't too high
- Verify `FETCH_URL` is correct
- Check logs for errors

**Duplicate posts:**
- Enable `removeDuplicate: true`
- Ensure volume is persistent

**Rate limited:**
- Enable adaptive spacing
- Increase `minSpacing` to 60+

**Images not showing:**
- Verify `embedType: "image"`
- Check `imageField` matches feed structure
- Test image URL in browser

**See:** [Troubleshooting Guide](TROUBLESHOOTING.md)

---

## Next Steps

- **Quick Start:** [Get deployed in 10 minutes](QUICKSTART.md)
- **Configuration Reference:** [All options explained](CONFIGURATION.md)
- **FAQ:** [Common questions](FAQ.md)
- **Deployment:** [Platform guides](DEPLOYMENT.md)
