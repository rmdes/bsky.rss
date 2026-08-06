import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseRawFeed} from './parse.ts';
import {FeedSourceError} from './types.ts';

function fixture(path: string): string {
  return readFileSync(join(__dirname, '../../test-fixtures', path), 'utf-8');
}

test('parseRawFeed detects RSS and returns its items', () => {
  const result = parseRawFeed(fixture('rss/sample-feed.xml'));
  assert.equal(result.format, 'rss');
  assert.equal(result.feed.items?.length, 3);
});

test('parseRawFeed throws a FeedSourceError on unparseable content', () => {
  assert.throws(
    () => parseRawFeed('not a feed, just plain text'),
    (error: unknown) => error instanceof FeedSourceError,
  );
});
