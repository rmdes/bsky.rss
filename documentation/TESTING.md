# Testing Guide

This guide explains how to run tests, write tests, and follow testing best practices for bsky.rss.

---

## Table of Contents

- [Running Tests](#running-tests)
- [Writing Tests](#writing-tests)
- [Test Structure](#test-structure)
- [Testing Patterns](#testing-patterns)
- [Mocking](#mocking)
- [Test Fixtures](#test-fixtures)
- [Debugging Tests](#debugging-tests)
- [CI/CD](#cicd)
- [Best Practices](#best-practices)

---

## Running Tests

### All Tests

```bash
# Run all tests
yarn test

# Run with coverage
yarn test:coverage

# Run in watch mode (re-runs on file changes)
yarn test:watch
```

### Specific Test Suites

```bash
# Run only app tests
yarn test:app

# Run only fleet tests
yarn test:fleet

# Run a specific test file
yarn tsx --test app/utils/bskyHandler.test.ts
```

### In VS Code

1. Open a test file
2. Click "Run" above a test function
3. Or use the Debug panel → "Debug Current Test File"

---

## Writing Tests

### Test File Structure

Tests are co-located with source files:

```
app/utils/
├── bskyHandler.ts
└── bskyHandler.test.ts
```

### Basic Test Template

```typescript
import {describe, it, before, after} from 'node:test';
import assert from 'node:assert';

describe('ModuleName', () => {
  // Setup runs once before all tests
  before(() => {
    // Initialize test data
  });

  // Cleanup runs once after all tests
  after(() => {
    // Clean up resources
  });

  it('should do something specific', () => {
    // Arrange
    const input = 'test';
    
    // Act
    const result = functionToTest(input);
    
    // Assert
    assert.strictEqual(result, 'expected');
  });

  it('should handle edge cases', () => {
    assert.throws(() => {
      functionToTest(null);
    }, /Error message/);
  });
});
```

### Async Tests

```typescript
it('should handle async operations', async () => {
  const result = await asyncFunction();
  assert.strictEqual(result.status, 'success');
});
```

---

## Test Structure

### Arrange-Act-Assert Pattern

Organize tests clearly:

```typescript
it('should format RSS item into post text', () => {
  // Arrange: Set up test data
  const item = {
    title: 'Test Article',
    link: 'https://example.com/article',
    description: 'Test description'
  };
  const template = '$title - $link';

  // Act: Execute the function
  const result = parseString(template, item);

  // Assert: Verify the result
  assert.strictEqual(result, 'Test Article - https://example.com/article');
});
```

### Descriptive Test Names

Use clear, specific test names:

```typescript
// ❌ Bad: Vague
it('should work', () => { });

// ✅ Good: Specific
it('should replace $title variable with RSS item title', () => { });

// ✅ Good: Describes behavior
it('should throw error when RSS item is missing title', () => { });

// ✅ Good: Describes edge case
it('should handle malformed og:url protocol (https// → https://)', () => { });
```

---

## Testing Patterns

### Testing Pure Functions

```typescript
describe('parseString', () => {
  it('should replace multiple variables', () => {
    const item = {title: 'Title', link: 'https://link.com'};
    const result = parseString('$title - $link', item);
    assert.strictEqual(result, 'Title - https://link.com');
  });

  it('should handle missing variables', () => {
    const item = {title: 'Title'};
    const result = parseString('$title - $link', item);
    assert.strictEqual(result, 'Title - ');
  });
});
```

### Testing Async Functions

```typescript
describe('fetchRSSFeed', () => {
  it('should parse valid RSS feed', async () => {
    const feed = await fetchRSSFeed('https://example.com/feed.xml');
    assert(Array.isArray(feed.items));
    assert(feed.items.length > 0);
  });

  it('should handle network errors gracefully', async () => {
    await assert.rejects(
      async () => await fetchRSSFeed('https://invalid-url'),
      /Network error/
    );
  });
});
```

### Testing Error Handling

```typescript
describe('queueHandler', () => {
  it('should handle rate limits correctly', async () => {
    const handler = new QueueHandler();
    handler.rateLimited = true;

    const result = await handler.runQueue();
    
    assert.strictEqual(result.ratelimit, true);
    assert.strictEqual(handler.queueSnapshot.length, 0);
  });
});
```

---

## Mocking

### File System Mocks

```typescript
import {readFileSync} from 'fs';

// Mock file system for tests
const mockFS = {
  'config.json': JSON.stringify({string: '$title'}),
  'last.txt': '2026-08-01T00:00:00Z'
};

// Use in tests
const config = JSON.parse(mockFS['config.json']);
```

### HTTP Request Mocks

```typescript
// Mock axios for HTTP requests
const mockAxios = {
  get: async (url: string) => {
    if (url.includes('feed.xml')) {
      return {data: sampleRSSFeed};
    }
    throw new Error('Not found');
  }
};
```

### Bluesky API Mocks

```typescript
import mockResponses from '../test-fixtures/mocks/bluesky-responses.json';

const mockBskyClient = {
  login: async () => mockResponses.sessionCreate.success,
  post: async () => mockResponses.createRecord.success,
  uploadBlob: async () => mockResponses.uploadBlob.success
};
```

---

## Test Fixtures

Test fixtures are located in `test-fixtures/`:

### Loading Fixtures

```typescript
import {readFileSync} from 'fs';
import {join} from 'path';

// Load sample RSS feed
const sampleFeed = readFileSync(
  join(__dirname, '../test-fixtures/rss/sample-feed.xml'),
  'utf-8'
);

// Load mock responses
const mocks = JSON.parse(
  readFileSync(
    join(__dirname, '../test-fixtures/mocks/bluesky-responses.json'),
    'utf-8'
  )
);
```

### Available Fixtures

- **RSS Feeds**: `test-fixtures/rss/sample-feed.xml`
- **Config**: `test-fixtures/config/test-config.json`
- **Bluesky Mocks**: `test-fixtures/mocks/bluesky-responses.json`
- **Open Graph Mocks**: `test-fixtures/mocks/open-graph-data.json`

See [test-fixtures/README.md](../test-fixtures/README.md) for details.

---

## Debugging Tests

### VS Code Debugger

1. Set breakpoints in test file
2. Press F5 or use Debug panel
3. Select "Debug Current Test File"
4. Step through code with F10/F11

### Console Debugging

```typescript
it('should debug values', () => {
  const value = functionToTest();
  console.log('Debug value:', value);
  assert.strictEqual(value, expected);
});
```

### Node Inspector

```bash
# Run tests with inspector
node --inspect-brk node_modules/.bin/tsx --test app/utils/*.test.ts

# Then open chrome://inspect in Chrome
```

---

## CI/CD

### GitHub Actions

Tests run automatically on:
- Every pull request
- Every push to main

See `.github/workflows/pr-checks.yml` for configuration.

### Local Pre-Commit

Run tests before committing:

```bash
# Manual
yarn test && git commit

# Or add to git hooks (future improvement)
```

---

## Best Practices

### 1. Test Behavior, Not Implementation

```typescript
// ❌ Bad: Tests implementation details
it('should call parseString function', () => {
  const spy = sinon.spy(parseString);
  processItem(item);
  assert(spy.called);
});

// ✅ Good: Tests behavior
it('should format item title into post text', () => {
  const result = processItem({title: 'Test'});
  assert(result.includes('Test'));
});
```

### 2. Keep Tests Independent

```typescript
// ❌ Bad: Tests depend on each other
let sharedState;

it('should set state', () => {
  sharedState = 'value';
});

it('should use state', () => {
  assert.strictEqual(sharedState, 'value'); // Fails if run alone
});

// ✅ Good: Each test is independent
it('should process item', () => {
  const state = 'value';
  assert.strictEqual(process(state), expected);
});
```

### 3. Test Edge Cases

```typescript
describe('parseString', () => {
  it('should handle normal case', () => { /* ... */ });
  it('should handle empty string', () => { /* ... */ });
  it('should handle null values', () => { /* ... */ });
  it('should handle special characters', () => { /* ... */ });
  it('should handle very long strings', () => { /* ... */ });
});
```

### 4. Use Meaningful Assertions

```typescript
// ❌ Bad: Generic assertion
assert(result);

// ✅ Good: Specific assertion
assert.strictEqual(result.status, 'success');
assert(result.data.length > 0);
assert.match(result.message, /completed successfully/);
```

### 5. Clean Up Resources

```typescript
describe('FileHandler', () => {
  let tempFile: string;

  before(() => {
    tempFile = createTempFile();
  });

  after(() => {
    // Always clean up
    if (tempFile) {
      fs.unlinkSync(tempFile);
    }
  });

  it('should read file', () => {
    // Test uses tempFile
  });
});
```

### 6. Test One Thing Per Test

```typescript
// ❌ Bad: Tests multiple things
it('should process item and save to database and send notification', () => {
  // Too much in one test
});

// ✅ Good: Focused tests
it('should process RSS item into post format', () => { });
it('should save processed item to queue', () => { });
it('should send notification on queue addition', () => { });
```

---

## Test Coverage Goals

Current coverage by module:

- **Fleet Mode**: ~95% coverage ✅
- **Single-Bot Mode**: 0% coverage ❌ (needs tests!)

### Target Coverage

- **Minimum**: 80% line coverage
- **Goal**: 90%+ line coverage
- **Critical paths**: 100% coverage

Run coverage report:

```bash
yarn test:coverage
```

---

## Common Testing Scenarios

### Testing RSS Parsing

```typescript
it('should parse RSS feed with HTML entities', () => {
  const feed = `
    <item>
      <title>Test &amp; Article</title>
      <description>Quote: &quot;test&quot;</description>
    </item>
  `;
  
  const result = parseRSS(feed);
  assert.strictEqual(result.title, 'Test & Article');
  assert.strictEqual(result.description, 'Quote: "test"');
});
```

### Testing Rate Limits

```typescript
it('should respect rate limit and requeue item', async () => {
  const queue = new QueueHandler();
  queue.add({title: 'Test', link: 'https://example.com'});
  
  // Simulate rate limit
  mockBskyAPI.post = () => ({ratelimit: true, retryAfter: 30});
  
  await queue.runQueue();
  
  assert(queue.rateLimited);
  assert.strictEqual(queue.queue.length, 1); // Item requeued
});
```

### Testing File Persistence

```typescript
it('should save and load config from file', () => {
  const config = {string: '$title'};
  
  saveConfig(config);
  const loaded = loadConfig();
  
  assert.deepStrictEqual(loaded, config);
});
```

---

## Getting Help

- **Questions**: Open an issue or discussion
- **Examples**: Check `fleet/*.test.ts` for comprehensive examples
- **Debugging**: See [DEBUGGING.md](DEBUGGING.md) (future)

---

## Contributing Tests

See [CONTRIBUTING.md](../CONTRIBUTING.md) for:
- PR requirements
- Test coverage expectations
- Code review process

---

**Remember**: Good tests make confident developers! 🧪
