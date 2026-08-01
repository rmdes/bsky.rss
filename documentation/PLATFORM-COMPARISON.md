# Platform Comparison Guide

Quick reference to help you choose the right deployment platform for bsky.rss.

## Quick Decision Matrix

**Choose Docker (Self-Hosted) if:**
- ✅ You have existing server infrastructure
- ✅ You want full control and no platform fees
- ✅ You're comfortable managing servers
- ✅ You need custom networking or security
- 💰 Only pay for your server costs

**Choose Fly.io if:**
- ✅ You want managed hosting with best price/performance
- ✅ You're comfortable with CLI tools
- ✅ You need reliable persistent storage
- ✅ You want global edge deployment
- 💰 ~$5-10/month

**Choose Railway if:**
- ✅ You want the easiest managed setup
- ✅ You prefer GitHub auto-deploy
- ✅ You value developer experience
- ✅ You want built-in metrics
- 💰 ~$5/month

**Choose Render if:**
- ✅ You want a free tier for testing
- ✅ You're okay with cold starts (free tier)
- ✅ You prefer web UI over CLI
- ✅ You need simple blueprints
- 💰 Free tier or $7/month

**Choose DigitalOcean if:**
- ✅ You're already using DigitalOcean
- ✅ You want predictable pricing
- ✅ You're familiar with DO's ecosystem
- ⚠️ Note: Limited persistent storage for workers
- 💰 $5/month

---

## Detailed Comparison

### Pricing

| Platform | Free Tier | Paid Starting | Infrastructure Cost | Best Value |
|----------|-----------|---------------|---------------------|------------|
| **Docker (Self-Hosted)** | - | Server costs only | Your own | ⭐⭐⭐⭐⭐ |
| **Fly.io** | $5 credit | ~$5-10/month | Managed | ⭐⭐⭐⭐⭐ |
| **Railway** | No | $5/month | Managed | ⭐⭐⭐⭐ |
| **Render** | Yes* | $7/month | Managed | ⭐⭐⭐ |
| **DigitalOcean** | No | $5/month | Managed | ⭐⭐⭐⭐ |

*Render free tier has limitations (spins down after 15min inactivity)

---

### Features

| Feature | Docker | Fly.io | Railway | Render | DigitalOcean |
|---------|--------|--------|---------|--------|--------------|
| **Persistent Storage** | ✅ Your disk | ✅ Volumes | ✅ Volumes | ✅ Disks | ❌ Limited |
| **Auto-deploy** | Manual/CI | Via Actions | ✅ GitHub | ✅ GitHub | ✅ GitHub |
| **Health Checks** | Manual | ✅ | ✅ | ✅ | ✅ |
| **Custom Domains** | Your config | ✅ | ✅ | ✅ | ✅ |
| **Metrics Dashboard** | DIY | ✅ | ✅ | ✅ | ✅ |
| **Log Streaming** | Manual | ✅ | ✅ | ✅ | ✅ |
| **Infrastructure Mgmt** | ❌ You manage | ✅ Managed | ✅ Managed | ✅ Managed | ✅ Managed |
| **Full Control** | ✅ Complete | ⚠️ Limited | ⚠️ Limited | ⚠️ Limited | ⚠️ Limited |

---

### Setup Complexity

| Platform | Setup Time | Ease of Use | Configuration | Ongoing Maintenance |
|----------|-----------|-------------|---------------|-------------------|
| **Docker** | 5 min | ⭐⭐⭐⭐⭐ | Compose file | Manual updates |
| **Fly.io** | 10-15 min | ⭐⭐⭐⭐ | CLI + TOML | Auto-updates |
| **Railway** | 5-10 min | ⭐⭐⭐⭐⭐ | GitHub + UI | Auto-updates |
| **Render** | 10-15 min | ⭐⭐⭐⭐ | GitHub + YAML | Auto-updates |
| **DigitalOcean** | 15-20 min | ⭐⭐⭐ | YAML/UI | Auto-updates |

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

#### Docker (Self-Hosted)
**Pros:**
- Full control over infrastructure
- No platform lock-in
- Use existing servers/VPS
- Custom networking and security
- No recurring platform fees
- Direct access to logs and debugging

**Cons:**
- Manual server management
- Self-managed monitoring and backups
- Requires infrastructure knowledge
- Manual scaling
- You handle uptime

**Best for:** DevOps engineers, self-hosting enthusiasts, teams with existing infrastructure

---

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
**Recommendation:** Docker (if you have a server) or Render (free tier)
- **Docker:** Free if you have existing server, full control
- **Render:** No server needed, free tier with limitations
- Both are simple to set up

### 🏢 Production Bot (reliable uptime needed)
**Recommendation:** Fly.io or Docker (with monitoring)
- **Fly.io:** Managed infrastructure, global edge, built-in monitoring
- **Docker:** Full control, custom setup, your own monitoring
- Both offer reliable uptime if configured correctly

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
**Recommendation:** Docker (self-hosted) or Fly.io
- **Docker:** Free if you have a server (VPS ~$5/month)
- **Fly.io:** Best managed value at ~$5-10/month
- Both have transparent costs

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

| Platform | Monthly Cost | What You Pay For | Notes |
|----------|--------------|------------------|-------|
| **Docker (VPS)** | ~$3-5 | Server only | Hetzner, DigitalOcean droplet, etc. |
| **Docker (existing)** | $0 | Nothing | If you already have a server |
| **Fly.io** | ~$5-7 | Platform + resources | Includes storage & egress |
| **Railway** | ~$5 | Platform + resources | Usage-based |
| **Render** | $0 or $7 | Platform + resources | Free tier or paid |
| **DigitalOcean** | $5 | Platform + resources | Basic plan |

### Medium Bot (512MB RAM, 1 CPU)

| Platform | Monthly Cost | What You Pay For | Notes |
|----------|--------------|------------------|-------|
| **Docker (VPS)** | ~$5-10 | Server only | Slightly larger VPS |
| **Fly.io** | ~$10-12 | Platform + resources | Better value at this tier |
| **Railway** | ~$10 | Platform + resources | Usage-based |
| **Render** | $19 | Platform + resources | Professional plan |
| **DigitalOcean** | $12 | Platform + resources | Professional plan |

**💡 Tip:** 
- **Most economical:** Docker on a cheap VPS ($3-5/month)
- **Best managed value:** Fly.io ($5-10/month)
- **Easiest setup:** Railway ($5/month) or Render (free tier)

---

## Still Undecided?

**Start with Docker if:**
- You already have a server or VPS
- You want full control and zero platform fees
- You're comfortable managing infrastructure

**Start with Railway if:**
- You want managed hosting in < 10 minutes
- You prefer GUI over CLI
- $5/month is worth not managing servers

**Start with Fly.io if:**
- You want best managed value long-term
- You're comfortable with command line
- You need global edge deployment

**Start with Render if:**
- You want to test for free first
- You're okay with occasional cold starts (free tier)
- You prefer web UI configuration

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
