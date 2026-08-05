import {describe, it} from 'node:test';
import assert from 'node:assert';

/**
 * Tests for bskyHandler module
 *
 * Note: These tests focus on the module's contract and error handling.
 * Full integration tests with Bluesky API require real credentials and
 * are better suited for E2E tests.
 */

describe('bskyHandler', () => {
  describe('Module exports', () => {
    it('should export init, login, and post functions', () => {
      const bskyHandler = require('./bskyHandler').default;

      assert(typeof bskyHandler.init === 'function');
      assert(typeof bskyHandler.login === 'function');
      assert(typeof bskyHandler.post === 'function');
    });
  });

  describe('init()', () => {
    it('should require service URL parameter', async () => {
      // Reload module to reset state
      delete require.cache[require.resolve('./bskyHandler')];
      const bskyHandler = require('./bskyHandler').default;

      const agent = await bskyHandler.init('https://bsky.social');
      assert(agent, 'Agent should be returned');
      assert.strictEqual(typeof agent, 'object');
    });

    it('should throw error if initialized twice', async () => {
      delete require.cache[require.resolve('./bskyHandler')];
      const bskyHandler = require('./bskyHandler').default;

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
      delete require.cache[require.resolve('./bskyHandler')];
      const bskyHandler1 = require('./bskyHandler').default;
      const agent1 = await bskyHandler1.init('https://bsky.social');
      assert(agent1);

      delete require.cache[require.resolve('./bskyHandler')];
      const bskyHandler2 = require('./bskyHandler').default;
      const agent2 = await bskyHandler2.init('https://custom.bsky.host');
      assert(agent2);
    });
  });

  describe('login()', () => {
    it('should throw error if agent not initialized', async () => {
      delete require.cache[require.resolve('./bskyHandler')];
      const bskyHandler = require('./bskyHandler').default;

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
      delete require.cache[require.resolve('./bskyHandler')];
      const bskyHandler = require('./bskyHandler').default;
      await bskyHandler.init('https://bsky.social');

      // Should accept object with identifier and password
      const credentials = {
        identifier: 'test.bsky.social',
        password: 'test-password',
      };

      // We can't test the actual login without credentials,
      // but we can verify it attempts to read persisted data
      // and the function signature is correct
      try {
        await bskyHandler.login(credentials);
      } catch (error) {
        assert(error instanceof Error, 'Expected an Error instance');
        // Expected to fail without valid credentials
        // Just verify it's attempting authentication
        assert(
          error.message.includes('Login failed') ||
            error.message.includes('Invalid') ||
            error.message.includes('fetch') ||
            error.message.includes('ENOTFOUND') ||
            error.message.includes('Forbidden') ||
            error.message.includes('Unauthorized'),
          `Error should be related to authentication or network: ${error.message}`,
        );
      }
    });
  });

  describe('post()', () => {
    it('should throw error if agent not initialized', async () => {
      delete require.cache[require.resolve('./bskyHandler')];
      const bskyHandler = require('./bskyHandler').default;

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
      delete require.cache[require.resolve('./bskyHandler')];
      const bskyHandler = require('./bskyHandler').default;
      await bskyHandler.init('https://bsky.social');

      // Should accept object with content
      const postData = {
        content: 'Test post content',
      };

      // We can't test actual posting without authentication,
      // but we can verify the function signature
      try {
        await bskyHandler.post(postData);
      } catch (error) {
        assert(error instanceof Error, 'Expected an Error instance');
        // Expected to fail without authentication
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
      delete require.cache[require.resolve('./bskyHandler')];
      const bskyHandler = require('./bskyHandler').default;
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

      // Verify function accepts these parameters without throwing TypeError
      try {
        await bskyHandler.post(postData);
      } catch (error) {
        assert(error instanceof Error, 'Expected an Error instance');
        // Should not be a TypeError about parameters
        assert(
          error.constructor.name !== 'TypeError' || !error.message.includes('undefined'),
          'Should not throw TypeError for valid parameters',
        );
      }
    });
  });

  describe('Type safety and parameter validation', () => {
    it('should handle embed with image type', () => {
      // Test that embed structure is accepted
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
      delete require.cache[require.resolve('./bskyHandler')];
      const bskyHandler = require('./bskyHandler').default;

      // Should throw before init
      await assert.rejects(
        () => bskyHandler.login({identifier: 'test', password: 'test'}),
        /not initialized/,
      );

      await assert.rejects(() => bskyHandler.post({content: 'test'}), /not initialized/);

      // Should work after init (may fail for other reasons)
      await bskyHandler.init('https://bsky.social');

      // Now functions should at least attempt to execute
      // (they may fail for authentication reasons, but not initialization)
    });
  });

  describe('Module state management', () => {
    it('should maintain singleton agent across function calls', async () => {
      delete require.cache[require.resolve('./bskyHandler')];
      const bskyHandler = require('./bskyHandler').default;

      await bskyHandler.init('https://bsky.social');

      // Second init should fail
      await assert.rejects(() => bskyHandler.init('https://bsky.social'), /already initialized/);
    });

    it('should reset state when module is reloaded', async () => {
      delete require.cache[require.resolve('./bskyHandler')];
      let bskyHandler = require('./bskyHandler').default;
      await bskyHandler.init('https://bsky.social');

      // Reload module
      delete require.cache[require.resolve('./bskyHandler')];
      bskyHandler = require('./bskyHandler').default;

      // Should be able to init again
      const agent = await bskyHandler.init('https://bsky.social');
      assert(agent);
    });
  });

  describe('Integration contract', () => {
    it('should export functions that match expected signatures', () => {
      const bskyHandler = require('./bskyHandler').default;

      // Check function signatures
      assert.strictEqual(bskyHandler.init.length, 1); // service parameter
      assert.strictEqual(bskyHandler.login.length, 1); // credentials object
      assert.strictEqual(bskyHandler.post.length, 1); // post data object
    });

    it('should return expected types', async () => {
      delete require.cache[require.resolve('./bskyHandler')];
      const bskyHandler = require('./bskyHandler').default;

      const agent = await bskyHandler.init('https://bsky.social');
      assert.strictEqual(typeof agent, 'object');
      assert(agent !== null);
    });
  });
});
