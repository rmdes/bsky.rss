// shared/feedSource/markdownLinks.test.ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveMarkdownLinks} from './markdownLinks.ts';

test('resolveMarkdownLinks replaces a single span with resolved display text and records a facet', () => {
  const resolve = (token: string) =>
    ({'$title': 'Breaking News', '$link': 'https://example.com/1'})[token];
  const result = resolveMarkdownLinks('[$title]($link)', resolve);

  assert.equal(result.text, 'Breaking News');
  assert.deepEqual(result.facets, [
    {byteStart: 0, byteEnd: 13, uri: 'https://example.com/1'},
  ]);
});

test('resolveMarkdownLinks supports static (non-placeholder) display text alongside a placeholder url', () => {
  const resolve = (token: string) => ({'$georss': 'https://www.openstreetmap.org/?mlat=1&mlon=2'})[token];
  const result = resolveMarkdownLinks('[Map]($georss)', resolve);

  assert.equal(result.text, 'Map');
  assert.deepEqual(result.facets, [
    {byteStart: 0, byteEnd: 3, uri: 'https://www.openstreetmap.org/?mlat=1&mlon=2'},
  ]);
});

test('resolveMarkdownLinks computes UTF-8 byte offsets, not character offsets, for multi-byte text', () => {
  // "Andrés" is 6 characters but 7 UTF-8 bytes (é is 2 bytes) - a character-offset facet
  // would misalign by one byte per accented character, corrupting the clickable range.
  const resolve = (token: string) => ({'$link': 'https://example.com/2'})[token];
  const result = resolveMarkdownLinks('[Andrés]($link)', resolve);

  assert.equal(result.text, 'Andrés');
  assert.equal(Buffer.byteLength('Andrés', 'utf8'), 7);
  assert.deepEqual(result.facets, [
    {byteStart: 0, byteEnd: 7, uri: 'https://example.com/2'},
  ]);
});

test('resolveMarkdownLinks computes correct byte offsets when a span is not at the start of the template', () => {
  const resolve = (token: string) => ({'$link': 'https://example.com/3'})[token];
  // "café " (5 bytes: c-a-f-é(2)-space) precedes the span, so the facet must start at byte 5.
  const result = resolveMarkdownLinks('café [Read]($link)', resolve);

  assert.equal(result.text, 'café Read');
  assert.deepEqual(result.facets, [
    {byteStart: 6, byteEnd: 10, uri: 'https://example.com/3'},
  ]);
});

test('resolveMarkdownLinks builds multiple facets for multiple spans in one template', () => {
  const resolve = (token: string) =>
    ({'$link': 'https://example.com/4', '$georss': 'https://www.openstreetmap.org/?mlat=1&mlon=2'})[token];
  const result = resolveMarkdownLinks('[Report]($link) [Map]($georss)', resolve);

  assert.equal(result.text, 'Report Map');
  assert.deepEqual(result.facets, [
    {byteStart: 0, byteEnd: 6, uri: 'https://example.com/4'},
    {byteStart: 7, byteEnd: 10, uri: 'https://www.openstreetmap.org/?mlat=1&mlon=2'},
  ]);
});

test('resolveMarkdownLinks degrades to plain text with no facet when the url side is not a valid URL', () => {
  const resolve = () => undefined; // e.g. $georss with no geo data on this item
  const result = resolveMarkdownLinks('[Map]($georss)', resolve);

  assert.equal(result.text, 'Map');
  assert.deepEqual(result.facets, []);
});

test('resolveMarkdownLinks degrades to plain text when the url side resolves to a non-URL value', () => {
  const resolve = (token: string) => ({'$duration': '2416'})[token]; // itunes:duration - a number, not a URL
  const result = resolveMarkdownLinks('[Length]($duration)', resolve);

  assert.equal(result.text, 'Length');
  assert.deepEqual(result.facets, []);
});

test('resolveMarkdownLinks makes the span vanish entirely when the display text resolves to empty', () => {
  const resolve = (token: string) => ({'$link': 'https://example.com/5'})[token];
  const result = resolveMarkdownLinks('before []($link) after', resolve);

  assert.equal(result.text, 'before  after');
  assert.deepEqual(result.facets, []);
});

test('resolveMarkdownLinks leaves malformed brackets (no closing paren) untouched as literal text', () => {
  const resolve = () => 'https://example.com/6';
  const result = resolveMarkdownLinks('see [link](https://incomplete', resolve);

  assert.equal(result.text, 'see [link](https://incomplete');
  assert.deepEqual(result.facets, []);
});

test('resolveMarkdownLinks leaves text with no bracket syntax completely unchanged', () => {
  const resolve = () => 'https://example.com/7';
  const result = resolveMarkdownLinks('$title - $link', resolve);

  assert.equal(result.text, '$title - $link');
  assert.deepEqual(result.facets, []);
});
