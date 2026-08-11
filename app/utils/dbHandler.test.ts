import {describe, it, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert';
import fs, {mkdtempSync, rmSync} from 'fs';
import path from 'path';
import {tmpdir} from 'os';

// Import the module to test
import {createDbHandler, type DbHandler} from './dbHandler.ts';

describe('dbHandler', () => {
  let testDataDir: string;
  let dbHandler: DbHandler;

  beforeEach(() => {
    testDataDir = mkdtempSync(path.join(tmpdir(), 'bsky-rss-test-'));
    dbHandler = createDbHandler(testDataDir);
  });

  afterEach(() => {
    rmSync(testDataDir, {recursive: true, force: true});
  });

  describe('readLast()', () => {
    it('should create last.txt if it does not exist', async () => {
      const result = await dbHandler.readLast();

      assert.strictEqual(result, '');
      assert(fs.existsSync(path.join(testDataDir, 'last.txt')));
    });

    it('should read existing last.txt content', async () => {
      const testDate = '2026-08-05T10:00:00.000Z';
      fs.writeFileSync(path.join(testDataDir, 'last.txt'), testDate, 'utf8');

      const result = await dbHandler.readLast();

      assert.strictEqual(result, testDate);
    });

    it('should handle empty last.txt file', async () => {
      fs.writeFileSync(path.join(testDataDir, 'last.txt'), '', 'utf8');

      const result = await dbHandler.readLast();

      assert.strictEqual(result, '');
    });
  });

  describe('writeDate()', () => {
    it('should write date to last.txt in ISO format', async () => {
      const testDate = new Date('2026-08-05T10:00:00.000Z');

      const result = await dbHandler.writeDate(testDate);

      assert.strictEqual(result, testDate);

      const fileContent = fs.readFileSync(path.join(testDataDir, 'last.txt'), 'utf8');
      assert.strictEqual(fileContent, testDate.toISOString());
    });

    it('should overwrite existing date', async () => {
      const oldDate = new Date('2026-08-01T10:00:00.000Z');
      const newDate = new Date('2026-08-05T10:00:00.000Z');

      await dbHandler.writeDate(oldDate);
      await dbHandler.writeDate(newDate);

      const fileContent = fs.readFileSync(path.join(testDataDir, 'last.txt'), 'utf8');
      assert.strictEqual(fileContent, newDate.toISOString());
    });
  });

  describe('readPersistData()', () => {
    it('should create persist.json if it does not exist', async () => {
      const result = await dbHandler.readPersistData();

      assert.deepStrictEqual(result, {});
      assert(fs.existsSync(path.join(testDataDir, 'persist.json')));
    });

    it('should read existing persist.json data', async () => {
      const testData = {lastRun: '2026-08-05', itemCount: 42};
      fs.writeFileSync(path.join(testDataDir, 'persist.json'), JSON.stringify(testData), 'utf8');

      const result = await dbHandler.readPersistData();

      assert.deepStrictEqual(result, testData);
    });

    it('should handle empty object in persist.json', async () => {
      fs.writeFileSync(path.join(testDataDir, 'persist.json'), JSON.stringify({}), 'utf8');

      const result = await dbHandler.readPersistData();

      assert.deepStrictEqual(result, {});
    });

    it('should parse complex nested data structures', async () => {
      const testData = {
        config: {feeds: ['feed1', 'feed2']},
        stats: {posted: 10, failed: 2},
        metadata: {version: '2.2.0'},
      };
      fs.writeFileSync(path.join(testDataDir, 'persist.json'), JSON.stringify(testData), 'utf8');

      const result = await dbHandler.readPersistData();

      assert.deepStrictEqual(result, testData);
    });
  });

  describe('writePersistDate()', () => {
    it('should write persist data to persist.json', async () => {
      const testData = {lastRun: '2026-08-05', itemCount: 42};

      const result = await dbHandler.writePersistDate(testData);

      assert.deepStrictEqual(result, testData);

      const fileContent = fs.readFileSync(path.join(testDataDir, 'persist.json'), 'utf8');
      assert.deepStrictEqual(JSON.parse(fileContent), testData);
    });

    it('should overwrite existing persist data', async () => {
      const oldData = {value: 'old'};
      const newData = {value: 'new', extra: true};

      await dbHandler.writePersistDate(oldData);
      await dbHandler.writePersistDate(newData);

      const fileContent = fs.readFileSync(path.join(testDataDir, 'persist.json'), 'utf8');
      assert.deepStrictEqual(JSON.parse(fileContent), newData);
    });
  });

  describe('initConfig()', () => {
    it('should throw error if config.json does not exist', async () => {
      await assert.rejects(
        async () => {
          await dbHandler.initConfig();
        },
        {
          message: 'Config file not found.',
        },
      );
    });

    it('should read and cache config.json', async () => {
      const testConfig = {
        string: '$title - $link',
        publishEmbed: true,
        languages: ['en'],
      };
      fs.writeFileSync(path.join(testDataDir, 'config.json'), JSON.stringify(testConfig), 'utf8');

      const result = await dbHandler.initConfig();

      assert.deepStrictEqual(result, testConfig);
    });

    it('should parse complex config structures', async () => {
      const testConfig = {
        string: '$title',
        publishEmbed: true,
        embedType: 'card',
        languages: ['en', 'fr'],
        runInterval: 60,
        truncate: true,
      };
      fs.writeFileSync(path.join(testDataDir, 'config.json'), JSON.stringify(testConfig), 'utf8');

      const result = await dbHandler.initConfig();

      assert.deepStrictEqual(result, testConfig);
    });
  });

  describe('readConfig()', () => {
    it('should throw error if config not initialized', async () => {
      // dbHandler is a fresh createDbHandler(testDataDir) instance from this file's own
      // beforeEach - no need to force a second "reload the module" instance to get an
      // unset appConfig anymore, unlike the old cache-busting version of this test.
      await assert.rejects(
        async () => {
          await dbHandler.readConfig();
        },
        {
          message: 'Config not initialized.',
        },
      );
    });

    it('should return config after initialization', async () => {
      const testConfig = {
        string: '$title - $link',
        publishEmbed: true,
      };
      fs.writeFileSync(path.join(testDataDir, 'config.json'), JSON.stringify(testConfig), 'utf8');

      await dbHandler.initConfig();
      const result = await dbHandler.readConfig();

      assert.deepStrictEqual(result, testConfig);
    });
  });

  describe('valueExists()', () => {
    it('should create db.txt if it does not exist', async () => {
      const result = await dbHandler.valueExists('test-value');

      assert.strictEqual(result, false);
      assert(fs.existsSync(path.join(testDataDir, 'db.txt')));
    });

    it('should return false for non-existent value', async () => {
      fs.writeFileSync(
        path.join(testDataDir, 'db.txt'),
        '2026-08-05T10:00:00.000Z|existing-value\n',
        'utf8',
      );

      const result = await dbHandler.valueExists('non-existent');

      assert.strictEqual(result, false);
    });

    it('should return true for existing value', async () => {
      fs.writeFileSync(
        path.join(testDataDir, 'db.txt'),
        '2026-08-05T10:00:00.000Z|test-value\n',
        'utf8',
      );

      const result = await dbHandler.valueExists('test-value');

      assert.strictEqual(result, true);
    });

    it('should find value among multiple entries', async () => {
      const entries = [
        '2026-08-05T08:00:00.000Z|value-1',
        '2026-08-05T09:00:00.000Z|value-2',
        '2026-08-05T10:00:00.000Z|target-value',
        '2026-08-05T11:00:00.000Z|value-3',
      ].join('\n');

      fs.writeFileSync(path.join(testDataDir, 'db.txt'), entries, 'utf8');

      const result = await dbHandler.valueExists('target-value');

      assert.strictEqual(result, true);
    });

    it('should handle partial matches correctly', async () => {
      fs.writeFileSync(
        path.join(testDataDir, 'db.txt'),
        '2026-08-05T10:00:00.000Z|full-value-here\n',
        'utf8',
      );

      // Should find the substring
      const result1 = await dbHandler.valueExists('value');
      assert.strictEqual(result1, true);

      // Should not find non-matching string
      const result2 = await dbHandler.valueExists('missing');
      assert.strictEqual(result2, false);
    });
  });

  describe('writeValue()', () => {
    it('should append value to db.txt with timestamp', async () => {
      const testValue = 'test-article-url';

      const result = await dbHandler.writeValue(testValue);

      assert.strictEqual(result, testValue);

      const fileContent = fs.readFileSync(path.join(testDataDir, 'db.txt'), 'utf8');

      // Check format: timestamp|value\n
      assert(fileContent.includes('|' + testValue + '\n'));
      assert(fileContent.match(/^\d{4}-\d{2}-\d{2}T/)); // ISO timestamp format
    });

    it('should append multiple values without overwriting', async () => {
      await dbHandler.writeValue('value-1');
      await dbHandler.writeValue('value-2');
      await dbHandler.writeValue('value-3');

      const fileContent = fs.readFileSync(path.join(testDataDir, 'db.txt'), 'utf8');

      const lines = fileContent.trim().split('\n');
      assert.strictEqual(lines.length, 3);
      assert(fileContent.includes('value-1'));
      assert(fileContent.includes('value-2'));
      assert(fileContent.includes('value-3'));
    });

    it('should create db.txt if it does not exist', async () => {
      const testValue = 'first-value';

      await dbHandler.writeValue(testValue);

      assert(fs.existsSync(path.join(testDataDir, 'db.txt')));
      const fileContent = fs.readFileSync(path.join(testDataDir, 'db.txt'), 'utf8');
      assert(fileContent.includes(testValue));
    });
  });

  describe('cleanupOldValues()', () => {
    it('should create db.txt if it does not exist', async () => {
      const result = await dbHandler.cleanupOldValues();

      assert.strictEqual(result, false);
      assert(fs.existsSync(path.join(testDataDir, 'db.txt')));
    });

    it('should remove entries older than 96 hours', async () => {
      const now = new Date();
      const old = new Date(now.getTime() - 97 * 60 * 60 * 1000); // 97 hours ago
      const recent = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago

      const entries = [
        `${old.toISOString()}|old-value`,
        `${recent.toISOString()}|recent-value`,
        `${now.toISOString()}|current-value`,
      ].join('\n');

      fs.writeFileSync(path.join(testDataDir, 'db.txt'), entries, 'utf8');

      const result = await dbHandler.cleanupOldValues();

      assert.strictEqual(result, true);

      const fileContent = fs.readFileSync(path.join(testDataDir, 'db.txt'), 'utf8');

      // Old value should be removed (>96 hours old)
      assert(!fileContent.includes('old-value'));

      // Recent values should remain (<96 hours old)
      assert(fileContent.includes('recent-value'));
      assert(fileContent.includes('current-value'));
    });

    it('should keep all entries within 96 hours', async () => {
      const now = new Date();
      const entries = [
        `${new Date(now.getTime() - 95 * 60 * 60 * 1000).toISOString()}|value-1`,
        `${new Date(now.getTime() - 50 * 60 * 60 * 1000).toISOString()}|value-2`,
        `${new Date(now.getTime() - 10 * 60 * 60 * 1000).toISOString()}|value-3`,
      ].join('\n');

      fs.writeFileSync(path.join(testDataDir, 'db.txt'), entries, 'utf8');

      await dbHandler.cleanupOldValues();

      const fileContent = fs.readFileSync(path.join(testDataDir, 'db.txt'), 'utf8');

      // All values should remain
      assert(fileContent.includes('value-1'));
      assert(fileContent.includes('value-2'));
      assert(fileContent.includes('value-3'));
    });

    it('should handle empty db.txt', async () => {
      fs.writeFileSync(path.join(testDataDir, 'db.txt'), '', 'utf8');

      const result = await dbHandler.cleanupOldValues();

      assert.strictEqual(result, true);

      const fileContent = fs.readFileSync(path.join(testDataDir, 'db.txt'), 'utf8');
      assert.strictEqual(fileContent, '');
    });

    it('should handle malformed lines gracefully', async () => {
      const now = new Date();
      const entries = [
        `${now.toISOString()}|valid-value`,
        'malformed-line-without-pipe',
        '|no-timestamp',
        `${now.toISOString()}|another-valid`,
      ].join('\n');

      fs.writeFileSync(path.join(testDataDir, 'db.txt'), entries, 'utf8');

      await dbHandler.cleanupOldValues();

      const fileContent = fs.readFileSync(path.join(testDataDir, 'db.txt'), 'utf8');

      // Valid entries should remain
      assert(fileContent.includes('valid-value'));
      assert(fileContent.includes('another-valid'));
    });
  });

  describe('Integration tests', () => {
    it('should support full workflow: init config -> read config -> write/read persist', async () => {
      // 1. Initialize config
      const config = {string: '$title', publishEmbed: true};
      fs.writeFileSync(path.join(testDataDir, 'config.json'), JSON.stringify(config), 'utf8');

      await dbHandler.initConfig();
      const readConfig = await dbHandler.readConfig();
      assert.deepStrictEqual(readConfig, config);

      // 2. Write persist data
      const persistData = {lastRun: new Date().toISOString()};
      await dbHandler.writePersistDate(persistData);

      // 3. Read persist data
      const readPersist = await dbHandler.readPersistData();
      assert.deepStrictEqual(readPersist, persistData);
    });

    it('should support duplicate detection workflow', async () => {
      const url1 = 'https://example.com/article-1';
      const url2 = 'https://example.com/article-2';

      // Check initial state
      const exists1 = await dbHandler.valueExists(url1);
      assert.strictEqual(exists1, false);

      // Write first URL
      await dbHandler.writeValue(url1);

      // Check it exists now
      const exists2 = await dbHandler.valueExists(url1);
      assert.strictEqual(exists2, true);

      // Check second URL doesn't exist
      const exists3 = await dbHandler.valueExists(url2);
      assert.strictEqual(exists3, false);

      // Write second URL
      await dbHandler.writeValue(url2);

      // Both should exist now
      const exists4 = await dbHandler.valueExists(url1);
      const exists5 = await dbHandler.valueExists(url2);
      assert.strictEqual(exists4, true);
      assert.strictEqual(exists5, true);
    });

    it('should support last posted date tracking', async () => {
      // Read initial (should be empty)
      const initial = await dbHandler.readLast();
      assert.strictEqual(initial, '');

      // Write date
      const date1 = new Date('2026-08-05T10:00:00.000Z');
      await dbHandler.writeDate(date1);

      // Read it back
      const read1 = await dbHandler.readLast();
      assert.strictEqual(read1, date1.toISOString());

      // Update to new date
      const date2 = new Date('2026-08-05T11:00:00.000Z');
      await dbHandler.writeDate(date2);

      // Read updated date
      const read2 = await dbHandler.readLast();
      assert.strictEqual(read2, date2.toISOString());
    });
  });
});
