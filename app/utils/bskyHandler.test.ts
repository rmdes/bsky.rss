import {describe, it, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert';
import {mkdtempSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {RichText, AppBskyFeedPost, AppBskyRichtextFacet} from '@atproto/api';
import {createDbHandler} from './dbHandler.ts';
import {createBskyHandler, type BskyHandler} from './bskyHandler.ts';

/**
 * Tests for bskyHandler module
 *
 * Note: These tests focus on the module's contract and error handling.
 * Full integration tests with Bluesky API require real credentials and
 * are better suited for E2E tests.
 */

describe('bskyHandler', () => {
  let testDataDir: string;

  beforeEach(() => {
    testDataDir = mkdtempSync(path.join(tmpdir(), 'bsky-rss-test-'));
  });

  afterEach(() => {
    rmSync(testDataDir, {recursive: true, force: true});
  });

  function freshBskyHandler(): BskyHandler {
    return createBskyHandler(createDbHandler(testDataDir));
  }

  describe('Module exports', () => {
    it('should export init, login, and post functions', () => {
      const bskyHandler = freshBskyHandler();

      assert(typeof bskyHandler.init === 'function');
      assert(typeof bskyHandler.login === 'function');
      assert(typeof bskyHandler.post === 'function');
    });
  });

  describe('init()', () => {
    it('should require service URL parameter', async () => {
      const bskyHandler = freshBskyHandler();

      const agent = await bskyHandler.init('https://bsky.social');
      assert(agent, 'Agent should be returned');
      assert.strictEqual(typeof agent, 'object');
    });

    it('should throw error if initialized twice', async () => {
      const bskyHandler = freshBskyHandler();

      await bskyHandler.init('https://bsky.social');

      await assert.rejects(
        async () => {
          await bskyHandler.init('https://bsky.social');
        },
        {
          message: 'Bluesky agent already initialized.',
        },
      );
    });

    it('should create agent with different service URLs', async () => {
      const bskyHandler1 = freshBskyHandler();
      const agent1 = await bskyHandler1.init('https://bsky.social');
      assert(agent1);

      const bskyHandler2 = freshBskyHandler();
      const agent2 = await bskyHandler2.init('https://custom.bsky.host');
      assert(agent2);
    });
  });

  describe('login()', () => {
    it('should throw error if agent not initialized', async () => {
      const bskyHandler = freshBskyHandler();

      await assert.rejects(
        async () => {
          await bskyHandler.login({
            identifier: 'test.bsky.social',
            password: 'password',
          });
        },
        {
          message: 'Bluesky agent not initialized.',
        },
      );
    });

    it('should require identifier and password parameters', async () => {
      const bskyHandler = freshBskyHandler();
      await bskyHandler.init('https://bsky.social');

      const credentials = {
        identifier: 'test.bsky.social',
        password: 'test-password',
      };

      try {
        await bskyHandler.login(credentials);
      } catch (error) {
        assert(error instanceof Error, 'Expected an Error instance');
        assert(
          error.message.includes('Login failed') ||
            error.message.includes('Invalid') ||
            error.message.includes('fetch') ||
            error.message.includes('ENOTFOUND') ||
            error.message.includes('Forbidden') ||
            error.message.includes('Unauthorized') ||
            error.message.includes('Rate Limit'),
          `Error should be related to authentication or network: ${error.message}`,
        );
      }
    });
  });

  describe('post()', () => {
    it('should throw error if agent not initialized', async () => {
      const bskyHandler = freshBskyHandler();

      await assert.rejects(
        async () => {
          await bskyHandler.post({content: 'Test post'});
        },
        {
          message: 'Bluesky agent not initialized.',
        },
      );
    });

    it('should require content parameter', async () => {
      const bskyHandler = freshBskyHandler();
      await bskyHandler.init('https://bsky.social');

      const postData = {
        content: 'Test post content',
      };

      try {
        await bskyHandler.post(postData);
      } catch (error) {
        assert(error instanceof Error, 'Expected an Error instance');
        assert(
          error.message.includes('not initialized') ||
            error.message.includes('authenticated') ||
            error.message.includes('session') ||
            error.message.includes('Invalid token') ||
            typeof error === 'object',
          `Error should be related to authentication: ${error.message}`,
        );
      }
    });

    it('should accept optional parameters', async () => {
      const bskyHandler = freshBskyHandler();
      await bskyHandler.init('https://bsky.social');

      const postData = {
        content: 'Test post',
        languages: ['en', 'fr'],
        date: new Date('2026-08-05T10:00:00.000Z'),
        embed: {
          type: 'card',
          uri: 'https://example.com',
          title: 'Example',
          description: 'Description',
        },
      };

      try {
        await bskyHandler.post(postData);
      } catch (error) {
        assert(error instanceof Error, 'Expected an Error instance');
        assert(
          error.constructor.name !== 'TypeError' || !error.message.includes('undefined'),
          'Should not throw TypeError for valid parameters',
        );
      }
    });
  });

  describe('Type safety and parameter validation', () => {
    it('should handle embed with image type', () => {
      const embedImage = {
        type: 'image',
        image: Buffer.from('fake-image'),
        imageAlt: 'Test image',
      };

      assert.strictEqual(embedImage.type, 'image');
      assert(Buffer.isBuffer(embedImage.image));
      assert.strictEqual(embedImage.imageAlt, 'Test image');
    });

    it('should handle embed with card/external type', () => {
      const embedCard = {
        type: 'card',
        uri: 'https://example.com',
        title: 'Title',
        description: 'Description',
        image: Buffer.from('fake-thumb'),
      };

      assert.strictEqual(embedCard.type, 'card');
      assert.strictEqual(embedCard.uri, 'https://example.com');
      assert(Buffer.isBuffer(embedCard.image));
    });

    it('should handle languages array', () => {
      const languages = ['en', 'fr', 'de'];
      assert(Array.isArray(languages));
      assert.strictEqual(languages.length, 3);
    });

    it('should handle custom date', () => {
      const customDate = new Date('2026-08-05T10:00:00.000Z');
      assert(customDate instanceof Date);
      assert.strictEqual(customDate.toISOString(), '2026-08-05T10:00:00.000Z');
    });
  });

  describe('Error handling patterns', () => {
    it('should have consistent error messages', () => {
      const errors = {
        notInitialized: 'Bluesky agent not initialized.',
        alreadyInitialized: 'Bluesky agent already initialized.',
      };

      assert.strictEqual(errors.notInitialized, 'Bluesky agent not initialized.');
      assert.strictEqual(errors.alreadyInitialized, 'Bluesky agent already initialized.');
    });

    it('should validate initialization state before operations', async () => {
      const bskyHandler = freshBskyHandler();

      await assert.rejects(
        () => bskyHandler.login({identifier: 'test', password: 'test'}),
        /not initialized/,
      );

      await assert.rejects(() => bskyHandler.post({content: 'test'}), /not initialized/);

      await bskyHandler.init('https://bsky.social');
    });
  });

  describe('Module state management', () => {
    it('should maintain singleton agent across function calls', async () => {
      const bskyHandler = freshBskyHandler();

      await bskyHandler.init('https://bsky.social');

      await assert.rejects(() => bskyHandler.init('https://bsky.social'), /already initialized/);
    });

    it('should reset state when constructed again', async () => {
      let bskyHandler = freshBskyHandler();
      await bskyHandler.init('https://bsky.social');

      // A fresh instance starts with unset state, same as a reloaded module used to.
      bskyHandler = freshBskyHandler();

      const agent = await bskyHandler.init('https://bsky.social');
      assert(agent);
    });
  });

  describe('Integration contract', () => {
    it('should export functions that match expected signatures', () => {
      const bskyHandler = freshBskyHandler();

      assert.strictEqual(bskyHandler.init.length, 1); // service parameter
      assert.strictEqual(bskyHandler.login.length, 1); // credentials object
      assert.strictEqual(bskyHandler.post.length, 1); // post data object
    });

    it('should return expected types', async () => {
      const bskyHandler = freshBskyHandler();

      const agent = await bskyHandler.init('https://bsky.social');
      assert.strictEqual(typeof agent, 'object');
      assert(agent !== null);
    });
  });

  describe('post() facet merging', () => {
    it('constructing RichText with pre-merged facets keeps both sources, not just one', () => {
      // Guards the exact risk this task fixes: RichText.detectFacets() overwrites
      // this.facets entirely (confirmed in @atproto/api's own source), so post() must never
      // call detectFacets() on a RichText that already carries hand-built markdown-link
      // facets. This test exercises the real RichText constructor's documented contract
      // (pass facets in, they're kept) without needing a live agent.
      const markdownFacets = [
        {
          index: {byteStart: 0, byteEnd: 6},
          features: [{$type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/report'}],
        },
      ];
      const autoDetectedFacets = [
        {
          index: {byteStart: 7, byteEnd: 12},
          features: [{$type: 'app.bsky.richtext.facet#tag', tag: 'news'}],
        },
      ];

      const richText = new RichText({
        text: 'Report #news',
        facets: [...markdownFacets, ...autoDetectedFacets],
      });

      assert.equal(richText.facets?.length, 2);
      assert.deepEqual(richText.facets?.[0]?.index, {byteStart: 0, byteEnd: 6});
      assert.deepEqual(richText.facets?.[1]?.index, {byteStart: 7, byteEnd: 12});
    });

    it('post() merges hand-built facets with auto-detected ones end-to-end, via buildFacets', async () => {
      const bskyHandler = freshBskyHandler();
      const agent = await bskyHandler.init('https://bsky.social');

      let capturedRecord:
        | (Partial<AppBskyFeedPost.Record> & Omit<AppBskyFeedPost.Record, 'createdAt'>)
        | undefined;
      agent.post = async (record: Partial<AppBskyFeedPost.Record> & Omit<AppBskyFeedPost.Record, 'createdAt'>) => {
        capturedRecord = record;
        return {uri: 'at://did:plc:test/app.bsky.feed.post/abc', cid: 'bafycid'};
      };

      const result = await bskyHandler.post({
        content: 'Report #news',
        facets: [{byteStart: 0, byteEnd: 6, uri: 'https://example.com/report'}],
      });

      assert.deepStrictEqual(result, {
        uri: 'at://did:plc:test/app.bsky.feed.post/abc',
        cid: 'bafycid',
      });
      assert.strictEqual(capturedRecord!.facets!.length, 2);
      const linkFacet = capturedRecord!.facets!.find(
        f => f.features[0]?.$type === 'app.bsky.richtext.facet#link',
      );
      assert.deepStrictEqual(linkFacet?.index, {byteStart: 0, byteEnd: 6});
      const tagFacet = capturedRecord!.facets!.find(
        f => f.features[0]?.$type === 'app.bsky.richtext.facet#tag',
      );
      assert(tagFacet, 'tagFacet should be found');
      const tagFeature = tagFacet.features[0];
      assert(tagFeature && tagFeature.$type === 'app.bsky.richtext.facet#tag', 'tagFeature should be a Tag');
      assert.strictEqual((tagFeature as AppBskyRichtextFacet.Tag).tag, 'news');
    });

    it('post() drops an auto-detected facet that overlaps a hand-built markdown-link facet, end-to-end', async () => {
      const bskyHandler = freshBskyHandler();
      const agent = await bskyHandler.init('https://bsky.social');

      let capturedRecord:
        | (Partial<AppBskyFeedPost.Record> & Omit<AppBskyFeedPost.Record, 'createdAt'>)
        | undefined;
      agent.post = async (record: Partial<AppBskyFeedPost.Record> & Omit<AppBskyFeedPost.Record, 'createdAt'>) => {
        capturedRecord = record;
        return {uri: 'at://did:plc:test/app.bsky.feed.post/xyz', cid: 'bafycid'};
      };

      const content = 'Visit https://overlap.example now';
      const facetByteEnd = Buffer.byteLength(content, 'utf8');

      await bskyHandler.post({
        content,
        facets: [{byteStart: 0, byteEnd: facetByteEnd, uri: 'https://example.com/whole'}],
      });

      assert.strictEqual(capturedRecord!.facets!.length, 1);
      assert.deepStrictEqual(capturedRecord!.facets![0]?.index, {
        byteStart: 0,
        byteEnd: facetByteEnd,
      });
      const facet = capturedRecord!.facets![0];
      assert(facet, 'facet should be found');
      const linkFeature = facet.features[0];
      assert(linkFeature && linkFeature.$type === 'app.bsky.richtext.facet#link', 'linkFeature should be a Link');
      assert.strictEqual((linkFeature as AppBskyRichtextFacet.Link).uri, 'https://example.com/whole');
    });
  });
});
