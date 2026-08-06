import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {Server} from 'node:http';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createFeedSource} from './index.ts';
import type {NormalizedItem} from './types.ts';

function fixture(path: string): string {
  return readFileSync(join(__dirname, '../../test-fixtures', path), 'utf-8');
}

function startFeedServer(body: string): Promise<{server: Server; port: number}> {
  return new Promise(resolve => {
    const server = createServer((_req, res) => {
      res.writeHead(200, {'Content-Type': 'application/rss+xml'});
      res.end(body);
    });
    server.listen(0, () => {
      const port = (server.address() as {port: number}).port;
      resolve({server, port});
    });
  });
}

test('createFeedSource polls immediately on start and delivers every item', async t => {
  const {server, port} = await startFeedServer(fixture('rss/sample-feed.xml'));
  t.after(() => server.close());

  const source = createFeedSource(new URL(`http://127.0.0.1:${port}/feed.xml`), 60);
  t.after(() => source.stop());

  const items: NormalizedItem[] = [];
  const batches: NormalizedItem[][] = [];
  await new Promise<void>(resolve => {
    source.start({
      onItems: batch => {
        batches.push(batch);
        resolve();
      },
      onItem: async item => {
        items.push(item);
      },
      onError: err => assert.fail(`unexpected error: ${err.message}`),
    });
  });

  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.length, 3);
  assert.equal(items.length, 3);
});

test('createFeedSource reports a fetch failure via onError, not a thrown/unhandled rejection', async t => {
  // Port 1 is unroutable - matches the existing feedReader.test.ts convention for
  // simulating a feed-fetch failure without a flaky real network dependency.
  const source = createFeedSource(
    new URL('http://127.0.0.1:1/feed.xml'),
    60,
    {},
    {fetchTimeoutMs: 500},
  );
  t.after(() => source.stop());

  await new Promise<void>(resolve => {
    source.start({
      onItems: () => assert.fail('should not reach onItems on a fetch failure'),
      onItem: async () => assert.fail('should not reach onItem on a fetch failure'),
      onError: () => resolve(),
    });
  });
});

test('createFeedSource reports one bad item via onError without stopping the batch', async t => {
  const {server, port} = await startFeedServer(fixture('rss/sample-feed.xml'));
  t.after(() => server.close());

  const source = createFeedSource(new URL(`http://127.0.0.1:${port}/feed.xml`), 60);
  t.after(() => source.stop());

  const processed: string[] = [];
  const errors: string[] = [];
  await new Promise<void>(resolve => {
    source.start({
      onItems: () => undefined,
      onItem: async item => {
        if (item.title === 'Second Test Article') throw new Error('simulated bad item');
        processed.push(item.title ?? '');
      },
      onError: err => errors.push(err.message),
    });
    // The poller awaits all 3 items sequentially, in order, on this one poll cycle
    // (the interval is 60 minutes, so a second cycle cannot fire during this test) -
    // a short delay is enough for that in-memory sequential loop to finish.
    setTimeout(resolve, 100);
  });

  assert.deepEqual(processed, ['First Test Article', 'Article with Image']);
  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.includes('Item handling failed'));
});

test('createFeedSource.stop() prevents further polls', async t => {
  const {server, port} = await startFeedServer(fixture('rss/sample-feed.xml'));
  t.after(() => server.close());

  let pollCount = 0;
  const source = createFeedSource(new URL(`http://127.0.0.1:${port}/feed.xml`), 60);
  await new Promise<void>(resolve => {
    source.start({
      onItems: () => {
        pollCount++;
        resolve();
      },
      onItem: async () => undefined,
      onError: () => undefined,
    });
  });
  source.stop();

  const countAfterStop = pollCount;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(pollCount, countAfterStop);
});
