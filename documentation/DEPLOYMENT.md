# Deployment Guide

This guide covers all deployment options for bsky.rss. Choose the platform that best fits your needs - whether you want managed cloud hosting or prefer to self-host.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Decision Guide](#quick-decision-guide)
- [Deployment Options](#deployment-options)
  - [Managed Cloud Platforms](#managed-cloud-platforms)
    - [Fly.io](#flyio) - Best price/performance
    - [Railway](#railway) - Easiest setup
    - [Render](#render) - Free tier available
    - [DigitalOcean App Platform](#digitalocean-app-platform)
  - [Self-Hosted Options](#self-hosted-options)
    - [Docker (Self-Hosted)](#docker-self-hosted) - Full control
    - [Manual / Development](#manual-development)
- [Configuration](#configuration)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before deploying, you'll need:

1. **Bluesky Account**
   - A Bluesky account (username or email)
   - An app password (Settings → App Passwords → Add App Password)
   - **Important:** Use an app password, not your main account password

2. **RSS Feed URL**
   - The URL of the RSS feed you want to monitor
   - Ensure it's publicly accessible

3. **Configuration File**
   - Copy `data/config.example.json` to `data/config.json`
   - Customize your post template and settings
   - See [Configuration](#configuration) section below

---

## Quick Decision Guide

**Choose a managed cloud platform if you want:**
- ✅ Zero infrastructure management
- ✅ Automatic health checks and monitoring
- ✅ Built-in scaling and reliability
- ✅ GitHub auto-deploy
- 💰 ~$5-10/month

**Choose self-hosted Docker if you want:**
- ✅ Full control over infrastructure
- ✅ Run on existing servers
- ✅ No recurring platform fees
- ✅ Custom networking/security
- 💰 Just your server costs

**Choose manual setup if you're:**
- 🔧 Developing or debugging
- 🔧 Running locally for testing
- 🔧 Need custom modifications

**📊 [Full Platform Comparison](PLATFORM-COMPARISON.md)** - Detailed feature matrix and recommendations

---

## Deployment Options

### Managed Cloud Platforms

Cloud platforms handle all infrastructure, monitoring, and scaling for you.

#### Fly.io

**Best for:** Production deployments with excellent price/performance ratio (~$5-10/month)

#### Prerequisites
- Install the [Fly CLI](https://fly.io/docs/hands-on/install-flyctl/)
- Create a Fly.io account

#### Deployment Steps

1. **Authenticate with Fly.io**
   ```bash
   fly auth login
   ```

2. **Create your app** (first-time only)
   ```bash
   fly apps create bsky-rss
   ```

3. **Create a persistent volume** (first-time only)
   ```bash
   fly volumes create bsky_data --size 1 --region iad
   ```

4. **Set environment secrets**
   ```bash
   fly secrets set IDENTIFIER="your-bluesky-username"
   fly secrets set APP_PASSWORD="your-app-password"
   fly secrets set FETCH_URL="https://example.com/feed.xml"
   fly secrets set INSTANCE_URL="https://bsky.social"
   ```

5. **Deploy**
   ```bash
   fly deploy
   ```

6. **Check status**
   ```bash
   fly status
   fly logs
   ```

#### Updating

To deploy updates:
```bash
git pull
fly deploy
```

#### Customization

Edit `fly.toml` to:
- Change region (`primary_region`)
- Adjust memory/CPU (`vm.memory`, `vm.cpus`)
- Modify health check intervals

---

### Railway

**Best for:** Easiest setup with GitHub integration, great developer experience

#### Prerequisites
- Create a [Railway account](https://railway.app)
- Connect your GitHub account (optional but recommended)

#### Deployment Steps

##### Option 1: GitHub Integration (Recommended)

1. **Fork or clone this repository** to your GitHub account

2. **Create a new project** in Railway
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Choose your bsky.rss repository
   - Railway will auto-detect the Dockerfile

3. **Add environment variables**
   - Click on your service
   - Go to "Variables" tab
   - Add:
     - `IDENTIFIER` = your Bluesky username
     - `APP_PASSWORD` = your app password
     - `FETCH_URL` = your RSS feed URL
     - `INSTANCE_URL` = https://bsky.social

4. **Add persistent storage** (first-time only)
   - Click "Add Volume"
   - Mount path: `/build/data`
   - Size: 1 GB

5. **Deploy**
   - Railway auto-deploys on push to main branch
   - Or click "Deploy Now" to deploy manually

##### Option 2: Railway CLI

1. **Install Railway CLI**
   ```bash
   npm i -g @railway/cli
   ```

2. **Login**
   ```bash
   railway login
   ```

3. **Initialize and deploy**
   ```bash
   railway init
   railway up
   ```

4. **Set variables**
   ```bash
   railway variables set IDENTIFIER="your-username"
   railway variables set APP_PASSWORD="your-password"
   railway variables set FETCH_URL="https://example.com/feed.xml"
   railway variables set INSTANCE_URL="https://bsky.social"
   ```

#### Monitoring

- View logs: Dashboard → Your Service → Logs
- Check metrics: Dashboard → Your Service → Metrics
- Health check: Visit your app's URL + `/health`

---

### Render

**Best for:** Free tier for testing and small deployments

#### Prerequisites
- Create a [Render account](https://render.com)

#### Deployment Steps

##### Option 1: Using Blueprint (Recommended)

1. **Fork this repository** to your GitHub account

2. **Create a new Blueprint**
   - Go to Render dashboard
   - Click "New +" → "Blueprint"
   - Connect your GitHub repository
   - Render will detect `render.yaml`

3. **Set environment variables**
   - During setup, you'll be prompted for:
     - `IDENTIFIER` (your Bluesky username)
     - `APP_PASSWORD` (your app password)
     - `FETCH_URL` (your RSS feed URL)

4. **Apply Blueprint**
   - Click "Apply"
   - Render will create the worker and disk

##### Option 2: Manual Setup

1. **Create a new Worker**
   - Dashboard → "New +" → "Background Worker"
   - Connect repository
   - Runtime: Docker

2. **Configure worker**
   - Name: `bsky-rss`
   - Region: Choose closest to you
   - Branch: `main`
   - Dockerfile path: `./Dockerfile`

3. **Add environment variables**
   - Go to "Environment" tab
   - Add all required variables

4. **Add persistent disk**
   - Go to "Disks" tab
   - Click "Add Disk"
   - Name: `bsky-data`
   - Mount path: `/build/data`
   - Size: 1 GB

5. **Deploy**
   - Click "Manual Deploy" → "Deploy latest commit"

#### Free Tier Limitations

- Free tier workers spin down after 15 minutes of inactivity
- **Important:** This may cause RSS feeds to be missed
- Upgrade to paid plan ($7/month) for always-on workers

---

### DigitalOcean App Platform

**Best for:** Existing DigitalOcean users, predictable pricing

#### Prerequisites
- Create a [DigitalOcean account](https://www.digitalocean.com)

#### Deployment Steps

##### Option 1: App Spec File

1. **Update `.do/app.yaml`**
   - Edit the `github.repo` field with your repository

2. **Create app via doctl CLI**
   ```bash
   doctl apps create --spec .do/app.yaml
   ```

##### Option 2: Web UI

1. **Create new App**
   - Go to Apps → "Create App"
   - Choose "Docker Hub" or "GitHub"

2. **Configure source**
   - Select your repository
   - Branch: `main`
   - Source directory: `/`

3. **Configure app**
   - Type: Worker
   - Dockerfile path: `Dockerfile`
   - HTTP port: 8080

4. **Set environment variables**
   - Add:
     - `IDENTIFIER` (encrypt as secret)
     - `APP_PASSWORD` (encrypt as secret)
     - `FETCH_URL` (encrypt as secret)
     - `INSTANCE_URL` = `https://bsky.social`
     - `HEALTH_CHECK_PORT` = `8080`

5. **Add persistent storage** (optional)
   - Note: DigitalOcean App Platform doesn't support volumes for workers
   - File persistence will reset on deploys
   - Consider using a database for production

6. **Deploy**
   - Click "Create Resources"

#### Cost

- Basic plan: $5/month
- Professional: $12/month

---

### Self-Hosted Options

Run bsky.rss on your own infrastructure for full control.

#### Docker (Self-Hosted)

**Best for:** Self-hosting with full control, existing Docker infrastructure

Docker is the recommended way to self-host bsky.rss. It provides isolation, easy updates, and consistent behavior across environments.

##### Prerequisites
- Docker and Docker Compose installed
- A server or machine to run the container
- Access to configure persistent storage

##### Deployment Steps

1. **Create a docker-compose.yml file**

   ```yml
   version: "3"
   services:
     bsky-rss:
       restart: always
       image: ghcr.io/rmdes/bsky.rss:latest
       environment:
         - IDENTIFIER=your-bluesky-username
         - APP_PASSWORD=your-app-password
         - FETCH_URL=https://example.com/feed.xml
         - INSTANCE_URL=https://bsky.social
         - FETCH_INTERVAL=5
         - HEALTH_CHECK_PORT=8080
       volumes:
         - ./data:/build/data
       ports:
         - "8080:8080"  # Optional: expose health check
   ```

2. **Create the data directory**

   ```bash
   mkdir -p data
   cp data/config.example.json data/config.json
   # Edit data/config.json with your preferences
   ```

3. **Start the container**

   ```bash
   docker-compose up -d
   ```

4. **Check status**

   ```bash
   docker-compose logs -f
   curl http://localhost:8080/health
   ```

##### Updating

Pull the latest image and restart:

```bash
docker-compose pull
docker-compose up -d
```

##### Using a Specific Version

Pin to a specific version tag instead of `latest`:

```yml
image: ghcr.io/rmdes/bsky.rss:v2.2.0
```

Available tags:
- `latest` - Latest stable release
- `v2.2.0` - Specific version
- `main-<commit>` - Bleeding edge from main branch

##### Docker Run (Without Compose)

```bash
docker run -d \
  --name bsky-rss \
  --restart unless-stopped \
  -e IDENTIFIER="your-username" \
  -e APP_PASSWORD="your-password" \
  -e FETCH_URL="https://feed.xml" \
  -e INSTANCE_URL="https://bsky.social" \
  -v $(pwd)/data:/build/data \
  -p 8080:8080 \
  ghcr.io/rmdes/bsky.rss:latest
```

##### Building from Source

To build your own image:

```bash
git clone https://github.com/rmdes/bsky.rss.git
cd bsky.rss
docker build -t bsky-rss:custom .
# Update docker-compose.yml to use bsky-rss:custom
```

##### Reverse Proxy (Optional)

Expose the health check endpoint through your reverse proxy (nginx, Caddy, Traefik):

**Nginx example:**
```nginx
location /health {
    proxy_pass http://localhost:8080/health;
    proxy_set_header Host $host;
}
```

**Caddy example:**
```
example.com {
    reverse_proxy /health localhost:8080
}
```

##### Pros
- ✅ Full control over infrastructure
- ✅ Run on existing servers
- ✅ No platform fees
- ✅ Easy updates via image pulls
- ✅ Isolated environment

##### Cons
- ❌ You manage monitoring and uptime
- ❌ Manual scaling
- ❌ Self-managed backups
- ❌ Requires server maintenance

---

#### Manual / Development

**Best for:** Local development, testing, debugging, custom modifications

Run bsky.rss directly on your machine without Docker.

##### Prerequisites
- Node.js 22+ (LTS recommended)
- Yarn package manager
- Git

##### Setup Steps

1. **Clone the repository**

   ```bash
   git clone https://github.com/rmdes/bsky.rss.git
   cd bsky.rss
   ```

2. **Install dependencies**

   ```bash
   yarn install
   ```

3. **Configure environment**

   Create a `.env` file:

   ```bash
   IDENTIFIER=your-bluesky-username
   APP_PASSWORD=your-app-password
   FETCH_URL=https://example.com/feed.xml
   INSTANCE_URL=https://bsky.social
   FETCH_INTERVAL=5
   HEALTH_CHECK_PORT=8080
   ```

4. **Set up configuration**

   ```bash
   cp data/config.example.json data/config.json
   # Edit data/config.json with your preferences
   ```

5. **Run the application**

   ```bash
   # Production mode
   yarn start

   # Development mode (with auto-reload)
   yarn dev
   ```

6. **Check health**

   ```bash
   curl http://localhost:8080/health
   ```

##### Development Workflow

**Running tests:**
```bash
yarn typecheck
```

**Building for production:**
```bash
# The app runs with tsx, no build step needed
yarn start
```

**Debugging:**
- Use `yarn dev` for auto-reload on file changes
- Check logs in console output
- Inspect `data/` directory for state files

##### Running as a System Service

**systemd service (Linux):**

Create `/etc/systemd/system/bsky-rss.service`:

```ini
[Unit]
Description=bsky.rss - RSS to Bluesky poster
After=network.target

[Service]
Type=simple
User=bsky
WorkingDirectory=/home/bsky/bsky.rss
ExecStart=/usr/bin/yarn start
Restart=always
RestartSec=10
Environment="NODE_ENV=production"
EnvironmentFile=/home/bsky/bsky.rss/.env

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable bsky-rss
sudo systemctl start bsky-rss
sudo systemctl status bsky-rss
```

**PM2 (Node.js process manager):**

```bash
npm install -g pm2
pm2 start "yarn start" --name bsky-rss
pm2 save
pm2 startup  # Follow instructions
```

##### Pros
- ✅ Direct access to code
- ✅ Easy debugging
- ✅ Fast iteration during development
- ✅ No Docker overhead
- ✅ Full customization

##### Cons
- ❌ Manual dependency management
- ❌ Environment-specific issues
- ❌ Requires process management for production
- ❌ More complex deployment

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `IDENTIFIER` | ✅ Yes | - | Bluesky username or email |
| `APP_PASSWORD` | ✅ Yes | - | Bluesky app password (not account password) |
| `FETCH_URL` | ✅ Yes | - | RSS feed URL to monitor |
| `INSTANCE_URL` | No | `https://bsky.social` | Bluesky instance URL |
| `FETCH_INTERVAL` | No | `5` | RSS fetch interval in minutes |
| `HEALTH_CHECK_PORT` | No | `8080` | Port for health check endpoint |

### Config File (`data/config.json`)

The configuration file controls how posts are formatted and published. See `data/config.example.json` for a complete example.

**Key settings:**

```json
{
  "string": "$title - $link",
  "publishEmbed": true,
  "embedType": "card",
  "languages": ["en"],
  "truncate": true,
  "runInterval": 60,
  "removeDuplicate": false,
  "descriptionClearHTML": false,
  "titleClearHTML": false
}
```

**Template variables:**
- `$title` - RSS item title
- `$link` - RSS item link
- `$description` - RSS item description

**Embed types:**
- `card` - Link preview with Open Graph metadata
- `image` - Direct image upload from RSS

---

## Monitoring

### Health Check Endpoint

All deployments include a health check endpoint at `/health`.

**Example response:**
```json
{
  "status": "healthy",
  "ready": true,
  "lastActivity": "2026-08-01T12:00:00.000Z",
  "timeSinceActivity": "15s",
  "uptime": 3600,
  "version": "2.2.0"
}
```

### Checking Health

```bash
# Fly.io
curl https://your-app.fly.dev/health

# Railway
curl https://your-app.railway.app/health

# Render
curl https://your-app.onrender.com/health
```

### Logs

**Fly.io:**
```bash
fly logs
fly logs -a bsky-rss
```

**Railway:**
- Dashboard → Service → Logs tab

**Render:**
- Dashboard → Service → Logs tab

**DigitalOcean:**
- Apps → Your App → Runtime Logs

---

## Troubleshooting

### Common Issues

#### 1. "No identifier provided" error

**Cause:** Missing environment variable

**Solution:**
- Verify `IDENTIFIER` is set correctly
- Check for typos in variable names
- Restart the service after setting variables

#### 2. "Rate Limit Exceeded" error

**Cause:** Too many login attempts or posts

**Solution:**
- Use an app password instead of account password
- Increase `runInterval` in config.json
- Wait 30 minutes and try again

#### 3. Health check failing

**Cause:** App not responding on port 8080

**Solution:**
- Check logs for startup errors
- Verify `HEALTH_CHECK_PORT` matches platform config
- Ensure Dockerfile exposes port 8080

#### 4. RSS feed not updating

**Cause:** Feed unreachable or invalid

**Solution:**
- Test feed URL in browser
- Check feed format (must be valid RSS/Atom)
- Verify `FETCH_INTERVAL` is reasonable (5+ minutes)
- Check logs for parsing errors

#### 5. Posts not appearing on Bluesky

**Cause:** Rate limiting, authentication issues, or queue problems

**Solution:**
- Check `/health` endpoint for `lastActivity`
- Review logs for rate limit messages
- Verify app password is correct
- Check queue status in logs

#### 6. Persistent data lost on restart (DigitalOcean)

**Cause:** DigitalOcean App Platform doesn't support volumes for workers

**Solution:**
- Use Fly.io, Railway, or Render for persistent storage
- Or implement external database for persistence

---

## Platform Comparison

| Feature | Fly.io | Railway | Render | DigitalOcean |
|---------|--------|---------|--------|--------------|
| **Ease of Setup** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| **Free Tier** | Limited | No | Yes | No |
| **Pricing** | ~$5-10/mo | ~$5/mo | $7/mo | $5/mo |
| **Auto-deploy** | CLI | GitHub | GitHub | GitHub |
| **Persistent Storage** | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No (workers) |
| **Health Checks** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| **Global Regions** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| **Best For** | Production | Developers | Testing | DO users |

---

## Next Steps

1. Choose a platform based on your needs
2. Follow the deployment guide
3. Configure your RSS feed and post template
4. Monitor the `/health` endpoint
5. Check logs to verify posts are being created

For issues or questions:
- GitHub Issues: https://github.com/rmdes/bsky.rss/issues
- Documentation: https://github.com/rmdes/bsky.rss

---

## Advanced: CI/CD

All platforms support automatic deployments from GitHub:

1. **Connect your repository** to the platform
2. **Enable auto-deploy** on push to main
3. **Set up branch protection** (recommended)
4. **Add status checks** using health endpoint

Platform will automatically rebuild and deploy on every push.
