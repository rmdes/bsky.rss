import {describe, it, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert';
import {mkdtempSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {RichText, AppBskyFeedPost, AppBskyRichtextFacet} from '@atproto/api';
import {XRPCError, ResponseType} from '@atproto/xrpc';
import {FleetLogger} from '../../shared/logging/logger.ts';
import {createDbHandler} from './dbHandler.ts';
import {createBskyHandler, type BskyHandler} from './bskyHandler.ts';

// Mirrors fleet/bskyClient.test.ts's makeXRPCError helper - headers on a real XRPCError
// instance, exactly as @atproto/xrpc constructs them from a live response.
function makeXRPCError(status: number, headers?: Record<string, string>): XRPCError {
  const err = new XRPCError(status, 'TestError', 'test error');
  err.headers = headers;
  return err;
}

const testLogger = new FleetLogger({defaultLevel: 'summary', sink: () => undefined});

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
    return createBskyHandler(createDbHandler(testDataDir), testLogger);
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

    it('passes identifier and password through to agent.login when no persisted session exists, and returns its result', async () => {
      const bskyHandler = freshBskyHandler();
      const agent = await bskyHandler.init('https://bsky.social');

      let capturedCredentials: {identifier: string; password: string} | undefined;
      agent.login = (async (params: {identifier: string; password: string}) => {
        capturedCredentials = params;
        return {success: true, data: {handle: 'test.bsky.social'}};
      }) as typeof agent.login;

      const credentials = {identifier: 'test.bsky.social', password: 'test-password'};
      const result = await bskyHandler.login(credentials);

      assert.deepStrictEqual(capturedCredentials, credentials);
      assert.deepStrictEqual(result, {success: true, data: {handle: 'test.bsky.social'}});
    });

    it('throws when agent.login reports failure (no persisted session, bad credentials)', async () => {
      const bskyHandler = freshBskyHandler();
      const agent = await bskyHandler.init('https://bsky.social');

      agent.login = (async () => ({success: false})) as unknown as typeof agent.login;

      await assert.rejects(
        () => bskyHandler.login({identifier: 'test.bsky.social', password: 'wrong-password'}),
        {message: 'Login failed (auth via login/password)'},
      );
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

    it('passes the content parameter through into the real post record', async () => {
      const bskyHandler = freshBskyHandler();
      const agent = await bskyHandler.init('https://bsky.social');

      let capturedRecord:
        | (Partial<AppBskyFeedPost.Record> & Omit<AppBskyFeedPost.Record, 'createdAt'>)
        | undefined;
      agent.post = async (
        record: Partial<AppBskyFeedPost.Record> & Omit<AppBskyFeedPost.Record, 'createdAt'>,
      ) => {
        capturedRecord = record;
        return {uri: 'at://did:plc:test/app.bsky.feed.post/content', cid: 'bafycid'};
      };

      const result = await bskyHandler.post({content: 'Test post content'});

      assert.strictEqual(capturedRecord!.text, 'Test post content');
      assert.deepStrictEqual(result, {
        uri: 'at://did:plc:test/app.bsky.feed.post/content',
        cid: 'bafycid',
      });
    });

    it('threads optional parameters (languages, date, embed) into the real post record', async () => {
      const bskyHandler = freshBskyHandler();
      const agent = await bskyHandler.init('https://bsky.social');

      let capturedRecord:
        | (Partial<AppBskyFeedPost.Record> & Omit<AppBskyFeedPost.Record, 'createdAt'>)
        | undefined;
      agent.post = async (
        record: Partial<AppBskyFeedPost.Record> & Omit<AppBskyFeedPost.Record, 'createdAt'>,
      ) => {
        capturedRecord = record;
        return {uri: 'at://did:plc:test/app.bsky.feed.post/opts', cid: 'bafycid'};
      };

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

      const result = await bskyHandler.post(postData);

      assert.deepStrictEqual(capturedRecord!.langs, ['en', 'fr']);
      assert.strictEqual(capturedRecord!.createdAt, '2026-08-05T10:00:00.000Z');
      assert.deepStrictEqual(capturedRecord!.embed, {
        $type: 'app.bsky.embed.external',
        external: {
          uri: 'https://example.com',
          title: 'Example',
          description: 'Description',
          thumb: undefined,
        },
      });
      assert.deepStrictEqual(result, {
        uri: 'at://did:plc:test/app.bsky.feed.post/opts',
        cid: 'bafycid',
      });
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
      agent.post = async (
        record: Partial<AppBskyFeedPost.Record> & Omit<AppBskyFeedPost.Record, 'createdAt'>,
      ) => {
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
      assert(tagFeature && AppBskyRichtextFacet.isTag(tagFeature), 'tagFeature should be a Tag');
      assert.strictEqual(tagFeature.tag, 'news');
    });

    it('post() drops an auto-detected facet that overlaps a hand-built markdown-link facet, end-to-end', async () => {
      const bskyHandler = freshBskyHandler();
      const agent = await bskyHandler.init('https://bsky.social');

      let capturedRecord:
        | (Partial<AppBskyFeedPost.Record> & Omit<AppBskyFeedPost.Record, 'createdAt'>)
        | undefined;
      agent.post = async (
        record: Partial<AppBskyFeedPost.Record> & Omit<AppBskyFeedPost.Record, 'createdAt'>,
      ) => {
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
      assert(
        linkFeature && AppBskyRichtextFacet.isLink(linkFeature),
        'linkFeature should be a Link',
      );
      assert.strictEqual(linkFeature.uri, 'https://example.com/whole');
    });
  });

  describe('post() rate-limit classification', () => {
    // Ports fleet/bskyClient.ts's classifyPostError tests to bskyHandler's own
    // union-return shape. Two real bugs this proves against the current code:
    // (1) only a 504 (UpstreamTimeout) is recognized, never the actual 429
    // (RateLimitExceeded); (2) the 'Retry-After' header lookup can never match
    // because @atproto/xrpc always lowercases header names to 'retry-after'.
    async function postWithAgentError(error: unknown) {
      const bskyHandler = freshBskyHandler();
      const agent = await bskyHandler.init('https://bsky.social');
      agent.post = async () => {
        throw error;
      };
      return bskyHandler.post({content: 'Test post'});
    }

    it('classifies a 429 with a lowercase retry-after header as a rate limit', async () => {
      const result = await postWithAgentError(
        makeXRPCError(ResponseType.RateLimitExceeded, {'retry-after': '45'}),
      );
      assert.deepStrictEqual(result, {ratelimit: true, retryAfter: 45});
    });

    it('classifies a 504 the same way as a 429', async () => {
      const result = await postWithAgentError(
        makeXRPCError(ResponseType.UpstreamTimeout, {'retry-after': '12'}),
      );
      assert.deepStrictEqual(result, {ratelimit: true, retryAfter: 12});
    });

    it('falls back to 30s when a rate-limit status has no retry-after header', async () => {
      const result = await postWithAgentError(makeXRPCError(ResponseType.RateLimitExceeded, {}));
      assert.deepStrictEqual(result, {ratelimit: true, retryAfter: 30});
    });

    it('a non-rate-limit XRPCError is not classified as a rate limit', async () => {
      const result = await postWithAgentError(
        makeXRPCError(ResponseType.InvalidRequest, {'retry-after': '999'}),
      );
      assert.deepStrictEqual(result, {ratelimit: false});
    });

    it('a non-XRPCError exception (network error, etc.) is not classified as a rate limit', async () => {
      const result = await postWithAgentError(new Error('ECONNRESET'));
      assert.deepStrictEqual(result, {ratelimit: false});
    });
  });
});
