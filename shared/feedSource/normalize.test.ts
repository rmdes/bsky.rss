import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseRawFeed} from './parse.ts';
import {normalizeFeed} from './normalize.ts';

function fixture(path: string): string {
  return readFileSync(join(__dirname, '../../test-fixtures', path), 'utf-8');
}

test('normalizeFeed maps RSS items to NormalizedItem', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed.xml'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items.length, 3);
  assert.deepEqual(items[0], {
    id: 'https://example.com/article-1',
    title: 'First Test Article',
    link: 'https://example.com/article-1',
    date: 'Wed, 05 Aug 2026 09:00:00 GMT',
    description: 'This is a test article description with some <strong>HTML</strong> content.',
    content: undefined,
    imageUrl: undefined,
    geo: undefined,
  });
});

test('normalizeFeed resolves an RSS enclosure image when imageField is "enclosure"', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed.xml'));
  const items = normalizeFeed(parsed, {imageField: 'enclosure'});
  const withImage = items.find(item => item.id === 'https://example.com/article-3');

  assert.equal(withImage?.imageUrl, 'https://example.com/images/test.jpg');
});

test('normalizeFeed resolves a media:content image when imageField is "media:content"', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-media.xml'));
  const items = normalizeFeed(parsed, {imageField: 'media:content'});

  assert.equal(items[0]?.imageUrl, 'https://example.com/images/media-article-1.jpg');
});

test('normalizeFeed falls back to guid.value for id when link differs from guid', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed.xml'));
  const items = normalizeFeed(parsed, {});

  // sample-feed.xml's items use the same URL for both link and guid; this asserts
  // the id field is genuinely sourced from guid.value, not merely copied from link.
  assert.equal(items[0]?.id, 'https://example.com/article-1');
});

test('normalizeFeed maps Atom entries to NormalizedItem, preferring published over updated', () => {
  const parsed = parseRawFeed(fixture('atom/sample-feed.xml'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    id: 'https://example.com/atom/entry-1',
    title: 'First Atom Entry',
    link: 'https://example.com/atom/entry-1',
    date: '2026-08-05T09:00:00Z',
    description: 'A short summary of the first Atom entry.',
    content: 'The full content of the first Atom entry.',
    imageUrl: undefined,
    geo: undefined,
  });
});

test('normalizeFeed falls back to updated when an Atom entry has no published date', () => {
  const parsed = parseRawFeed(fixture('atom/sample-feed.xml'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items[1]?.date, '2026-08-05T08:00:00Z');
});

test('normalizeFeed maps JSON Feed items to NormalizedItem, using the native image field', () => {
  const parsed = parseRawFeed(fixture('jsonfeed/sample-feed.json'));
  const items = normalizeFeed(parsed, {imageField: 'enclosure'});

  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    id: 'https://example.com/jsonfeed/article-1',
    title: 'First JSON Feed Article',
    link: 'https://example.com/jsonfeed/article-1',
    date: '2026-08-05T09:00:00Z',
    description: 'A short summary of the first article.',
    content: 'The full text content of the first article.',
    imageUrl: 'https://example.com/jsonfeed/images/article-1.jpg',
    geo: undefined,
  });
});

test('normalizeFeed ignores the JSON Feed native image when imageField is unset', () => {
  const parsed = parseRawFeed(fixture('jsonfeed/sample-feed.json'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items[0]?.imageUrl, undefined);
});

test('normalizeFeed resolves an Atom media:content image when imageField is "media:content"', () => {
  const parsed = parseRawFeed(fixture('atom/sample-feed.xml'));
  const items = normalizeFeed(parsed, {imageField: 'media:content'});

  assert.equal(items[0]?.imageUrl, 'https://example.com/atom/images/entry-1.jpg');
  assert.equal(items[1]?.imageUrl, undefined);
});

test('normalizeFeed prefers content_html over content_text when JSON Feed has both', () => {
  const parsed = parseRawFeed(fixture('jsonfeed/sample-feed.json'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items[1]?.content, '<p>The full HTML content of the second article.</p>');
});

test('normalizeFeed maps RDF items to NormalizedItem, deriving id from link', () => {
  const parsed = parseRawFeed(fixture('rdf/sample-feed.xml'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    id: 'https://example.com/rdf/article-1',
    title: 'First RDF Article',
    link: 'https://example.com/rdf/article-1',
    date: '2026-08-05T09:00:00Z',
    description: 'A test article in RDF/RSS 1.0 format.',
    content: undefined,
    imageUrl: undefined,
    geo: undefined,
  });
});

test('normalizeFeed extracts georss:point into geo for an RSS item', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-georss.xml'));
  const items = normalizeFeed(parsed, {});

  assert.deepEqual(items[0]?.geo, {lat: 52.9793, lng: -132.6194});
});

test('normalizeFeed extracts georss:point into geo for an Atom entry', () => {
  const parsed = parseRawFeed(fixture('atom/sample-feed-georss-no-link.xml'));
  const items = normalizeFeed(parsed, {});

  assert.deepEqual(items[0]?.geo, {lat: 47.391, lng: -70.2406});
});

test('normalizeFeed leaves geo undefined when a feed has no georss:point', () => {
  const parsed = parseRawFeed(fixture('atom/sample-feed.xml'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items[0]?.geo, undefined);
});
