// shared/feedSource/markdownLinks.test.ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractMarkdownLinks, finalizeMarkdownLinks, buildFacets} from './markdownLinks.ts';

test('extractMarkdownLinks+finalizeMarkdownLinks replaces a single span with resolved display text and records a facet', () => {
  const resolve = (token: string) =>
    ({$title: 'Breaking News', $link: 'https://example.com/1'})[token];
  const extracted = extractMarkdownLinks('[$title]($link)', resolve);
  const result = finalizeMarkdownLinks(extracted.text, extracted.pending);

  assert.equal(result.text, 'Breaking News');
  assert.deepEqual(result.facets, [{byteStart: 0, byteEnd: 13, uri: 'https://example.com/1'}]);
});

test('extractMarkdownLinks+finalizeMarkdownLinks supports static (non-placeholder) display text alongside a placeholder url', () => {
  const resolve = (token: string) =>
    ({$georss: 'https://www.openstreetmap.org/?mlat=1&mlon=2'})[token];
  const extracted = extractMarkdownLinks('[Map]($georss)', resolve);
  const result = finalizeMarkdownLinks(extracted.text, extracted.pending);

  assert.equal(result.text, 'Map');
  assert.deepEqual(result.facets, [
    {byteStart: 0, byteEnd: 3, uri: 'https://www.openstreetmap.org/?mlat=1&mlon=2'},
  ]);
});

test('extractMarkdownLinks+finalizeMarkdownLinks computes UTF-8 byte offsets, not character offsets, for multi-byte text', () => {
  // "Andrés" is 6 characters but 7 UTF-8 bytes (é is 2 bytes) - a character-offset facet
  // would misalign by one byte per accented character, corrupting the clickable range.
  const resolve = (token: string) => ({$link: 'https://example.com/2'})[token];
  const extracted = extractMarkdownLinks('[Andrés]($link)', resolve);
  const result = finalizeMarkdownLinks(extracted.text, extracted.pending);

  assert.equal(result.text, 'Andrés');
  assert.equal(Buffer.byteLength('Andrés', 'utf8'), 7);
  assert.deepEqual(result.facets, [{byteStart: 0, byteEnd: 7, uri: 'https://example.com/2'}]);
});

test('extractMarkdownLinks+finalizeMarkdownLinks computes correct byte offsets when a span is not at the start of the template', () => {
  const resolve = (token: string) => ({$link: 'https://example.com/3'})[token];
  // "café " (5 bytes: c-a-f-é(2)-space) precedes the span, so the facet must start at byte 5.
  const extracted = extractMarkdownLinks('café [Read]($link)', resolve);
  const result = finalizeMarkdownLinks(extracted.text, extracted.pending);

  assert.equal(result.text, 'café Read');
  assert.deepEqual(result.facets, [{byteStart: 6, byteEnd: 10, uri: 'https://example.com/3'}]);
});

test('extractMarkdownLinks+finalizeMarkdownLinks builds multiple facets for multiple spans in one template', () => {
  const resolve = (token: string) =>
    ({$link: 'https://example.com/4', $georss: 'https://www.openstreetmap.org/?mlat=1&mlon=2'})[
      token
    ];
  const extracted = extractMarkdownLinks('[Report]($link) [Map]($georss)', resolve);
  const result = finalizeMarkdownLinks(extracted.text, extracted.pending);

  assert.equal(result.text, 'Report Map');
  assert.deepEqual(result.facets, [
    {byteStart: 0, byteEnd: 6, uri: 'https://example.com/4'},
    {byteStart: 7, byteEnd: 10, uri: 'https://www.openstreetmap.org/?mlat=1&mlon=2'},
  ]);
});

test('extractMarkdownLinks+finalizeMarkdownLinks degrades to plain text with no facet when the url side is not a valid URL', () => {
  const resolve = () => undefined; // e.g. $georss with no geo data on this item
  const extracted = extractMarkdownLinks('[Map]($georss)', resolve);
  const result = finalizeMarkdownLinks(extracted.text, extracted.pending);

  assert.equal(result.text, 'Map');
  assert.deepEqual(result.facets, []);
});

test('extractMarkdownLinks+finalizeMarkdownLinks degrades to plain text when the url side resolves to a non-URL value', () => {
  const resolve = (token: string) => ({$duration: '2416'})[token]; // itunes:duration - a number, not a URL
  const extracted = extractMarkdownLinks('[Length]($duration)', resolve);
  const result = finalizeMarkdownLinks(extracted.text, extracted.pending);

  assert.equal(result.text, 'Length');
  assert.deepEqual(result.facets, []);
});

test('extractMarkdownLinks+finalizeMarkdownLinks makes the span vanish entirely when the display text resolves to empty', () => {
  const resolve = (token: string) => ({$link: 'https://example.com/5'})[token];
  const extracted = extractMarkdownLinks('before []($link) after', resolve);
  const result = finalizeMarkdownLinks(extracted.text, extracted.pending);

  assert.equal(result.text, 'before  after');
  assert.deepEqual(result.facets, []);
});

test('extractMarkdownLinks+finalizeMarkdownLinks leaves malformed brackets (no closing paren) untouched as literal text', () => {
  const resolve = () => 'https://example.com/6';
  const extracted = extractMarkdownLinks('see [link](https://incomplete', resolve);
  const result = finalizeMarkdownLinks(extracted.text, extracted.pending);

  assert.equal(result.text, 'see [link](https://incomplete');
  assert.deepEqual(result.facets, []);
});

test('extractMarkdownLinks+finalizeMarkdownLinks leaves text with no bracket syntax completely unchanged', () => {
  const resolve = () => 'https://example.com/7';
  const extracted = extractMarkdownLinks('$title - $link', resolve);
  const result = finalizeMarkdownLinks(extracted.text, extracted.pending);

  assert.equal(result.text, '$title - $link');
  assert.deepEqual(result.facets, []);
});

test('finalizeMarkdownLinks computes correct byte offsets even when the caller mutates the text between phases (simulates a bare placeholder before a bracket)', () => {
  const extracted = extractMarkdownLinks(
    '$title - [text]($link)',
    token => (({$link: 'https://x.com'}) as Record<string, string>)[token],
  );
  // Simulate the caller's bare-substitution pass replacing $title with a much longer
  // string, AFTER extraction but BEFORE finalization - this is exactly what
  // app/utils/rssHandler.ts's parseString does between the two phases.
  const mutated = extracted.text.replace('$title', 'A much longer title than the placeholder');
  const result = finalizeMarkdownLinks(mutated, extracted.pending);

  assert.equal(result.text, 'A much longer title than the placeholder - text');
  const bytes = Buffer.from(result.text, 'utf8');
  const facetText = bytes
    .slice(result.facets[0]?.byteStart, result.facets[0]?.byteEnd)
    .toString('utf8');
  assert.equal(facetText, 'text');
});

test('extractMarkdownLinks+finalizeMarkdownLinks resolves $author_name and $author independently when both exist as separate resolver entries', () => {
  // Regression test for Finding 2: PLACEHOLDER_TOKEN_PATTERN previously excluded '_'/'-'
  // from the token charset, so "$author_name" greedily matched only "$author", silently
  // resolving to the wrong value ("ALICE_name" instead of "BOB") whenever both keys existed.
  const resolve = (token: string) =>
    ({$author: 'ALICE', $author_name: 'BOB', $link: 'https://x.com'})[token];
  const extracted = extractMarkdownLinks('[$author_name]($link) [$author]($link)', resolve);
  const result = finalizeMarkdownLinks(extracted.text, extracted.pending);

  assert.equal(result.text, 'BOB ALICE');
});

test('buildFacets drops an auto-detected facet that overlaps a hand-built markdown-link facet', () => {
  // Regression test for Finding 3: RichText's constructor sorts facets but does not
  // dedupe/resolve overlaps - a display text that happens to contain a bare URL gets
  // rediscovered by detectFacets() as a second, overlapping facet unless merged here.
  const markdownFacets = [{byteStart: 0, byteEnd: 20, uri: 'https://example.com/real-link'}];
  const autoDetected = [
    {
      index: {byteStart: 5, byteEnd: 15}, // overlaps the markdown facet's [0,20) range
      features: [{$type: 'app.bsky.richtext.facet#link', uri: 'https://auto-detected.example'}],
    },
  ];
  const result = buildFacets(markdownFacets, autoDetected);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.index, {byteStart: 0, byteEnd: 20});
});

test('buildFacets keeps a non-overlapping auto-detected facet elsewhere in the same text', () => {
  const markdownFacets = [{byteStart: 0, byteEnd: 6, uri: 'https://example.com/report'}];
  const autoDetected = [
    {
      index: {byteStart: 7, byteEnd: 12}, // does not overlap [0,6)
      features: [{$type: 'app.bsky.richtext.facet#tag', tag: 'news'}],
    },
  ];
  const result = buildFacets(markdownFacets, autoDetected);

  assert.equal(result.length, 2);
  assert.deepEqual(result[0]?.index, {byteStart: 0, byteEnd: 6});
  assert.deepEqual(result[1]?.index, {byteStart: 7, byteEnd: 12});
});

test('extractMarkdownLinks resolves a bracket placeholder to feed content containing a literal $-shaped substring, without exposing it to a later bare-placeholder pass', () => {
  const extracted = extractMarkdownLinks(
    '[$description]($link)',
    token =>
      (
        ({
          $description: 'Remember to set $title in your config',
          $link: 'https://x.com',
        }) as Record<string, string>
      )[token],
  );
  // The marker-bearing carrier text must NOT contain the literal substring "$title" -
  // it's been captured inside the pending link's displayText, not spliced into the text
  // a bare-substitution pass would scan.
  assert.equal(extracted.text.includes('$title'), false);
  assert.equal(extracted.pending[0]?.displayText, 'Remember to set $title in your config');
});
