# Security Policy

## Supported Versions

We actively support the following versions with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 2.9.x   | :white_check_mark: |
| 2.8.x   | :white_check_mark: |
| < 2.8   | :x:                |

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues.**

Instead, report them privately:

1. **GitHub Security Advisories** (preferred)
   - Go to https://github.com/rmdes/bsky.rss/security/advisories
   - Click "Report a vulnerability"
   - Fill in the details

2. **Email**
   - Send to: work@rmendes.net
   - Include:
     - Description of the vulnerability
     - Steps to reproduce
     - Affected versions
     - Potential impact
     - Suggested fix (if any)

### What to expect

- **Initial response:** Within 48 hours
- **Status update:** Within 7 days
- **Fix timeline:** Depends on severity
  - Critical: 1-7 days
  - High: 7-30 days
  - Medium/Low: Best effort

We will acknowledge your contribution in the security advisory once the fix is released.

## Security Best Practices

When deploying bsky.rss:

### Credentials
- ✅ **Always use Bluesky app passwords**, never your main account password
- ✅ Store credentials in platform secrets (Fly.io secrets, Railway variables, etc.)
- ✅ Never commit credentials to git or include in Docker images
- ✅ Rotate app passwords periodically

### Dependencies
- ✅ Keep dependencies updated (Renovate is enabled for this repo)
- ✅ Review dependency changes before merging
- ✅ Run `yarn npm audit` periodically to check for known vulnerabilities

### Network Security
- ✅ Use HTTPS for all feed URLs
- ✅ Validate feed URLs before fetching
- ✅ Set appropriate timeout values to prevent resource exhaustion
- ✅ Restrict network access to necessary domains only

### Deployment
- ✅ Run containers with non-root user (Dockerfile already does this)
- ✅ Use read-only filesystem where possible
- ✅ Limit container memory and CPU
- ✅ Enable health checks and monitoring
- ✅ Review logs regularly for suspicious activity

### Data Storage
- ✅ Store persistent data in volumes, not in containers
- ✅ Back up bot state and queue data regularly
- ✅ Protect SQLite databases from unauthorized access
- ✅ Clean up old seen_items data (auto-cleaned after 96 hours)

## Known Security Considerations

### Rate Limiting
The app includes built-in protections against Bluesky rate limits:
- Authentication rate limiting detection
- Automatic retry with backoff
- Queue-based posting to prevent burst requests

### Image Processing
- Maximum image download size: 10MB (configurable via `maxImageDownloadBytes`)
- Maximum decompressed size: 100MB
- Image resize to 800px width to prevent OOM
- Concurrent image processing limited by `maxConcurrentImageJobs`

### Open Graph Scraping
- Timeout: 10 seconds (configurable)
- Custom User-Agent configurable per bot
- Does not execute JavaScript (no headless browser)

## Disclosure Policy

When a security issue is fixed:

1. We will create a GitHub Security Advisory
2. Release a patched version
3. Update this document if practices should change
4. Credit the reporter (unless they prefer anonymity)

## Contact

For non-security issues, please use [GitHub Issues](https://github.com/rmdes/bsky.rss/issues).

For general questions, see the [Troubleshooting Guide](documentation/TROUBLESHOOTING.md).
