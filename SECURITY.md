# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.13.x  | :white_check_mark: |
| < 2.13  | :x:                |

## Reporting a Vulnerability

**Do NOT open a public issue.** Instead:

1. Report it privately via GitHub: **Security → Report a vulnerability**
   (<https://github.com/rmdes/bsky.rss/security/advisories/new>)
2. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

## Security Best Practices

When deploying bsky.rss:

- ✅ **Use app passwords**, not main account passwords
  - Generate app passwords at https://bsky.app/settings/app-passwords
  - Never commit passwords to version control
  
- ✅ **Keep dependencies updated**
  - Renovate is enabled for automatic dependency updates
  - Review and merge security updates promptly
  
- ✅ **Use HTTPS for all feed URLs**
  - Avoid HTTP feeds that could be intercepted
  - Validate SSL certificates
  
- ✅ **Run in Docker with non-root user**
  - The included Dockerfile does not set a `USER`, so the container runs as root by default;
    pass `--user` / `user:` to run it unprivileged
  - Limit container permissions appropriately
  
- ✅ **Restrict network access**
  - Only allow outbound connections to necessary domains
  - Use firewall rules to limit exposure
  
- ✅ **Monitor logs for unauthorized access attempts**
  - Review logs regularly for suspicious activity
  - Set up alerts for repeated failures
  
- ✅ **Protect sensitive files**
  - Never commit `.env` or `data/` directories
  - Use `.gitignore` to prevent accidental commits
  - Secure file permissions on production servers

## Known Security Considerations

### Rate Limiting
- Bluesky enforces rate limits on authentication and posting
- Multiple failed auth attempts from the same IP may trigger temporary blocks
- Fleet mode users should be cautious with parallel bot activation

### Data Storage
- Session tokens are stored locally in `data/persist.json`
- Ensure proper file permissions (600) on production systems
  - Fleet mode already writes its session/secrets JSON with mode `0600`; single-bot mode's
    `data/persist.json` uses the default file mode, so restrict it yourself
- Consider encrypting the data directory on shared systems

### Feed URLs
- The application fetches from user-configured RSS/Atom feeds
- Malicious feeds could attempt XXE or other XML attacks
- Only subscribe to trusted feed sources
- Feed bodies are capped at 20 MB
- Open Graph lookups (`open-graph-scraper` >= 6.13) refuse private, loopback and link-local
  addresses, so a feed item can't make the bot fetch internal services
