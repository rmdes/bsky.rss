# Quick Start Guide

Get your RSS-to-Bluesky bot posting in **under 10 minutes** using Railway's one-click deploy.

---

## ⚡ Prerequisites (2 minutes)

Before you start, gather these three things:

### 1. Bluesky App Password

1. Log into [Bluesky](https://bsky.app)
2. Go to **Settings** → **App Passwords**
3. Click **Add App Password**
4. Name it `rss-bot` (or anything you like)
5. **Copy the password** - you'll need it in step 3

> **⚠️ Important:** Use an app password, NOT your main account password. App passwords can be revoked if needed.

### 2. RSS Feed URL

The URL of the feed you want to post from. Examples:
- `https://blog.example.com/feed.xml`
- `https://www.reddit.com/r/technology/.rss`
- `https://hnrss.org/frontpage`

**Test your feed:** Paste the URL in a browser - you should see XML content.

### 3. Bluesky Username or Email

Either your:
- **Username**: `yourname.bsky.social` 
- **Email**: `you@example.com`

---

## 🚀 Deploy to Railway (5 minutes)

Railway is the fastest way to get started - no code, no Docker knowledge needed.

### Step 1: Deploy the App

1. **Click this deploy button:**

   [![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/bsky-rss)

2. **Sign in to Railway** (or create a free account)

3. Railway will create your project - click **Deploy**

### Step 2: Configure Environment Variables

Railway will prompt you for these values:

| Variable | Example | What to Enter |
|----------|---------|---------------|
| `IDENTIFIER` | `yourname.bsky.social` | Your Bluesky username or email |
| `APP_PASSWORD` | `xxxx-xxxx-xxxx-xxxx` | The app password from Prerequisites #1 |
| `FETCH_URL` | `https://blog.com/feed.xml` | Your RSS feed URL from Prerequisites #2 |
| `INSTANCE_URL` | `https://bsky.social` | Leave as default (unless using a different instance) |

**Click Deploy** - Railway will start your bot.

### Step 3: Upload Configuration File

Your bot needs a `config.json` file to know how to format posts.

1. **In Railway, go to your project** → **Settings** → **Volumes**
2. **Create a volume** named `data` mounted at `/build/data`
3. **Upload this config file** as `config.json`:

```json
{
  "string": "$title - $link",
  "publishEmbed": true,
  "embedType": "card",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 60,
  "descriptionClearHTML": true,
  "titleClearHTML": false,
  "removeDuplicate": true,
  "adaptiveSpacing": false
}
```

**What this does:**
- Posts will look like: **"Article Title - https://link.com"**
- Includes a link card preview (like Twitter/X cards)
- Checks feed every 60 seconds
- Removes duplicate posts

4. **Restart the deployment** in Railway

---

## ✅ Verify It's Working (3 minutes)

### Check the Health Endpoint

Railway automatically exposes your app. Find your URL:

1. Go to your Railway project → **Settings**
2. Find the **Public URL** (looks like `https://your-app.railway.app`)
3. Visit `https://your-app.railway.app/health`

You should see:
```json
{
  "status": "healthy",
  "ready": true,
  "lastActivity": "2026-08-06T12:34:56.789Z",
  "uptime": 123.45,
  "version": "2.2.0"
}
```

**Status meanings:**
- ✅ `"status": "healthy"` - Bot is running and active
- ❌ `"status": "unhealthy"` - Bot hasn't run in 10+ minutes (check logs)

### Check the Logs

In Railway → **Deployments** → **Logs**, you should see:

```
[2026-08-06T12:00:00.000Z] - [bsky.rss HEALTH] Health check endpoint listening on port 8080
[2026-08-06T12:00:01.000Z] - [bsky.rss AUTH] Logged in successfully
[2026-08-06T12:00:02.000Z] - [bsky.rss RSS] Fetched 5 items from feed
[2026-08-06T12:00:03.000Z] - [bsky.rss POST] Posted new item: "Article Title"
```

**Good signs:**
- ✅ `Logged in successfully` - Authentication worked
- ✅ `Fetched X items from feed` - RSS feed is being read
- ✅ `Posted new item` - Posts are being created

**Warning signs:**
- ❌ `Invalid credentials` - Check your `APP_PASSWORD`
- ❌ `Failed to fetch feed` - Check your `FETCH_URL`
- ❌ `Post rate limit exceeded` - Bot is posting too fast (normal, it will retry)

### Check Bluesky

1. Log into [Bluesky](https://bsky.app)
2. Go to your profile
3. You should see a new post within 1-2 minutes

**First run behavior:** The bot posts the **latest item** from the feed, then monitors for new items every 60 seconds.

---

## 🎉 Success! What's Next?

Your bot is now running 24/7 and will automatically post new RSS items.

### Customize Your Bot

Edit `config.json` to change behavior:

**Post Format:**
```json
{
  "string": "$title\n\n$description\n\n🔗 $link"
}
```
Posts will include title, description, and link.

**Post Images:**
```json
{
  "embedType": "image",
  "imageField": "enclosure.url",
  "imageAlt": "$title"
}
```
Uploads images from RSS feed instead of link cards.

**Smart Spacing** (prevents spam when many items arrive):
```json
{
  "adaptiveSpacing": true,
  "spacingWindow": 600,
  "minSpacing": 30,
  "maxSpacing": 120
}
```
Spreads 10 items over 10 minutes instead of posting all at once.

**Full configuration reference:** [CONFIGURATION.md](CONFIGURATION.md)

### Monitor Your Bot

**Health checks:** `https://your-app.railway.app/health`

**Logs:** Railway dashboard → **Deployments** → **Logs**

**Uptime monitoring:** Add your health URL to [UptimeRobot](https://uptimerobot.com) (free)

### Run Multiple Bots

Want to run many bots (different accounts, different feeds)? See [Fleet Mode](fleet.md).

---

## 🆘 Troubleshooting

### "Invalid credentials" Error

**Cause:** Wrong username or app password

**Fix:**
1. Double-check your `IDENTIFIER` (must include `.bsky.social` for usernames)
2. Generate a new app password in Bluesky settings
3. Update `APP_PASSWORD` in Railway environment variables
4. Redeploy

### No Posts Appearing

**Cause 1:** No new items in RSS feed
- **Check:** Visit your `FETCH_URL` in a browser - is there new content?
- **Fix:** Wait for new items to be published, or see "Post Existing Items" below

**Cause 2:** Rate limited
- **Check logs:** Look for "Post rate limit exceeded"
- **Fix:** Normal behavior - bot will retry automatically after the backoff period

**Cause 3:** Feed is empty or malformed
- **Check logs:** Look for "Failed to parse feed" or "Fetched 0 items"
- **Fix:** Verify your feed URL returns valid RSS/Atom XML

### Config File Not Loading

**Cause:** Volume not mounted or config.json missing

**Check logs:** Look for `Config file not found`

**Fix:**
1. Verify volume is mounted at `/build/data` in Railway
2. Upload `config.json` to the volume
3. Restart deployment

### Health Endpoint Returns 503

**Cause:** Bot hasn't run successfully in 10+ minutes

**Fix:**
1. Check logs for errors
2. Verify environment variables are set correctly
3. Ensure RSS feed is accessible

**More help:** [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

---

## 📚 Next Steps

- **[Configuration Guide](CONFIGURATION.md)** - All config options explained
- **[Deployment Guide](DEPLOYMENT.md)** - Other platforms (Fly.io, Render, Docker)
- **[Fleet Mode](fleet.md)** - Run multiple bots efficiently
- **[Troubleshooting](TROUBLESHOOTING.md)** - Common issues and solutions

---

## 💰 Costs

**Railway pricing:**
- Free tier: $5 credit/month (enough for 1 bot)
- Hobby plan: $5/month for unlimited projects
- Your bot uses ~0.25 GB RAM, minimal CPU

**Estimated cost:** $0-5/month depending on usage

**Alternative free option:** [Render free tier](DEPLOYMENT.md#render) (sleeps after 15min inactivity, wakes on health checks)

---

**Questions?** Open an issue or check [FAQ.md](FAQ.md)
