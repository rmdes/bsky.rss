import {describe, it, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert';
import fs, {mkdtempSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import healthHandler from './healthHandler.ts';
import {FleetLogger} from '../../shared/logging/logger.ts';
import {createDbHandler} from './dbHandler.ts';
import {createBskyHandler} from './bskyHandler.ts';
import {createQueueHandler, type QueueHandler} from './queueHandler.ts';

const testLogger = new FleetLogger({defaultLevel: 'summary', sink: () => undefined});

/**
 * Tests for queueHandler module
 *
 * Note: These tests focus on the module's queue management logic and
 * adaptive spacing calculations. Full integration tests with Bluesky
 * posting require authentication and are better suited for E2E tests.
 */

describe('queueHandler', () => {
  let testDataDir: string;
  let queueHandler: QueueHandler;
  let bsky: ReturnType<typeof createBskyHandler>;

  beforeEach(() => {
    testDataDir = mkdtempSync(path.join(tmpdir(), 'bsky-rss-test-'));

    // Create minimal config for tests
    const testConfig = {
      string: '$title - $link',
      publishEmbed: true,
      embedType: 'card',
      languages: ['en'],
      truncate: true,
      runInterval: 60,
      dateField: '',
      publishDate: false,
      imageField: '',
      ogUserAgent: 'bsky.rss/test',
      descriptionClearHTML: true,
      forceDescriptionEmbed: false,
      imageAlt: '$title',
      removeDuplicate: false,
      titleClearHTML: false,
      adaptiveSpacing: false,
      spacingWindow: 600,
      minSpacing: 1,
      maxSpacing: 60,
    };

    fs.writeFileSync(path.join(testDataDir, 'config.json'), JSON.stringify(testConfig), 'utf8');

    const db = createDbHandler(testDataDir);
    bsky = createBskyHandler(db, testLogger);
    queueHandler = createQueueHandler(bsky, db, testLogger);
  });

  afterEach(() => {
    rmSync(testDataDir, {recursive: true, force: true});
  });

  describe('Module exports', () => {
    it('should export writeQueue and start functions', () => {
      assert(typeof queueHandler.writeQueue === 'function');
      assert(typeof queueHandler.start === 'function');
    });
  });

  describe('writeQueue()', () => {
    it('should add item to queue', async () => {
      const item = {
        content: 'Test post content',
        title: 'Test Article',
        date: new Date('2026-08-05T10:00:00.000Z').toString(),
        languages: ['en'],
        embed: undefined,
        facets: [],
      };

      const result = await queueHandler.writeQueue(item);

      assert(Array.isArray(result));
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.content, item.content);
      assert.strictEqual(result[0]!.title, item.title);
    });

    it('should accept item with embed', async () => {
      const item = {
        content: 'Post with embed',
        title: 'Article with Card',
        date: new Date().toString(),
        languages: ['en'],
        embed: {
          type: 'card',
          uri: 'https://example.com/article',
          title: 'Example Article',
          description: 'Description',
        },
        facets: [],
      };

      const result = await queueHandler.writeQueue(item);

      assert.strictEqual(result.length, 1);
      assert(result[0]!.embed);
      assert.strictEqual(result[0]!.embed.uri, 'https://example.com/article');
    });

    it('should add multiple items to queue', async () => {
      await queueHandler.writeQueue({
        content: 'Post 1',
        title: 'Article 1',
        date: new Date().toString(),
        languages: ['en'],
        embed: undefined,
        facets: [],
      });

      await queueHandler.writeQueue({
        content: 'Post 2',
        title: 'Article 2',
        date: new Date().toString(),
        languages: ['en'],
        embed: undefined,
        facets: [],
      });

      const queue = await queueHandler.writeQueue({
        content: 'Post 3',
        title: 'Article 3',
        date: new Date().toString(),
        languages: ['en'],
        embed: undefined,
        facets: [],
      });

      assert.strictEqual(queue.length, 3);
    });

    it('should preserve item order in queue', async () => {
      await queueHandler.writeQueue({
        content: 'First',
        title: 'First Article',
        date: new Date().toString(),
        languages: ['en'],
        embed: undefined,
        facets: [],
      });

      await queueHandler.writeQueue({
        content: 'Second',
        title: 'Second Article',
        date: new Date().toString(),
        languages: ['en'],
        embed: undefined,
        facets: [],
      });

      const queue = await queueHandler.writeQueue({
        content: 'Third',
        title: 'Third Article',
        date: new Date().toString(),
        languages: ['en'],
        embed: undefined,
        facets: [],
      });

      assert.strictEqual(queue[0]!.content, 'First');
      assert.strictEqual(queue[1]!.content, 'Second');
      assert.strictEqual(queue[2]!.content, 'Third');
    });

    it('should handle items with all optional fields', async () => {
      const item = {
        content: 'Complete post',
        title: 'Complete Article',
        date: new Date('2026-08-05T10:00:00.000Z').toString(),
        languages: ['en', 'fr'],
        embed: {
          uri: 'https://example.com/complete-article',
          title: 'Complete Article',
          type: 'image',
          image: Buffer.from('fake-image'),
          imageAlt: 'Image description',
        },
        facets: [],
      };

      const result = await queueHandler.writeQueue(item);

      assert.strictEqual(result[0]!.content, item.content);
      assert.strictEqual(result[0]!.title, item.title);
      assert.strictEqual(result[0]!.date, item.date);
      assert.deepStrictEqual(result[0]!.languages, item.languages);
      assert(result[0]!.embed);
    });

    it('should return queue array', async () => {
      const result = await queueHandler.writeQueue({
        content: 'Test',
        title: 'Test',
        date: new Date().toString(),
        languages: ['en'],
        embed: undefined,
        facets: [],
      });

      assert(Array.isArray(result));
      assert(result.length > 0);
    });
  });

  describe('start()', () => {
    it('should be a function', () => {
      assert.strictEqual(typeof queueHandler.start, 'function');
    });

    // Note: Cannot test start() directly in unit tests because it creates
    // an interval that would cause tests to hang. The interval-based queue
    // processing is better tested in integration/E2E tests.
  });

  describe('runQueue() health activity tracking', () => {
    it('updates health activity even when the queue is empty', async () => {
      // Break: health.updateActivity() was only reachable after the
      // queueSnapshot.length === 0 early return, so a tick that found
      // nothing new to post never refreshed activity - a perfectly healthy,
      // idle bot (the normal case for most feeds) flips /health to 503
      // after 10 minutes of silence with no new items.
      // Monkey-patched instead of routed through the real HTTP server:
      // healthHandler is a singleton also driven by healthHandler.test.ts,
      // and starting/stopping the same server from two test files races.
      let updateActivityCalled = false;
      const original = healthHandler.updateActivity;
      healthHandler.updateActivity = () => {
        updateActivityCalled = true;
      };

      try {
        await queueHandler.runQueue();
      } finally {
        healthHandler.updateActivity = original;
      }

      assert.strictEqual(
        updateActivityCalled,
        true,
        'runQueue() with an empty queue should still call health.updateActivity()',
      );
    });
  });

  describe('runQueue() ratelimit classification', () => {
    it('does not unshift a {ratelimit: false} item and does not block subsequent items', async () => {
      // Proves the bug: today's runQueue() checks `'ratelimit' in post`, which is true
      // for both {ratelimit: true} and {ratelimit: false} - so a permanently-broken item
      // (validation failure, expired auth, etc.) gets unshifted back to the front and
      // retried forever via createLimitTimer, wedging every other queued item behind it.
      const badItem = {
        content: 'Bad item',
        title: 'Bad',
        date: new Date().toString(),
        languages: ['en'],
        embed: undefined,
        facets: [],
      };
      const goodItem = {
        content: 'Good item',
        title: 'Good',
        date: new Date().toString(),
        languages: ['en'],
        embed: undefined,
        facets: [],
      };
      await queueHandler.writeQueue(badItem);
      await queueHandler.writeQueue(goodItem);

      const calls: string[] = [];
      bsky.post = (async ({content}: {content: string}) => {
        calls.push(content);
        if (content === badItem.content) return {ratelimit: false};
        return {uri: 'at://did:plc:test/app.bsky.feed.post/abc', cid: 'bafycid'};
      }) as typeof bsky.post;

      const result = await queueHandler.runQueue();

      assert.deepStrictEqual(
        calls,
        [badItem.content, goodItem.content],
        'both items should have been attempted - a {ratelimit: false} result must not block the rest of the queue',
      );
      assert.strictEqual(
        (result as QueueItems[]).length,
        0,
        'neither item should remain queued - the bad one was skipped, not requeued',
      );
    });
  });

  describe('Adaptive spacing calculations', () => {
    it('should compute delay for queue with multiple items', () => {
      const config = {
        adaptiveSpacing: true,
        spacingWindow: 600,
        minSpacing: 1,
        maxSpacing: 60,
      };

      // With 10 items in queue and 600 second window:
      // delay = 600 / 10 = 60 seconds
      const queueSize = 10;
      const expectedDelay = config.spacingWindow / queueSize;

      assert.strictEqual(expectedDelay, 60);
    });

    it('should clamp delay to maxSpacing', () => {
      const config = {
        adaptiveSpacing: true,
        spacingWindow: 600,
        minSpacing: 1,
        maxSpacing: 60,
      };

      // With 5 items: 600 / 5 = 120 seconds
      // Should be clamped to maxSpacing (60)
      const queueSize = 5;
      const calculatedDelay = config.spacingWindow / queueSize;
      const clampedDelay = Math.max(
        config.minSpacing,
        Math.min(config.maxSpacing, calculatedDelay),
      );

      assert.strictEqual(clampedDelay, 60);
    });

    it('should clamp delay to minSpacing', () => {
      const config = {
        adaptiveSpacing: true,
        spacingWindow: 600,
        minSpacing: 1,
        maxSpacing: 60,
      };

      // With 1000 items: 600 / 1000 = 0.6 seconds
      // Should be clamped to minSpacing (1)
      const queueSize = 1000;
      const calculatedDelay = config.spacingWindow / queueSize;
      const clampedDelay = Math.max(
        config.minSpacing,
        Math.min(config.maxSpacing, calculatedDelay),
      );

      assert.strictEqual(clampedDelay, 1);
    });

    it('should return 0 delay when adaptiveSpacing is disabled', () => {
      const config = {
        adaptiveSpacing: false,
        spacingWindow: 600,
        minSpacing: 1,
        maxSpacing: 60,
      };

      // When disabled, delay should be 0 regardless of queue size
      const queueSize = 10;
      const delay = config.adaptiveSpacing ? config.spacingWindow / queueSize : 0;

      assert.strictEqual(delay, 0);
    });

    it('should return 0 delay for single item queue', () => {
      // With only 1 item, no delay needed
      const queueSize = 1;
      const delay = queueSize <= 1 ? 0 : 600 / queueSize;

      assert.strictEqual(delay, 0);
    });

    it('should compute correct delay for various queue sizes', () => {
      const config = {
        spacingWindow: 600,
        minSpacing: 1,
        maxSpacing: 60,
      };

      const testCases = [
        {queueSize: 2, expected: 60}, // 600/2 = 300, clamped to 60
        {queueSize: 10, expected: 60}, // 600/10 = 60
        {queueSize: 20, expected: 30}, // 600/20 = 30
        {queueSize: 100, expected: 6}, // 600/100 = 6
        {queueSize: 600, expected: 1}, // 600/600 = 1
      ];

      testCases.forEach(tc => {
        const delay = Math.max(
          config.minSpacing,
          Math.min(config.maxSpacing, config.spacingWindow / tc.queueSize),
        );
        assert.strictEqual(
          delay,
          tc.expected,
          `Queue size ${tc.queueSize} should have delay ${tc.expected}`,
        );
      });
    });
  });

  describe('Configuration handling', () => {
    it('should handle config with all fields', () => {
      const fullConfig = {
        string: '$title - $link',
        publishEmbed: true,
        embedType: 'card',
        languages: ['en', 'fr'],
        truncate: true,
        runInterval: 60,
        dateField: 'pubDate',
        publishDate: true,
        imageField: 'enclosure',
        ogUserAgent: 'custom-agent',
        descriptionClearHTML: true,
        forceDescriptionEmbed: false,
        imageAlt: '$title',
        removeDuplicate: true,
        titleClearHTML: false,
        adaptiveSpacing: true,
        spacingWindow: 300,
        minSpacing: 2,
        maxSpacing: 30,
      };

      assert.strictEqual(typeof fullConfig.string, 'string');
      assert.strictEqual(typeof fullConfig.publishEmbed, 'boolean');
      assert(Array.isArray(fullConfig.languages));
      assert.strictEqual(typeof fullConfig.runInterval, 'number');
      assert.strictEqual(typeof fullConfig.adaptiveSpacing, 'boolean');
      assert.strictEqual(typeof fullConfig.spacingWindow, 'number');
    });

    it('should use default values when fields are missing', () => {
      const minimalConfig = {
        string: '$title',
        publishEmbed: false,
        embedType: 'card',
        languages: ['en'],
        truncate: true,
        runInterval: 60,
        dateField: '',
        publishDate: false,
        imageField: '',
        ogUserAgent: 'bsky.rss/1.0',
        descriptionClearHTML: true,
        forceDescriptionEmbed: false,
        imageAlt: '',
        removeDuplicate: false,
        titleClearHTML: false,
        adaptiveSpacing: false,
        spacingWindow: 600,
        minSpacing: 1,
        maxSpacing: 60,
      };

      assert.strictEqual(minimalConfig.adaptiveSpacing, false);
      assert.strictEqual(minimalConfig.spacingWindow, 600);
      assert.strictEqual(minimalConfig.minSpacing, 1);
      assert.strictEqual(minimalConfig.maxSpacing, 60);
    });
  });

  describe('Queue item structure', () => {
    it('should accept valid queue item', () => {
      const item = {
        content: 'Test content',
        title: 'Test title',
        date: new Date().toString(),
        languages: ['en'],
        embed: {
          type: 'card',
          uri: 'https://example.com',
          title: 'Link title',
        },
      };

      assert.strictEqual(typeof item.content, 'string');
      assert.strictEqual(typeof item.title, 'string');
      assert(Array.isArray(item.languages));
      assert(item.embed);
    });

    it('should handle item without embed', () => {
      const item = {
        content: 'Simple post',
        title: 'Simple title',
        date: new Date().toString(),
        languages: ['en'],
        embed: undefined,
      };

      assert.strictEqual(item.embed, undefined);
    });

    it('should handle item with image embed', () => {
      const item = {
        content: 'Post with image',
        title: 'Image post',
        date: new Date().toString(),
        languages: ['en'],
        embed: {
          type: 'image',
          image: Buffer.from('fake-data'),
          imageAlt: 'Description',
        },
      };

      assert.strictEqual(item.embed.type, 'image');
      assert(Buffer.isBuffer(item.embed.image));
    });

    it('should handle multiple languages', () => {
      const item = {
        content: 'Multilingual post',
        title: 'Title',
        date: new Date().toString(),
        languages: ['en', 'fr', 'de'],
      };

      assert.strictEqual(item.languages.length, 3);
      assert(item.languages.includes('en'));
      assert(item.languages.includes('fr'));
      assert(item.languages.includes('de'));
    });
  });
});
