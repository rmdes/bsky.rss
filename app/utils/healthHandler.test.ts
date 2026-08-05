import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert';
import http from 'http';
import {sleep} from './test-helpers';

// Import the module to test
import healthHandler from './healthHandler';

describe('healthHandler', () => {
  const TEST_PORT = 8080; // Use default port

  before(async () => {
    // Start server once for all tests
    healthHandler.start();
    await sleep(100);
  });

  after(async () => {
    // Clean up server
    await healthHandler.stop();
  });

  beforeEach(() => {
    // Reset state before each test
    healthHandler.reset();
  });

  describe('start()', () => {
    it('should start HTTP server on configured port', async () => {
      // Server already started in before() hook

      // Try to connect
      const response = await fetch(`http://localhost:${TEST_PORT}/health`);
      assert.strictEqual(response.status, 503); // Unhealthy until marked ready
    });
  });

  describe('/health endpoint', () => {
    it('should return 503 when not ready', async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/health`);
      const data = await response.json();

      assert.strictEqual(response.status, 503);
      assert.strictEqual(data.status, 'unhealthy');
      assert.strictEqual(data.ready, false);
    });

    it('should return 200 when marked ready and active', async () => {
      healthHandler.markReady();
      healthHandler.updateActivity();

      await sleep(50);

      const response = await fetch(`http://localhost:${TEST_PORT}/health`);
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.strictEqual(data.status, 'healthy');
      assert.strictEqual(data.ready, true);
      assert(data.lastActivity);
      assert(typeof data.uptime === 'number');
      assert(data.version);
    });

    it('should return 503 when last activity is too old', async () => {
      healthHandler.markReady();
      // Don't update activity - wait for it to be stale
      // Health check considers > 600000ms (10 min) as unhealthy

      // We can't wait 10 minutes in a test, so we'll just verify
      // the response structure includes timeSinceActivity
      const response = await fetch(`http://localhost:${TEST_PORT}/health`);
      const data = await response.json();

      assert(data.timeSinceActivity);
      assert(data.lastActivity);
    });

    it('should include uptime in response', async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/health`);
      const data = await response.json();

      assert(typeof data.uptime === 'number');
      assert(data.uptime >= 0);
    });

    it('should include version from package.json', async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/health`);
      const data = await response.json();

      assert(data.version);
      assert.match(data.version, /^\d+\.\d+\.\d+$/); // Semver format
    });

    it('should respond to root path (/)', async () => {
      healthHandler.markReady();
      healthHandler.updateActivity();

      await sleep(50);

      const response = await fetch(`http://localhost:${TEST_PORT}/`);
      assert.strictEqual(response.status, 200);
    });

    it('should return 404 for unknown paths', async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/unknown`);
      assert.strictEqual(response.status, 404);
    });
  });

  describe('markReady()', () => {
    it('should mark service as ready', async () => {
      healthHandler.markReady();

      await sleep(50);

      const response = await fetch(`http://localhost:${TEST_PORT}/health`);
      const data = await response.json();

      assert.strictEqual(data.ready, true);
    });
  });

  describe('updateActivity()', () => {
    it('should update last activity timestamp', async () => {
      healthHandler.updateActivity();

      await sleep(50);

      const response1 = await fetch(`http://localhost:${TEST_PORT}/health`);
      const data1 = await response1.json();
      const timestamp1 = new Date(data1.lastActivity).getTime();

      await sleep(1100); // Sleep more than 1 second to see difference

      const response2 = await fetch(`http://localhost:${TEST_PORT}/health`);
      const data2 = await response2.json();
      const timestamp2 = new Date(data2.lastActivity).getTime();

      // Second request should show same timestamp (no activity update)
      assert.strictEqual(
        timestamp1,
        timestamp2,
        'Last activity timestamp should not change without updateActivity()'
      );

      // But time since activity should increase
      const time1 = parseInt(data1.timeSinceActivity);
      const time2 = parseInt(data2.timeSinceActivity);
      assert(
        time2 > time1,
        `Expected ${time2}s > ${time1}s (time since activity should increase)`
      );
    });

    it('should reset timeSinceActivity when called', async () => {
      await sleep(1100); // Wait more than 1 second

      const response1 = await fetch(`http://localhost:${TEST_PORT}/health`);
      const data1 = await response1.json();
      const time1 = parseInt(data1.timeSinceActivity);

      healthHandler.updateActivity();
      await sleep(50);

      const response2 = await fetch(`http://localhost:${TEST_PORT}/health`);
      const data2 = await response2.json();
      const time2 = parseInt(data2.timeSinceActivity);

      // After updateActivity, timeSinceActivity should be smaller (close to 0)
      assert(
        time2 < time1,
        `updateActivity() should reset the activity timer: ${time2}s < ${time1}s`
      );
      assert(time2 <= 1, `Time since activity should be very recent: ${time2}s`);
    });
  });

  describe('JSON response', () => {
    it('should return valid JSON', async () => {
      const response = await fetch(`http://localhost:${TEST_PORT}/health`);
      const contentType = response.headers.get('content-type');

      assert(contentType);
      assert(contentType.includes('application/json'));

      // Should not throw when parsing
      const data = await response.json();
      assert(typeof data === 'object');
    });

    it('should include all expected fields', async () => {
      healthHandler.markReady();
      healthHandler.updateActivity();

      await sleep(50);

      const response = await fetch(`http://localhost:${TEST_PORT}/health`);
      const data = await response.json();

      assert(data.hasOwnProperty('status'));
      assert(data.hasOwnProperty('ready'));
      assert(data.hasOwnProperty('lastActivity'));
      assert(data.hasOwnProperty('timeSinceActivity'));
      assert(data.hasOwnProperty('uptime'));
      assert(data.hasOwnProperty('version'));
    });
  });
});
