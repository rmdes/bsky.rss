# Renovate Configuration Guide

This repository uses [Renovate](https://docs.renovatebot.com/) to automatically keep dependencies up to date.

## Current Status

This is the leading continued development fork of bsky.rss. The upstream repository (milanmdev/bsky.rss) has been archived and is no longer maintained.

## Enabling Renovate

Renovate needs to be installed and configured for this fork (`rmdes/bsky.rss`).

### Option 1: GitHub App (Recommended)

1. **Install the Renovate GitHub App**
   - Go to: https://github.com/apps/renovate
   - Click "Install" or "Configure"
   - Select "Only select repositories"
   - Choose `rmdes/bsky.rss`
   - Click "Install" or "Save"

2. **Verify Installation**
   - Renovate will create an initial "Configure Renovate" PR
   - Review and merge this PR
   - After merging, Renovate will start creating dependency update PRs

3. **Check the Dependency Dashboard**
   - Look for an issue titled "🤖 Dependency Updates"
   - This dashboard shows all pending updates
   - Pin or ignore updates from this dashboard

### Option 2: Self-Hosted Renovate

If you prefer to run Renovate yourself:

```bash
# Install Renovate CLI
npm install -g renovate

# Run Renovate locally (requires GitHub token)
export GITHUB_TOKEN=your_github_token
renovate rmdes/bsky.rss
```

Or use GitHub Actions (see [Self-Hosted Setup](#self-hosted-setup) below).

---

## Configuration Explained

The current `renovate.json` configuration includes:

### Auto-Merge Rules

```json
{
  "automerge": true,
  "automergeType": "pr",
  "automergeStrategy": "squash"
}
```

**What it does:**
- Automatically merges minor and patch updates after CI passes
- Major updates require manual review
- Security updates auto-merge immediately

### Dependency Grouping

**ATProto packages** (`@atproto/*`):
- Grouped together in a single PR
- Auto-merged when all pass CI
- Example: `@atproto/api` and `@atproto/xrpc` update together

**TypeScript tooling** (`typescript`, `tsx`, `@types/*`, `gts`):
- Grouped together
- Auto-merged as a batch
- Ensures compatibility across the TypeScript ecosystem

### Update Schedule

```json
{
  "schedule": ["before 6am on monday"]
}
```

**What it does:**
- Dependency PRs created Monday mornings (UTC)
- Reduces noise during the week
- Bundles multiple updates together

**Exceptions:**
- Security updates: Created immediately
- Docker base images: Weekly on Monday

### Security

```json
{
  "vulnerabilityAlerts": {
    "automerge": true,
    "labels": ["security"]
  }
}
```

**What it does:**
- Automatically creates PRs for known vulnerabilities
- Auto-merges after CI passes
- Labeled with `security` for visibility

### GitHub Actions Security

```json
{
  "matchManagers": ["github-actions"],
  "pinDigests": true
}
```

**What it does:**
- Pins GitHub Actions to commit SHA
- Prevents supply chain attacks
- Example: `actions/checkout@v4` → `actions/checkout@v4.1.0 # v4.1.0`

---

## Current Dependencies

The repository manages these dependencies:

### Runtime Dependencies
- `@atproto/api` - Bluesky/ATProto SDK
- `@atproto/xrpc` - ATProto RPC client
- `feedsmith` - Feed parsing (RSS, Atom, JSON Feed, RDF)
- `open-graph-scraper` - Open Graph metadata extraction
- `jimp` - Image processing
- `axios` - HTTP client
- `html-entities` - HTML entity decoding
- `dotenv` - Environment variables

### Development Dependencies
- `typescript` - TypeScript compiler
- `tsx` - TypeScript execution
- `gts` - Google TypeScript Style
- `@types/node` - Node.js type definitions

### Docker Base Image
- `node:24-alpine` - Node.js LTS on Alpine Linux

---

## Managing Updates

### Viewing Pending Updates

Check the **Dependency Dashboard** issue:
- Title: "🤖 Dependency Updates"
- Lists all pending updates
- Shows update types (major, minor, patch)

### Pausing Updates

**Pause all updates:**
1. Go to the Dependency Dashboard issue
2. Check the box: "🔕 Ignore all updates"

**Pause specific dependencies:**
1. Edit `renovate.json`
2. Add to `packageRules`:
   ```json
   {
     "matchPackageNames": ["package-name"],
     "enabled": false
   }
   ```

### Ignoring Updates

**Ignore a specific version:**
```json
{
  "packageRules": [
    {
      "matchPackageNames": ["typescript"],
      "allowedVersions": "!/^6\\./"
    }
  ]
}
```

**Ignore major updates for a package:**
```json
{
  "packageRules": [
    {
      "matchPackageNames": ["some-package"],
      "matchUpdateTypes": ["major"],
      "enabled": false
    }
  ]
}
```

---

## Self-Hosted Setup

If you prefer to run Renovate via GitHub Actions instead of the app:

### Create `.github/workflows/renovate.yml`:

```yaml
name: Renovate
on:
  schedule:
    # Run Monday mornings at 5:00 UTC
    - cron: '0 5 * * 1'
  workflow_dispatch:

jobs:
  renovate:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Self-hosted Renovate
        uses: renovatebot/github-action@v40.3.2
        with:
          token: ${{ secrets.RENOVATE_TOKEN }}
        env:
          LOG_LEVEL: 'info'
```

### Required Secrets:

1. **Create a GitHub Personal Access Token:**
   - Go to: https://github.com/settings/tokens/new
   - Scopes needed: `repo`, `workflow`
   - Copy the token

2. **Add to repository secrets:**
   - Go to: `https://github.com/rmdes/bsky.rss/settings/secrets/actions`
   - Click "New repository secret"
   - Name: `RENOVATE_TOKEN`
   - Value: Your personal access token

---

## Troubleshooting

### Renovate Not Creating PRs

**Check:**
1. Is the Renovate app installed on the repository?
2. Does Renovate have permission to create PRs?
3. Check the Dependency Dashboard for rate limits or errors

**Debug:**
```bash
# Run Renovate with debug logging
LOG_LEVEL=debug renovate rmdes/bsky.rss
```

### Too Many PRs

**Solution 1: Increase grouping**
```json
{
  "packageRules": [
    {
      "matchUpdateTypes": ["patch"],
      "groupName": "all patch dependencies",
      "groupSlug": "all-patch"
    }
  ]
}
```

**Solution 2: Reduce schedule frequency**
```json
{
  "schedule": ["before 6am on the first day of the month"]
}
```

### Auto-Merge Not Working

**Requirements:**
1. Branch protection must allow auto-merge
2. CI must pass
3. No merge conflicts

**Check branch protection:**
- Go to: `https://github.com/rmdes/bsky.rss/settings/branches`
- Edit `main` branch rules
- Enable: "Allow auto-merge"

---

## Best Practices

### Review Major Updates

Major updates can break compatibility:
- Test locally before merging
- Check changelogs and migration guides
- Update code if needed

### Keep CI Green

Renovate relies on CI:
- Ensure tests pass on main
- Fix broken tests quickly
- Auto-merge works only when CI is green

### Monitor the Dashboard

Check weekly:
- Review pending major updates
- Check for security alerts
- Verify auto-merges completed

---

## Quick Reference

| Feature | Configuration |
|---------|---------------|
| **Auto-merge** | Minor/patch updates only |
| **Schedule** | Monday mornings, 6 AM UTC |
| **Grouping** | ATProto, TypeScript tooling |
| **Security** | Auto-merge immediately |
| **Dashboard** | Enabled (issue created) |
| **Assignee** | @rmdes |
| **Labels** | `dependencies`, `security` |

---

## Additional Resources

- [Renovate Documentation](https://docs.renovatebot.com/)
- [Configuration Options](https://docs.renovatebot.com/configuration-options/)
- [Preset Configs](https://docs.renovatebot.com/presets-config/)
- [Package Rules](https://docs.renovatebot.com/configuration-options/#packagerules)

---

## Support

For issues with Renovate:
- Check the [Dependency Dashboard](https://github.com/rmdes/bsky.rss/issues?q=is%3Aissue+is%3Aopen+author%3Aapp%2Frenovate)
- Review [Renovate Docs](https://docs.renovatebot.com/)
- Open an issue in this repository

For dependency-specific issues:
- Check the upstream package repository
- Review release notes and changelogs
- Test updates locally before merging
