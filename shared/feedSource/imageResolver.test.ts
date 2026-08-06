import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveImageUrl} from './imageResolver.ts';

test('resolveImageUrl returns the enclosure URL when imageField is "enclosure"', () => {
  const item = {enclosures: [{url: 'https://example.com/a.jpg', length: 100, type: 'image/jpeg'}]};
  assert.equal(resolveImageUrl(item, 'enclosure'), 'https://example.com/a.jpg');
});

test('resolveImageUrl returns the media:content URL when imageField is "media:content"', () => {
  const item = {media: {contents: [{url: 'https://example.com/b.jpg'}]}};
  assert.equal(resolveImageUrl(item, 'media:content'), 'https://example.com/b.jpg');
});

test('resolveImageUrl finds a media:content URL nested inside a media:group', () => {
  const item = {media: {groups: [{contents: [{url: 'https://example.com/c.jpg'}]}]}};
  assert.equal(resolveImageUrl(item, 'media:content'), 'https://example.com/c.jpg');
});

test('resolveImageUrl returns undefined when imageField is unset', () => {
  const item = {enclosures: [{url: 'https://example.com/a.jpg', length: 100, type: 'image/jpeg'}]};
  assert.equal(resolveImageUrl(item, undefined), undefined);
});

test('resolveImageUrl returns undefined when imageField is unset and empty', () => {
  const item = {enclosures: [{url: 'https://example.com/a.jpg', length: 100, type: 'image/jpeg'}]};
  assert.equal(resolveImageUrl(item, ''), undefined);
});

test('resolveImageUrl falls back to undefined for an unrecognized imageField value, not an error', () => {
  const item = {enclosures: [{url: 'https://example.com/a.jpg', length: 100, type: 'image/jpeg'}]};
  assert.equal(resolveImageUrl(item, 'itunes:image'), undefined);
});

test('resolveImageUrl returns undefined when the named location is present but empty', () => {
  assert.equal(resolveImageUrl({enclosures: []}, 'enclosure'), undefined);
  assert.equal(resolveImageUrl({media: {}}, 'media:content'), undefined);
});

test('resolveImageUrl ignores a non-image enclosure', () => {
  // Break caught: a podcast <enclosure type="audio/mpeg"> handed to the image
  // downloader as a post image. Pre-migration only accepted image/* or no type.
  const item = {enclosures: [{url: 'https://example.com/ep.mp3', type: 'audio/mpeg'}]};
  assert.equal(resolveImageUrl(item, 'enclosure'), undefined);
});

test('resolveImageUrl skips a non-image enclosure and takes a later image one', () => {
  const item = {
    enclosures: [
      {url: 'https://example.com/ep.mp3', type: 'audio/mpeg'},
      {url: 'https://example.com/cover.jpg', type: 'image/jpeg'},
    ],
  };
  assert.equal(resolveImageUrl(item, 'enclosure'), 'https://example.com/cover.jpg');
});

test('resolveImageUrl ignores a non-image media:content', () => {
  const item = {media: {contents: [{url: 'https://example.com/clip.mp4', type: 'video/mp4'}]}};
  assert.equal(resolveImageUrl(item, 'media:content'), undefined);
});

test('resolveImageUrl skips a non-image media:content and takes a later image one', () => {
  const item = {
    media: {
      contents: [
        {url: 'https://example.com/clip.mp4', type: 'video/mp4'},
        {url: 'https://example.com/still.png', type: 'image/png'},
      ],
    },
  };
  assert.equal(resolveImageUrl(item, 'media:content'), 'https://example.com/still.png');
});

test('resolveImageUrl accepts an entry with no type at all', () => {
  // media:content routinely omits type; dropping those would be a regression too.
  assert.equal(
    resolveImageUrl({media: {contents: [{url: 'https://example.com/b.jpg'}]}}, 'media:content'),
    'https://example.com/b.jpg',
  );
});
