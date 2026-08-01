# Platform Comparison Guide

Quick reference to help you choose the right deployment platform for bsky.rss.

## Quick Decision Matrix

**Choose Fly.io if:**
- ✅ You want the best price/performance
- ✅ You're comfortable with CLI tools
- ✅ You need reliable persistent storage
- ✅ You want global edge deployment

**Choose Railway if:**
- ✅ You want the easiest setup
- ✅ You prefer GitHub auto-deploy
- ✅ You value developer experience
- ✅ You want built-in metrics

**Choose Render if:**
- ✅ You want a free tier for testing
- ✅ You're okay with cold starts (free tier)
- ✅ You prefer web UI over CLI
- ✅ You need simple blueprints

**Choose DigitalOcean if:**
- ✅ You're already using DigitalOcean
- ✅ You want predictable pricing
- ✅ You're familiar with DO's ecosystem
- ❌ Note: Limited persistent storage for workers

---

## Detailed Comparison

### Pricing

| Platform | Free Tier | Paid Starting | Best Value |
|----------|-----------|---------------|------------|
| **Fly.io** | $5 credit | ~$5-10/month | ⭐⭐⭐⭐⭐ |
| **Railway** | No | $5/month | ⭐⭐⭐⭐ |
| **Render** | Yes* | $7/month | ⭐⭐⭐ |
| **DigitalOcean** | No | $5/month | ⭐⭐⭐⭐ |

*Render free tier has limitations (spins down after 15min inactivity)

---

### Features

| Feature | Fly.io | Railway | Render | DigitalOcean |
|---------|--------|---------|--------|--------------|
| **Persistent Storage** | ✅ Volumes | ✅ Volumes | ✅ Disks | ❌ Limited |
| **Auto-deploy (GitHub)** | Via Actions | ✅ Built-in | ✅ Built-in | ✅ Built-in |
| **Health Checks** | ✅ | ✅ | ✅ | ✅ |
| **Custom Domains** | ✅ | ✅ | ✅ | ✅ |
| **Global CDN** | ✅ | ✅ | ✅ | ✅ |
| **Metrics Dashboard** | ✅ | ✅ | ✅ | ✅ |
| **Log Streaming** | ✅ | ✅ | ✅ | ✅ |
| **CLI Tool** | ✅ Excellent | ✅ Good | ❌ No | ✅ Good |
| **Web UI** | ✅ | ✅ Excellent | ✅ Good | ✅ Good |

---

### Setup Complexity

| Platform | Setup Time | Ease of Use | Configuration |
|----------|-----------|-------------|---------------|
| **Fly.io** | 10-15 min | ⭐⭐⭐⭐ | CLI + TOML file |
| **Railway** | 5-10 min | ⭐⭐⭐⭐⭐ | GitHub + Web UI |
| **Render** | 10-15 min | ⭐⭐⭐⭐ | GitHub + YAML |
| **DigitalOcean** | 15-20 min | ⭐⭐⭐ | YAML or Web UI |

---

### Performance

| Platform | Cold Start | Uptime SLA | Geographic Regions |
|----------|------------|------------|-------------------|
| **Fly.io** | None (always-on) | 99.9% | 35+ regions |
| **Railway** | None (always-on) | 99.9% | 3 regions |
| **Render** | ~30s (free tier) | 99.9% (paid) | 4 regions |
| **DigitalOcean** | None (always-on) | 99.99% | 14 regions |

---

### Storage & Data Persistence

| Platform | Storage Type | Max Size | Backup Support |
|----------|--------------|----------|----------------|
| **Fly.io** | Block volumes | 500 GB | Snapshots |
| **Railway** | Ephemeral volumes | 10 GB | Manual |
| **Render** | Persistent disks | 100 GB | Manual |
| **DigitalOcean** | Limited (workers) | - | - |

**⚠️ Note:** DigitalOcean App Platform doesn't support persistent volumes for background workers. Data resets on deploy.

---

### Developer Experience

#### Fly.io
**Pros:**
- Powerful CLI with great UX
- Excellent documentation
- Fine-grained control
- Low latency globally

**Cons:**
- Requires learning flyctl
- More complex than Railway
- No built-in GitHub auto-deploy

**Best for:** Engineers comfortable with CLI tools

---

#### Railway
**Pros:**
- Easiest setup (GitHub integration)
- Beautiful dashboard
- Great developer experience
- Built-in metrics

**Cons:**
- No free tier
- Fewer global regions
- Limited customization

**Best for:** Developers who want quick deploys

---

#### Render
**Pros:**
- Free tier available
- Blueprint-based deploys
- Good documentation
- Web-based setup

**Cons:**
- Free tier has limitations
- Cold starts on free tier
- Slightly more expensive paid tier

**Best for:** Testing and small projects

---

#### DigitalOcean
**Pros:**
- Familiar if using DO already
- Predictable pricing
- Good documentation
- Integrates with DO services

**Cons:**
- No persistent storage for workers
- More setup required
- Less developer-focused

**Best for:** Existing DigitalOcean users

---

## Use Case Recommendations

### 🏠 Personal Bot (1 account)
**Recommendation:** Railway or Render (free tier)
- Simple setup
- Low/no cost
- Easy monitoring

### 🏢 Production Bot (reliable uptime needed)
**Recommendation:** Fly.io
- Best performance
- Reliable storage
- Global deployment
- Cost-effective at scale

### 🧪 Testing/Development
**Recommendation:** Render (free tier)
- No cost
- Quick setup
- Easy to tear down

### 🚀 Multiple Bots (fleet mode)
**Recommendation:** Fly.io or Railway
- Better resource management
- Persistent storage
- Cost-effective scaling

### 💰 Budget-conscious
**Recommendation:** Fly.io ($5/month)
- Best value
- No hidden costs
- Free outbound transfer

### 🎓 Learning/Experimenting
**Recommendation:** Render (free tier)
- No credit card needed
- Quick iterations
- Easy cleanup

---

## Migration Path

If you outgrow one platform, here's how to migrate:

### From Render (free) → Railway (paid)
1. Export `config.json` from Render disk
2. Set up Railway with same env vars
3. Upload config to Railway volume
4. Switch DNS if using custom domain

### From Railway → Fly.io (scaling up)
1. Export configuration files
2. Run `fly launch` with existing config
3. Create volume and restore data
4. Update DNS records

### From DigitalOcean → Fly.io/Railway
1. Rebuild config (DO doesn't persist)
2. Set up new platform
3. Test thoroughly before switching

---

## Cost Breakdown (Monthly Estimates)

### Small Bot (256MB RAM, 1 CPU)

| Platform | Monthly Cost | Notes |
|----------|--------------|-------|
| **Fly.io** | ~$5-7 | Includes storage & egress |
| **Railway** | ~$5 | Usage-based |
| **Render** | $7 | Fixed pricing |
| **DigitalOcean** | $5 | Basic plan |

### Medium Bot (512MB RAM, 1 CPU)

| Platform | Monthly Cost | Notes |
|----------|--------------|-------|
| **Fly.io** | ~$10-12 | Better value at this tier |
| **Railway** | ~$10 | Usage-based |
| **Render** | $19 | Professional plan |
| **DigitalOcean** | $12 | Professional plan |

**💡 Tip:** Start with Render's free tier for testing, then move to Fly.io or Railway for production.

---

## Still Undecided?

**Start with Railway if:**
- You want to be running in < 10 minutes
- You prefer GUI over CLI
- You don't mind paying $5/month

**Start with Fly.io if:**
- You want the best long-term value
- You're comfortable with command line
- You need global edge deployment

**Start with Render if:**
- You want to test for free first
- You're okay with occasional cold starts
- You don't need 24/7 uptime yet

---

## Quick Links

- [Full Deployment Guide](DEPLOYMENT.md)
- [Fly.io Setup](DEPLOYMENT.md#flyio)
- [Railway Setup](DEPLOYMENT.md#railway)
- [Render Setup](DEPLOYMENT.md#render)
- [DigitalOcean Setup](DEPLOYMENT.md#digitalocean-app-platform)

---

## Support

For deployment help:
- GitHub Issues: https://github.com/rmdes/bsky.rss/issues
- Platform docs linked in [DEPLOYMENT.md](DEPLOYMENT.md)
