# Contributing to bsky.rss

Thank you for your interest in contributing to bsky.rss! This document provides guidelines and information for contributors.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [Release Process](#release-process)
- [Community](#community)

---

## Code of Conduct

This project follows a simple code of conduct:

- **Be respectful** - Treat everyone with respect and kindness
- **Be constructive** - Provide helpful feedback and suggestions
- **Be collaborative** - Work together towards common goals
- **Be inclusive** - Welcome contributors of all backgrounds and skill levels

By participating in this project, you agree to abide by these principles.

---

## Getting Started

### Prerequisites

Before contributing, make sure you have:

- **Node.js 22+** (LTS recommended)
- **Yarn 4+** (package manager)
- **Git** for version control
- **TypeScript** knowledge (project is written in TypeScript)
- **Bluesky account** for testing (use a test account, not your main)

### Understanding the Project

1. **Read the documentation:**
   - [README.md](README.md) - Project overview
   - [documentation/fleet.md](documentation/fleet.md) - Fleet mode architecture
   - [documentation/DEPLOYMENT.md](documentation/DEPLOYMENT.md) - Deployment options
   - [CHANGELOG.md](CHANGELOG.md) - Project history

2. **Explore the codebase:**
   - `app/` - Single-bot mode (original functionality)
   - `fleet/` - Multi-bot fleet mode
   - `documentation/` - Guides and documentation
   - `scripts/` - Deployment and utility scripts

---

## Development Setup

### 1. Fork and Clone

```bash
# Fork the repository on GitHub
# Then clone your fork
git clone https://github.com/YOUR_USERNAME/bsky.rss.git
cd bsky.rss
```

### 2. Install Dependencies

```bash
yarn install
```

### 3. Configure Environment

```bash
# Copy example config
cp data/config.example.json data/config.json

# Create .env file
cat > .env << EOF
IDENTIFIER=your-test-account@bsky.social
APP_PASSWORD=your-app-password
FETCH_URL=https://example.com/feed.xml
INSTANCE_URL=https://bsky.social
FETCH_INTERVAL=5
EOF
```

**Important:** Use a test Bluesky account, not your personal account!

### 4. Run in Development Mode

```bash
# Single-bot mode
yarn dev

# Fleet mode
yarn fleet
```

### 5. Type Checking

```bash
yarn typecheck
```

---

## How to Contribute

### Reporting Bugs

Found a bug? Please open an issue with:

1. **Clear title** - Describe the issue concisely
2. **Description** - What happened vs. what you expected
3. **Steps to reproduce** - How to trigger the bug
4. **Environment** - Node.js version, OS, deployment method
5. **Logs** - Relevant error messages or output
6. **Screenshots** - If applicable

**Example:**
```
Title: Rate limit not respected when queue has multiple items

Description:
The bot continues posting every 60 seconds even after hitting a rate limit.

Steps to Reproduce:
1. Configure runInterval to 60 seconds
2. Add 10 items to queue
3. Observe posts continue despite rate limit error

Environment:
- Node.js: v22.1.0
- OS: Ubuntu 22.04
- Deployment: Docker

Logs:
[2026-08-01] - [bsky.rss POST] Post rate limit exceeded
[2026-08-01] - [bsky.rss POST] Posting new item (continued anyway)
```

### Suggesting Features

Have an idea? Open an issue with:

1. **Use case** - What problem does this solve?
2. **Proposed solution** - How would it work?
3. **Alternatives** - Other approaches considered
4. **Implementation notes** - Technical considerations (optional)

### Contributing Code

Ready to code? Great! Here's the process:

1. **Check existing issues** - Someone might already be working on it
2. **Open an issue first** - Discuss your approach before coding
3. **Create a branch** - Use a descriptive name
4. **Make your changes** - Follow coding standards
5. **Test thoroughly** - Ensure nothing breaks
6. **Submit a pull request** - Follow the PR template

---

## Coding Standards

### TypeScript Style

We use **Google TypeScript Style** (gts):

```bash
# Check style
yarn gts check

# Auto-fix style issues
yarn gts fix
```

### Code Conventions

**Naming:**
- Use `camelCase` for variables and functions
- Use `PascalCase` for types and interfaces
- Use `UPPER_SNAKE_CASE` for constants
- Use descriptive names (avoid single letters except loop indices)

**Structure:**
- Keep functions focused and small
- Extract reusable logic into utilities
- Use async/await instead of callbacks
- Handle errors explicitly

**Comments:**
- Write self-documenting code
- Add comments for complex logic
- Document public APIs with JSDoc
- Explain *why*, not *what*

**Example:**

```typescript
// Good
async function fetchRSSFeed(url: URL): Promise<FeedItem[]> {
  // Use custom user agent to avoid 403 responses from some servers
  const response = await axios.get(url.toString(), {
    headers: { 'User-Agent': config.ogUserAgent }
  });
  return parseFeed(response.data);
}

// Avoid
async function f(u: any) {
  const r = await axios.get(u); // What if this fails?
  return r.data;
}
```

### File Organization

```
app/
├── index.ts           # Entry point
├── types/             # TypeScript type definitions
│   └── index.d.ts
└── utils/             # Utility modules
    ├── bskyHandler.ts
    ├── rssHandler.ts
    ├── queueHandler.ts
    └── dbHandler.ts

fleet/
├── runFleet.ts        # Fleet mode entry point
├── *.ts               # Core fleet modules
└── *.test.ts          # Tests (co-located)
```

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `chore`: Maintenance tasks
- `refactor`: Code restructuring
- `test`: Adding/updating tests
- `perf`: Performance improvements

**Examples:**
```
feat(fleet): add graceful shutdown support

Implements SIGTERM/SIGINT handlers that:
- Stop accepting new items
- Drain existing queue
- Close connections cleanly

Fixes #42

---

fix(queue): respect rate limit backoff timer

The timer condition was inverted, causing the queue
to ignore rate limits. Fixed by checking if rateLimited
is true before creating a new timer.

---

docs: add deployment guide for Railway

Includes step-by-step setup instructions and
configuration examples.
```

---

## Testing

### Running Tests

```bash
# Run all tests
yarn test

# Run specific test file
yarn test fleet/botWorker.test.ts

# Run with coverage
yarn test --coverage
```

### Writing Tests

Tests are co-located with source files:

```
fleet/
├── botWorker.ts
└── botWorker.test.ts
```

Use descriptive test names:

```typescript
import {describe, it} from 'node:test';
import assert from 'node:assert';

describe('BotWorker', () => {
  it('should enqueue items from RSS feed', async () => {
    const worker = new BotWorker(config);
    await worker.processItem(mockItem);
    assert.strictEqual(worker.queueLength, 1);
  });

  it('should respect rate limits', async () => {
    const worker = new BotWorker(config);
    worker.rateLimited = true;
    await worker.drain();
    assert.strictEqual(worker.postsAttempted, 0);
  });
});
```

### Manual Testing

Before submitting a PR:

1. **Test single-bot mode:**
   ```bash
   yarn start
   # Verify RSS feed is monitored
   # Verify posts are created on Bluesky
   # Check health endpoint: curl http://localhost:8080/health
   ```

2. **Test fleet mode (if applicable):**
   ```bash
   yarn fleet
   # Verify multiple bots run independently
   # Check logs for errors
   ```

3. **Test deployment configs (if applicable):**
   ```bash
   # Build Docker image
   docker build -t bsky-rss:test .
   
   # Run container
   docker run -it --rm \
     -e IDENTIFIER=test@bsky.social \
     -e APP_PASSWORD=xxx \
     -e FETCH_URL=https://feed.xml \
     -e INSTANCE_URL=https://bsky.social \
     -v $(pwd)/data:/build/data \
     bsky-rss:test
   ```

---

## Pull Request Process

### Before Submitting

- [ ] Code follows style guidelines (run `yarn gts check`)
- [ ] Tests pass (run `yarn test`)
- [ ] Type checking passes (run `yarn typecheck`)
- [ ] Manually tested the changes
- [ ] Updated documentation if needed
- [ ] Updated CHANGELOG.md if adding features

### PR Template

When opening a PR, include:

1. **Description** - What does this PR do?
2. **Motivation** - Why is this change needed?
3. **Changes** - What was modified?
4. **Testing** - How was this tested?
5. **Screenshots** - If applicable
6. **Checklist** - Completed items above

**Example:**

```markdown
## Description
Adds support for RSS feeds with custom namespaces

## Motivation
Some RSS feeds use custom XML namespaces that weren't being parsed.
This caused items to be skipped or missing metadata.

## Changes
- Updated feed normalization to handle custom namespaces
- Added namespace mapping for common extensions (dc:, media:)
- Improved error logging for unparseable feeds

## Testing
- [x] Tested with standard RSS 2.0 feeds
- [x] Tested with feeds using dc:creator namespace
- [x] Tested with feeds using media:content namespace
- [x] Verified backward compatibility with existing feeds

## Checklist
- [x] Code follows style guidelines
- [x] Tests added/updated
- [x] Type checking passes
- [x] Manually tested
- [x] Documentation updated
```

### Review Process

1. **Maintainer review** - A maintainer will review your PR
2. **Feedback** - Address any requested changes
3. **Approval** - Once approved, it will be merged
4. **CI/CD** - Automated checks must pass

**Note:** Please be patient! Maintainers are volunteers and will review as time permits.

---

## Release Process

Releases are managed by maintainers following semantic versioning:

### Version Scheme

- **Major (X.0.0)** - Breaking changes
- **Minor (x.X.0)** - New features (backward compatible)
- **Patch (x.x.X)** - Bug fixes

### Release Checklist (Maintainers)

1. Update version in `package.json`
2. Update `CHANGELOG.md` with release notes
3. Create git tag: `git tag -a v2.3.0 -m "Release v2.3.0"`
4. Push tag: `git push origin v2.3.0`
5. GitHub Action builds and publishes Docker image
6. Create GitHub release with changelog

---

## Community

### Getting Help

- **Issues** - Open an issue for bugs or questions
- **Discussions** - Use GitHub Discussions for general questions
- **Documentation** - Check the docs first

### Staying Updated

- **Watch the repository** - Get notified of new releases
- **Read the CHANGELOG** - Stay informed of changes
- **Follow releases** - Subscribe to release notifications

---

## Project Structure

### Single-Bot Mode (`app/`)

Original functionality for running one bot per container:

```
app/
├── index.ts              # Entry point
├── types/index.d.ts      # Type definitions
└── utils/
    ├── bskyHandler.ts    # Bluesky API integration
    ├── rssHandler.ts     # RSS feed parsing
    ├── queueHandler.ts   # Post queue management
    └── dbHandler.ts      # File-based persistence
```

### Fleet Mode (`fleet/`)

Advanced multi-bot support:

```
fleet/
├── runFleet.ts           # Fleet entry point
├── authCoordinator.ts    # Staggered bot activation
├── botWorker.ts          # Per-bot worker
├── feedReader.ts         # RSS feed processing
├── bskyClient.ts         # Bluesky posting
├── configLoader.ts       # Config management
├── botStore.ts           # State persistence
└── sharedLimiters.ts     # Resource management
```

### Configuration

- `data/config.json` - Runtime configuration
- `.env` - Environment variables
- `config.example/` - Fleet mode config examples

---

## Advanced Topics

### Working with Fleet Mode

Fleet mode is more complex. If contributing to fleet:

1. Read `documentation/fleet.md` thoroughly
2. Understand the multi-bot architecture
3. Test with multiple bot configurations
4. Consider graceful shutdown scenarios

### Database Backend

Currently file-based. If adding database support:

- Maintain backward compatibility
- Make it optional (default to file-based)
- Support SQLite, PostgreSQL
- Add migration scripts

### Performance Considerations

- Avoid blocking the event loop
- Use streaming for large feeds
- Implement backpressure in queue
- Monitor memory usage in fleet mode

---

## License

By contributing to bsky.rss, you agree that your contributions will be licensed under the MIT License.

---

## Questions?

Not sure about something? Open an issue or discussion - we're here to help!

Thank you for contributing to bsky.rss! 🚀
