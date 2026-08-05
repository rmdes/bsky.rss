# Test Fixtures

This directory contains test data and mock responses for testing bsky.rss.

## Directory Structure

```
test-fixtures/
├── rss/              # Sample RSS feeds
│   └── sample-feed.xml
├── config/           # Test configuration files
│   └── test-config.json
└── mocks/            # Mock API responses
    ├── bluesky-responses.json
    └── open-graph-data.json
```

## Usage

### In Tests

```typescript
import {readFileSync} from 'fs';
import {join} from 'path';

// Load sample RSS feed
const sampleFeed = readFileSync(
  join(__dirname, '../test-fixtures/rss/sample-feed.xml'),
  'utf-8'
);

// Load mock Bluesky responses
const mockResponses = JSON.parse(
  readFileSync(
    join(__dirname, '../test-fixtures/mocks/bluesky-responses.json'),
    'utf-8'
  )
);
```

## Files

### RSS Feeds

**`sample-feed.xml`**
- Standard RSS 2.0 feed
- Includes 3 sample articles
- Tests HTML in descriptions
- Includes image enclosure
- Has dc:creator metadata

### Configuration

**`test-config.json`**
- Standard configuration for tests
- Matches production config structure
- Safe defaults for testing

### Mock Responses

**`bluesky-responses.json`**
- Mock responses from Bluesky API
- Includes success and error cases
- Covers rate limiting scenarios

**`open-graph-data.json`**
- Mock Open Graph metadata
- Standard and edge cases
- Malformed URL testing
- Missing image scenarios

## Adding New Fixtures

1. Keep fixtures minimal and focused
2. Document what each fixture tests
3. Use realistic but safe data
4. Include both success and error cases
5. Update this README when adding new fixtures

## Notes

- All URLs use `example.com` (reserved for examples)
- Timestamps use fixed dates for reproducibility
- Mock tokens/IDs use obviously fake values
- Images reference non-existent but valid URLs
