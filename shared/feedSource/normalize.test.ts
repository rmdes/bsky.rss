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
    mappedValues: {},
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
    mappedValues: {},
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
    mappedValues: {},
  });
});

test('normalizeFeed ignores the JSON Feed native image when imageField is unset', () => {
  // Break caught: JSON Feed's native image was used unconditionally, so a bot with
  // imageField: "" (deliberately Open-Graph-only) still got a field-driven image -
  // inconsistent with RSS/Atom/RDF, which resolve nothing when imageField is unset.
  const parsed = parseRawFeed(fixture('jsonfeed/sample-feed.json'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items[0]?.imageUrl, undefined);
});

test('normalizeFeed resolves an Atom media:content image when imageField is "media:content"', () => {
  // Break caught: only the RSS and RDF branches called resolveImageUrl, so an Atom
  // feed carrying media:content silently lost its image.
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
    mappedValues: {},
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

test('normalizeFeed falls back to geo:lat/geo:long when georss:point is absent', () => {
  // Break caught: BGS's world-earthquake RSS feed carries coordinates only via the
  // W3C Basic Geo namespace (geo:lat/geo:long), never georss:point - extractGeo only
  // read georss:point, so $georss silently rendered empty for this real feed.
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-w3c-geo.xml'));
  const items = normalizeFeed(parsed, {});

  assert.deepEqual(items[0]?.geo, {lat: 32.682, lng: 130.722});
});

test('normalizeFeed falls back to id as link for an Atom entry with no <link> when id is a URL', () => {
  const parsed = parseRawFeed(fixture('atom/sample-feed-georss-no-link.xml'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items[0]?.link, 'https://example.com/geo-atom/entry-1');
});

test('normalizeFeed does not use a non-URL id as link when a real <link> already exists', () => {
  const parsed = parseRawFeed(fixture('atom/sample-feed-georss-tag-id.xml'));
  const items = normalizeFeed(parsed, {});

  assert.equal(items[0]?.link, 'https://example.com/photos/1');
  assert.equal(items[0]?.id, 'tag:example.com,2026:/photo/1');
});

test('normalizeFeed resolves dc:creator for a single-creator RSS item', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-dc.xml'));
  const items = normalizeFeed(parsed, {mappedValues: [{key: 'author', value: 'dc:creator'}]});

  assert.equal(items[0]?.mappedValues.author, 'Ianko López');
});

test('normalizeFeed joins multiple dc:creator values with ", "', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-dc.xml'));
  const items = normalizeFeed(parsed, {mappedValues: [{key: 'author', value: 'dc:creator'}]});

  assert.equal(items[1]?.mappedValues.author, 'Andrés Rodríguez, Isaías Alvarado');
});

test('normalizeFeed resolves dc:creator to empty string when the item has no creator', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-dc.xml'));
  const items = normalizeFeed(parsed, {mappedValues: [{key: 'author', value: 'dc:creator'}]});

  assert.equal(items[2]?.mappedValues.author, '');
});

test('normalizeFeed resolves itunes:duration and itunes:explicit for a real podcast item', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-podcast.xml'));
  const items = normalizeFeed(parsed, {
    mappedValues: [
      {key: 'duration', value: 'itunes:duration'},
      {key: 'explicit', value: 'itunes:explicit'},
    ],
  });

  assert.equal(items[0]?.mappedValues.duration, '2416');
  assert.equal(items[0]?.mappedValues.explicit, 'false');
});

test('normalizeFeed resolves dc:date for an RSS item', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-dc.xml'));
  const items = normalizeFeed(parsed, {mappedValues: [{key: 'date', value: 'dc:date'}]});

  assert.equal(items[0]?.mappedValues.date, '2026-08-07T09:00:00Z');
});

test('normalizeFeed resolves dc:subject for an RSS item', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-dc.xml'));
  const items = normalizeFeed(parsed, {mappedValues: [{key: 'subject', value: 'dc:subject'}]});

  assert.equal(items[0]?.mappedValues.subject, 'Film');
});

test('normalizeFeed resolves dc:publisher for an RSS item', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-dc.xml'));
  const items = normalizeFeed(parsed, {mappedValues: [{key: 'publisher', value: 'dc:publisher'}]});

  assert.equal(items[0]?.mappedValues.publisher, 'EL PAÍS English');
});

test('normalizeFeed resolves itunes:episode for a real podcast item', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-podcast.xml'));
  const items = normalizeFeed(parsed, {
    mappedValues: [{key: 'episode', value: 'itunes:episode'}],
  });

  assert.equal(items[0]?.mappedValues.episode, '7');
});

test('normalizeFeed resolves itunes:season for a real podcast item', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-podcast.xml'));
  const items = normalizeFeed(parsed, {
    mappedValues: [{key: 'season', value: 'itunes:season'}],
  });

  assert.equal(items[0]?.mappedValues.season, '2026');
});

test('normalizeFeed resolves itunes:author to empty string for an item-level-only lookup against a channel-level-only fixture', () => {
  // Confirmed: resolveMappedValue's itunes:author branch reads item.itunes?.author
  // (item-level only), it does not fall back to the channel/show-level
  // <itunes:author>. This fixture's real-world structure carries <itunes:author> at
  // the channel level only (a common podcast feed pattern) and not on the item, so
  // mapping itunes:author against it must resolve to '' - proving the documented
  // item-level-only behavior, not silently reading the channel value instead.
  const parsed = parseRawFeed(fixture('rss/sample-feed-podcast.xml'));
  const items = normalizeFeed(parsed, {
    mappedValues: [{key: 'author', value: 'itunes:author'}],
  });

  assert.equal(items[0]?.mappedValues.author, '');
});

test('normalizeFeed resolves mappedValues to empty string for an item missing every requested field', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-podcast.xml'));
  const items = normalizeFeed(parsed, {
    mappedValues: [{key: 'duration', value: 'itunes:duration'}],
  });

  assert.equal(items[1]?.mappedValues.duration, '');
});

test('normalizeFeed resolves an unrecognized mappedValues entry to empty string', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-dc.xml'));
  const items = normalizeFeed(parsed, {
    mappedValues: [{key: 'unknown', value: 'nope:not-a-real-field'}],
  });

  assert.equal(items[0]?.mappedValues.unknown, '');
});

test('normalizeFeed leaves mappedValues empty when the config sets none', () => {
  const parsed = parseRawFeed(fixture('rss/sample-feed-with-dc.xml'));
  const items = normalizeFeed(parsed, {});

  assert.deepEqual(items[0]?.mappedValues, {});
});

test('normalizeFeed resolves a requested mappedValues key to empty string for JSON Feed items, not an unresolved placeholder', () => {
  const parsed = parseRawFeed(fixture('jsonfeed/sample-feed.json'));
  const items = normalizeFeed(parsed, {
    mappedValues: [{key: 'author', value: 'dc:creator'}],
  });

  assert.deepEqual(items[0]?.mappedValues, {author: ''});
});
