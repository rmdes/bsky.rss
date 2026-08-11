# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.9.x   | :white_check_mark: |
| 2.8.x   | :white_check_mark: |
| < 2.8   | :x:                |

## Reporting a Vulnerability

**Do NOT open a public issue.** Instead:

1. Email security concerns to the repository maintainer
2. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We will respond within 48 hours and work with you on a fix.

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
  - The included Dockerfile uses a non-root user
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
- Consider encrypting the data directory on shared systems

### Feed URLs
- The application fetches from user-configured RSS/Atom feeds
- Malicious feeds could attempt XXE or other XML attacks
- Only subscribe to trusted feed sources
