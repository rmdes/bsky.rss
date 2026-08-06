---
name: Bug Report
about: Report a bug or unexpected behavior
title: '[BUG] '
labels: 'bug'
assignees: ''
---

## Description

<!-- A clear description of what the bug is -->

## Environment

**Deployment Platform:**
- [ ] Fly.io
- [ ] Railway
- [ ] Render
- [ ] DigitalOcean App Platform
- [ ] Docker (self-hosted)
- [ ] Manual/Development

**Version:** 
<!-- Check /health endpoint or package.json, e.g. v2.2.0 -->

**Node.js version:** 
<!-- If running manually: `node --version` -->

**Operating System:**
<!-- If self-hosted: Ubuntu 22.04, macOS 13, Windows 11, etc. -->

## Configuration

**Mode:**
- [ ] Single-bot mode (`yarn start`)
- [ ] Fleet mode (`yarn fleet`)

**Config (sanitized):**
```json
{
  "string": "$title - $link",
  "publishEmbed": true,
  "runInterval": 60
}
```
<!-- Remove sensitive data like credentials, but include relevant config options -->

**Environment Variables:**
```bash
INSTANCE_URL=https://bsky.social
FETCH_URL=https://example.com/feed.xml
# Don't include IDENTIFIER or APP_PASSWORD
```

## Steps to Reproduce

1. Go to '...'
2. Set config to '...'
3. Run '...'
4. See error

## Expected Behavior

<!-- What should happen -->

## Actual Behavior

<!-- What actually happens -->

## Logs

```
[2026-08-06T12:00:00.000Z] - [bsky.rss AUTH] Logged in successfully
[2026-08-06T12:00:01.000Z] - [bsky.rss ERROR] ...
```

<!-- Last 20-50 lines showing the error. Sanitize any tokens/passwords -->

## Health Check Response

<!-- If applicable, paste the /health endpoint response -->

```json
{
  "status": "unhealthy",
  "ready": true,
  "lastActivity": "...",
  "uptime": 123
}
```

## Feed Information

**Feed URL:** 
<!-- If public and relevant to the issue -->

**Feed type:**
- [ ] RSS 2.0
- [ ] Atom
- [ ] Other: 

**Feed validated:** 
- [ ] Yes (via https://validator.w3.org/feed/)
- [ ] No

## Additional Context

<!-- Any other information: screenshots, related issues, attempted fixes, etc. -->

## Checklist

Before submitting:
- [ ] I've checked the [Troubleshooting Guide](../documentation/TROUBLESHOOTING.md)
- [ ] I've searched existing issues for duplicates
- [ ] I've included relevant logs (with sensitive data removed)
- [ ] I've included my config (with sensitive data removed)
