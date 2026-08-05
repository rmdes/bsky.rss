# Quick Start: Enable Renovate

This repository is configured for Renovate but needs the GitHub App installed to run.

## 🚀 Quick Setup (2 minutes)

1. **Install Renovate GitHub App**
   
   Visit: https://github.com/apps/renovate
   
   Click **"Install"** → Select **"Only select repositories"** → Choose `rmdes/bsky.rss`

2. **Merge the Onboarding PR**
   
   Renovate will create a PR titled "Configure Renovate"
   
   Review and merge it

3. **Done!**
   
   Renovate will now:
   - ✅ Check for dependency updates every Monday
   - ✅ Auto-merge minor/patch updates
   - ✅ Create a Dependency Dashboard issue
   - ✅ Alert on security vulnerabilities

---

## 📋 What Renovate Will Do

### Auto-Merged (After CI Passes)
- ✅ Minor updates (e.g., `1.2.0` → `1.3.0`)
- ✅ Patch updates (e.g., `1.2.0` → `1.2.1`)
- ✅ Security fixes
- ✅ Docker base image updates

### Manual Review Required
- ⚠️ Major updates (e.g., `1.0.0` → `2.0.0`)

### Grouped Updates
- `@atproto/*` packages updated together
- TypeScript tooling (`typescript`, `tsx`, `@types/*`) updated together

---

## 📊 Monitoring

After setup, you'll see:

1. **Dependency Dashboard Issue**
   - Title: "🤖 Dependency Updates"
   - Lists all pending updates
   - Pin or ignore specific updates

2. **Weekly Update PRs**
   - Created Monday mornings (6 AM UTC)
   - Labeled with `dependencies`
   - Auto-merge if CI passes

3. **Security Alerts**
   - Created immediately
   - Labeled with `security`
   - Auto-merge after CI passes

---

## 📖 Full Documentation

See [documentation/RENOVATE.md](../documentation/RENOVATE.md) for:
- Detailed configuration explanation
- Customization options
- Troubleshooting guide
- Self-hosted setup

---

## ❓ Need Help?

**Renovate not working?**
1. Verify the app is installed: https://github.com/apps/renovate/installations
2. Check repository settings → Installed GitHub Apps
3. Look for error messages in the Dependency Dashboard

**Want to customize?**
- Edit `renovate.json` in the repository root
- See: https://docs.renovatebot.com/configuration-options/

---

**Status:** Renovate GitHub App installed
