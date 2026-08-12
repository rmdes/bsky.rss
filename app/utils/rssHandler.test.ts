import {describe, it, test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert';
import fs, {mkdtempSync, rmSync} from 'fs';
import path from 'path';
import {tmpdir} from 'os';
import {createServer} from 'node:http';
import {FleetLogger} from '../../shared/logging/logger.ts';
import {createDbHandler, type DbHandler} from './dbHandler.ts';
import {createBskyHandler} from './bskyHandler.ts';
import {createQueueHandler, type QueueHandler} from './queueHandler.ts';
import {createRssHandler, type RssHandler} from './rssHandler.ts';

const testLogger = new FleetLogger({defaultLevel: 'summary', sink: () => undefined});

/**
 * Tests for rssHandler module
 *
 * Note: These tests focus on the module's string parsing, HTML handling,
 * and URL validation logic. Full RSS feed integration tests require
 * actual RSS feeds and are better suited for E2E tests.
 */

describe('rssHandler', () => {
  let testDataDir: string;
  let db: DbHandler;
  let rssHandler: RssHandler;

  beforeEach(async () => {
    testDataDir = mkdtempSync(path.join(tmpdir(), 'bsky-rss-test-'));
    db = createDbHandler(testDataDir);

    // Create minimal config for tests
    const testConfig = {
      string: '$title - $link',
      publishEmbed: true,
      embedType: 'card',
      languages: ['en'],
      truncate: true,
      runInterval: 60,
      dateField: '',
      publishDate: false,
      imageField: '',
      ogUserAgent: 'bsky.rss/test',
      descriptionClearHTML: true,
      forceDescriptionEmbed: false,
      imageAlt: '$title',
      removeDuplicate: false,
      titleClearHTML: false,
      adaptiveSpacing: false,
      spacingWindow: 600,
      minSpacing: 1,
      maxSpacing: 60,
    };

    fs.writeFileSync(path.join(testDataDir, 'config.json'), JSON.stringify(testConfig), 'utf8');

    const bsky = createBskyHandler(db, testLogger);
    const queue = createQueueHandler(bsky, db, testLogger);
    rssHandler = createRssHandler(queue, db, testLogger);
  });

  afterEach(() => {
    rmSync(testDataDir, {recursive: true, force: true});
  });

  describe('Module exports', () => {
    it('should export init, start, and launch functions', () => {
      assert(typeof rssHandler.init === 'function');
      assert(typeof rssHandler.start === 'function');
      assert(typeof rssHandler.launch === 'function');
    });
  });

  describe('String template parsing', () => {
    // Rewritten to call the real exported parseString instead of reimplementing its
    // .replace() logic inline - a regression in parseString itself wouldn't have failed
    // any of the original versions of these tests.
    it('should replace $title placeholder', () => {
      const {parseString} = rssHandler;
      const item = {
        id: '1',
        title: 'Test Article Title',
        link: 'https://example.com/article',
        date: '2026-08-08T00:00:00Z',
        description: 'Test description',
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };

      const result = parseString('$title', item, false);
      assert.strictEqual(result.text, 'Test Article Title');
    });

    it('should replace $link placeholder', () => {
      const {parseString} = rssHandler;
      const item = {
        id: '1',
        title: 'Test Article',
        link: 'https://example.com/article',
        date: '2026-08-08T00:00:00Z',
        description: 'Test description',
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };

      const result = parseString('Read more: $link', item, false);
      assert.strictEqual(result.text, 'Read more: https://example.com/article');
    });

    it('should use link directly as a plain string (NormalizedItem.link is never an object)', () => {
      // feedsub's Item.link could be a plain string or {href: string}, requiring a
      // typeof check to unwrap it. NormalizedItem.link (shared/feedSource) is always
      // string | undefined, so rssHandler.ts no longer has an object-link branch.
      const {parseString} = rssHandler;
      const item = {
        id: '1',
        title: 'Test Article',
        link: 'https://example.com/article',
        date: '2026-08-08T00:00:00Z',
        description: 'Test description',
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };

      const result = parseString('$link', item, false);
      assert.strictEqual(result.text, 'https://example.com/article');
    });

    it('should replace $description placeholder', () => {
      const {parseString} = rssHandler;
      const item = {
        id: '1',
        title: 'Test Article',
        link: 'https://example.com/article',
        date: '2026-08-08T00:00:00Z',
        description: 'This is a test description',
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };

      const result = parseString('$title - $description', item, false);
      assert.strictEqual(result.text, 'Test Article - This is a test description');
    });

    it('should handle multiple placeholders', () => {
      const {parseString} = rssHandler;
      const item = {
        id: '1',
        title: 'My Article',
        link: 'https://blog.com/post',
        date: '2026-08-08T00:00:00Z',
        description: 'Article about testing',
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };

      const result = parseString('$title - $link - $description', item, false);
      assert.strictEqual(result.text, 'My Article - https://blog.com/post - Article about testing');
    });

    it('should truncate long strings to 300 characters', () => {
      const {parseString} = rssHandler;
      const longTemplate =
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident.';
      assert(longTemplate.length > 300);
      const item = {
        id: '1',
        title: undefined,
        link: undefined,
        date: '2026-08-08T00:00:00Z',
        description: undefined,
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };

      const result = parseString(longTemplate, item, true);

      assert.strictEqual(result.text.length, 280); // 277 + '...'
      assert(result.text.endsWith('...'));
    });

    it('should not truncate strings under 300 characters', () => {
      const {parseString} = rssHandler;
      const shortTemplate = 'This is a short string';
      assert(shortTemplate.length <= 300);
      const item = {
        id: '1',
        title: undefined,
        link: undefined,
        date: '2026-08-08T00:00:00Z',
        description: undefined,
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };

      const result = parseString(shortTemplate, item, true);

      assert.strictEqual(result.text, shortTemplate);
      assert(!result.text.endsWith('...'));
    });
  });

  describe('Markdown link syntax in parseString', () => {
    test('parseString throws when [$title](...) is used but the item has no title, matching bare $title', () => {
      const {parseString} = rssHandler;

      const item = {
        id: '1',
        title: undefined,
        link: 'https://example.com/1',
        date: '2026-08-08T00:00:00Z',
        description: undefined,
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };
      assert.throws(
        () => parseString('[$title]($link)', item, false),
        /No title provided from RSS reader/,
      );
    });

    test('parseString resolves [text]($georss) to plain text with no facet when the item has no geo data', () => {
      const {parseString} = rssHandler;

      const item = {
        id: '1',
        title: 'T',
        link: 'https://example.com/1',
        date: '2026-08-08T00:00:00Z',
        description: undefined,
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };
      const result = parseString('[Map]($georss)', item, false);
      assert.equal(result.text, 'Map');
      assert.deepEqual(result.facets, []);
    });

    test('parseString resolves [$title]($link) to a real facet with correct byte offsets', () => {
      const {parseString} = rssHandler;

      const item = {
        id: '1',
        title: 'Breaking',
        link: 'https://example.com/1',
        date: '2026-08-08T00:00:00Z',
        description: undefined,
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };
      const result = parseString('[$title]($link)', item, false);
      assert.equal(result.text, 'Breaking');
      assert.deepEqual(result.facets, [{byteStart: 0, byteEnd: 8, uri: 'https://example.com/1'}]);
    });

    test('parseString leaves bracket-free templates and their facets array empty, unchanged from today', () => {
      const {parseString} = rssHandler;

      const item = {
        id: '1',
        title: 'Breaking',
        link: 'https://example.com/1',
        date: '2026-08-08T00:00:00Z',
        description: undefined,
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };
      const result = parseString('$title - $link', item, false);
      assert.equal(result.text, 'Breaking - https://example.com/1');
      assert.deepEqual(result.facets, []);
    });

    test('parseString drops a facet entirely when truncation cuts into its byte range, instead of emitting a corrupted byteEnd', () => {
      const {parseString} = rssHandler;

      const longTitle = 'x'.repeat(320); // resolved display text alone exceeds the 300-char truncate threshold
      const item = {
        id: '1',
        title: longTitle,
        link: 'https://example.com/1',
        date: '2026-08-08T00:00:00Z',
        description: undefined,
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };
      const result = parseString('[$title]($link)', item, true);
      assert.equal(result.text.length, 280); // 277 + '...'
      assert.deepEqual(result.facets, []); // the one facet's byteEnd (320) exceeds the truncated length (280) - dropped
    });

    test('parseString keeps a facet that fits entirely within the truncated text', () => {
      const {parseString} = rssHandler;

      const item = {
        id: '1',
        title: 'Short',
        link: 'https://example.com/1',
        date: '2026-08-08T00:00:00Z',
        description: 'y'.repeat(300),
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };
      // The [text](url) facet is near the start, well within the 277-byte truncation boundary,
      // even though the overall post gets truncated because of the long trailing $description.
      const result = parseString('[$title]($link) $description', item, true);
      assert.equal(result.text.length, 280);
      assert.deepEqual(result.facets, [{byteStart: 0, byteEnd: 5, uri: 'https://example.com/1'}]);
    });

    test('parseString computes correct facet byte offsets when a bare placeholder precedes a bracket span', () => {
      const {parseString} = rssHandler;

      const item = {
        id: '1',
        title: 'A much longer title than the placeholder',
        link: 'https://x.com',
        date: '2026-08-08T00:00:00Z',
        description: undefined,
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };
      const result = parseString('$title - [text]($link)', item, false);
      assert.equal(result.text, 'A much longer title than the placeholder - text');
      const bytes = Buffer.from(result.text, 'utf8');
      const facet = result.facets[0];
      assert(facet);
      const facetText = bytes.slice(facet.byteStart, facet.byteEnd).toString('utf8');
      assert.equal(facetText, 'text');
    });

    test('parseString drops a facet whose byteEnd lands just past the 277-byte cutoff instead of letting it survive covering part of the appended ellipsis', () => {
      // Regression test for Finding 1: computing the truncation byte-length ceiling on
      // the string that ALREADY has '...' appended let a facet whose byteEnd fell 1-3
      // bytes past the real 277-byte cutoff survive, ending up covering the appended
      // ellipsis. Facet here spans bytes [270, 279) - 2 bytes past the cutoff.
      const {parseString} = rssHandler;

      const item = {
        id: '1',
        title: undefined,
        link: 'https://example.com/1',
        date: '2026-08-08T00:00:00Z',
        description: undefined,
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };
      const template = 'y'.repeat(270) + '[CLICKHERE]($link)' + 'z'.repeat(100);
      const result = parseString(template, item, true);
      assert.equal(result.text.length, 280);
      assert.ok(result.text.endsWith('...'));
      assert.deepEqual(result.facets, []); // byteEnd 279 > 277-byte cutoff - dropped, not partially retained
    });

    test('parseString resolves [$georss](...) used as DISPLAY text to an empty, vanished span on a geo-less item, not the literal string "$georss"', () => {
      // Regression test for Finding 5: the bracket-resolver closure returned undefined
      // for $georss with no geo data, so resolve(token) ?? token left the literal text
      // "$georss" behind. The bare substitution path already correctly used '' for this
      // same case.
      const {parseString} = rssHandler;

      const item = {
        id: '1',
        title: 'T',
        link: 'https://example.com/1',
        date: '2026-08-08T00:00:00Z',
        description: undefined,
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };
      const result = parseString('before [$georss]($link) after', item, false);
      assert.equal(result.text, 'before  after');
      assert.deepEqual(result.facets, []);
    });

    test('parseString does not throw or corrupt when resolved feed content inside a bracket happens to contain a $-shaped substring', () => {
      const {parseString} = rssHandler;

      const item = {
        id: '1',
        title: undefined,
        link: 'https://x.com',
        date: '2026-08-08T00:00:00Z',
        description: 'Remember to set $title in your config',
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };
      const result = parseString('[$description]($link)', item, false);
      assert.equal(result.text, 'Remember to set $title in your config');
      assert.deepEqual(result.facets, [{byteStart: 0, byteEnd: 37, uri: 'https://x.com'}]);
    });
  });

  describe('HTML tag removal', () => {
    // Rewritten to drive real removeHTMLTags through parseString via $description
    // (descriptionClearHTML defaults to true on a fresh handler, see rssHandler.ts's
    // default config) instead of reimplementing the stripping regex inline.
    // removeHTMLTags itself stays unexported, same as fixMalformedUrl - parseString is
    // the real, exported surface that exercises it.
    function descItem(description: string) {
      return {
        id: '1',
        title: undefined,
        link: undefined,
        date: '2026-08-08T00:00:00Z',
        description,
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };
    }

    it('should remove simple HTML tags', () => {
      const {parseString} = rssHandler;
      const result = parseString('$description', descItem('<p>Hello world</p>'), false);
      assert.strictEqual(result.text, 'Hello world');
    });

    it('should remove multiple HTML tags', () => {
      const {parseString} = rssHandler;
      const result = parseString(
        '$description',
        descItem('<div><p>Paragraph</p><span>Span text</span></div>'),
        false,
      );
      assert.strictEqual(result.text, 'Paragraph Span text');
    });

    it('should replace &nbsp; with space', () => {
      const {parseString} = rssHandler;
      const result = parseString('$description', descItem('Hello&nbsp;world'), false);
      assert.strictEqual(result.text, 'Hello world');
    });

    it('should handle strong/em tags', () => {
      const {parseString} = rssHandler;
      const result = parseString(
        '$description',
        descItem('This is <strong>bold</strong> and <em>italic</em> text'),
        false,
      );
      assert.strictEqual(result.text, 'This is bold and italic text');
    });

    it('should handle nested tags', () => {
      const {parseString} = rssHandler;
      const result = parseString(
        '$description',
        descItem('<div><p>Outer <span>inner</span> text</p></div>'),
        false,
      );
      assert.strictEqual(result.text, 'Outer inner text');
    });

    it('should handle self-closing tags', () => {
      const {parseString} = rssHandler;
      const result = parseString(
        '$description',
        descItem('Line one<br/>Line two<hr/>Line three'),
        false,
      );
      assert.strictEqual(result.text, 'Line one Line two Line three');
    });

    it('should collapse multiple spaces', () => {
      const {parseString} = rssHandler;
      const result = parseString(
        '$description',
        descItem('<p>Text   with    multiple     spaces</p>'),
        false,
      );
      assert.strictEqual(result.text, 'Text with multiple spaces');
    });
  });

  describe('HTML entity decoding', () => {
    // decodeHTML (unexported, double-decode: &amp;#233; -> &#233; -> é) only ever runs
    // on $title, gated behind config.titleClearHTML - unlike descriptionClearHTML this
    // defaults to false, so these tests write a config with titleClearHTML:true and
    // call the real init()/parseString rather than reimplementing decode() by hand.
    // init() only builds the (unstarted) feed reader from config - it never fetches
    // fetch_url, so this stays fully offline.
    async function titleClearHTMLHandler() {
      fs.writeFileSync(
        path.join(testDataDir, 'config.json'),
        JSON.stringify({
          string: '$title',
          publishEmbed: false,
          languages: ['en'],
          truncate: true,
          runInterval: 60,
          dateField: '',
          publishDate: false,
          imageField: '',
          ogUserAgent: 'bsky.rss/test',
          descriptionClearHTML: true,
          removeDuplicate: false,
          titleClearHTML: true,
        }),
        'utf8',
      );
      await rssHandler.init({
        fetch_interval: 60,
        fetch_url: new URL('http://127.0.0.1:1/unused'),
      });
      return rssHandler;
    }

    function titleItem(title: string) {
      return {
        id: '1',
        title,
        link: undefined,
        date: '2026-08-08T00:00:00Z',
        description: undefined,
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };
    }

    it('should decode encoded HTML entities', async () => {
      const handler = await titleClearHTMLHandler();
      const testCases = [
        {input: '&lt;', expected: '<'},
        {input: '&gt;', expected: '>'},
        {input: '&amp;', expected: '&'},
        {input: '&quot;', expected: '"'},
        {input: '&#233;', expected: 'é'},
        {input: '&#8217;', expected: '’'}, // Right single quote
      ];

      for (const tc of testCases) {
        const result = handler.parseString('$title', titleItem(tc.input), false);
        assert.strictEqual(result.text, tc.expected, `Failed for ${tc.input}`);
      }
    });

    it('should handle double-encoded entities', async () => {
      // &amp;#233; -> &#233; -> é
      const handler = await titleClearHTMLHandler();
      const result = handler.parseString('$title', titleItem('&amp;#233;'), false);
      assert.strictEqual(result.text, 'é');
    });

    it('should handle mixed text and entities', async () => {
      const handler = await titleClearHTMLHandler();
      // &nbsp; decodes to U+00A0 (non-breaking space), not a regular space - but
      // removeHTMLTags runs first and normalizes &nbsp; to a plain space, so the final
      // text uses a plain space here too.
      const result = handler.parseString(
        '$title',
        titleItem('Tom &amp; Jerry: A&nbsp;Classic'),
        false,
      );
      assert.strictEqual(result.text, 'Tom & Jerry: A Classic');
    });

    it('should handle numeric character references', async () => {
      const handler = await titleClearHTMLHandler();
      const input = '&#8220;Hello&#8221;'; // Smart quotes (char codes 8220 and 8221)
      const result = handler.parseString('$title', titleItem(input), false);

      assert(result.text.includes('Hello'));
      assert.notStrictEqual(result.text, input);
      assert(result.text.length > 'Hello'.length);
    });
  });

  // "URL validation and fixing" (fixMalformedUrl) deleted rather than rewritten:
  // fixMalformedUrl is unexported and only reachable through handleItem's Open Graph
  // embed-building path, which requires a real (mocked) og:url response - the og()
  // call isn't injected into createRssHandler the way db/queue are, so reaching it
  // would mean intercepting the `open-graph-scraper` module itself. Disproportionate
  // test infrastructure for a single regex fix-up; deleted per task instructions
  // rather than forcing a bad test.

  describe('Configuration handling', () => {
    // Rewritten to drive titleClearHTML/descriptionClearHTML/imageAlt through the real
    // parseString instead of reimplementing the stripping regex inline (see "HTML tag
    // removal" above for why $description alone already exercises descriptionClearHTML,
    // and "HTML entity decoding" for the titleClearHTML config-writing helper).
    //
    // The rest of the original block (publishEmbed, embedType, dateField, imageField,
    // image-type validation) is deleted rather than rewritten:
    //  - publishEmbed/embedType sub-tests asserted nothing but JS object-literal/array
    //    equality - no rssHandler.ts logic was under test.
    //  - the dateField sub-test asserted a pubdate/published fallback chain that no
    //    longer exists in handleItem (today: `config.dateField ? item[config.dateField]
    //    : item.date`, no fallback chain - see the comment above handleItem in
    //    rssHandler.ts). It tested removed behavior, not current behavior, and all 59
    //    live bot configs leave dateField empty today per that same comment.
    //  - imageField/image-type-validation sub-tests tested logic that has moved to
    //    shared/feedSource/imageResolver.ts, which has its own real test coverage in
    //    shared/feedSource/imageResolver.test.ts - it doesn't belong in rssHandler.ts's
    //    suite anymore.
    it('should use titleClearHTML config for title processing', async () => {
      fs.writeFileSync(
        path.join(testDataDir, 'config.json'),
        JSON.stringify({
          string: '$title',
          publishEmbed: false,
          languages: ['en'],
          truncate: true,
          runInterval: 60,
          dateField: '',
          publishDate: false,
          imageField: '',
          ogUserAgent: 'bsky.rss/test',
          descriptionClearHTML: true,
          removeDuplicate: false,
          titleClearHTML: true,
        }),
        'utf8',
      );
      await rssHandler.init({
        fetch_interval: 60,
        fetch_url: new URL('http://127.0.0.1:1/unused'),
      });

      const item = {
        id: '1',
        title: '<strong>Bold Title</strong>',
        link: undefined,
        date: '2026-08-08T00:00:00Z',
        description: undefined,
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };
      const result = rssHandler.parseString('$title', item, false);
      assert.strictEqual(result.text, 'Bold Title');
    });

    it('should use descriptionClearHTML config for description', () => {
      // descriptionClearHTML defaults to true on a fresh handler (see rssHandler.ts's
      // default config), so no init() with a custom config is needed here.
      const {parseString} = rssHandler;
      const item = {
        id: '1',
        title: undefined,
        link: undefined,
        date: '2026-08-08T00:00:00Z',
        description: '<p>Description with <em>tags</em></p>',
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };
      const result = parseString('$description', item, false);
      assert.strictEqual(result.text, 'Description with tags');
    });

    it('should handle imageAlt template string', () => {
      // config.imageAlt is itself just a parseString template - handleItem resolves it
      // via `parseString(config.imageAlt, item, false).text` (see rssHandler.ts), so
      // calling parseString the same way here exercises the real resolution path.
      const {parseString} = rssHandler;
      const item = {
        id: '1',
        title: 'Test Image',
        link: undefined,
        date: '2026-08-08T00:00:00Z',
        description: undefined,
        content: undefined,
        imageUrl: undefined,
        geo: undefined,
        mappedValues: {},
      };
      const result = parseString('$title', item, false);
      assert.strictEqual(result.text, 'Test Image');
    });
  });

  describe('Embed construction', () => {
    // Rewritten to drive real handleItem embed construction end-to-end, following the
    // "Cross-poll deduplication" tests' pattern below (real feed server + createRssHandler
    // + a fake queue) - handleItem isn't exported, and its embed-building only runs
    // inside the Open Graph fetch path (`og()`, imported directly rather than injected,
    // so it can't be swapped for a mock the way db/queue can). A real local HTTP server
    // standing in for the target page lets these hit the genuine code path without
    // reaching the public internet.
    //
    // Narrower variants from the original block (the 'image' embedType, and the
    // "no description"/"no image" cases as isolated concerns) are not each given their
    // own real end-to-end test: embedType:'image' additionally exercises axios+Jimp
    // image decoding, and bskyHandler's own embed_data construction from embed.type -
    // disproportionate infrastructure for what this file is testing. The two tests below
    // already assert embed.image is undefined as a natural consequence of the OG image
    // fetch failing, covering that case without a dedicated test.
    it('queues a card embed built from real Open Graph title/description data, end-to-end', async () => {
      let ogPort = 0;
      const ogServer = createServer((req, res) => {
        if (req.url === '/broken.jpg') {
          res.writeHead(404);
          res.end('not an image');
          return;
        }
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(
          '<!DOCTYPE html><html><head>' +
            '<meta property="og:title" content="Open Graph Title" />' +
            '<meta property="og:description" content="Open Graph description" />' +
            `<meta property="og:image" content="http://127.0.0.1:${ogPort}/broken.jpg" />` +
            '</head><body></body></html>',
        );
      });
      await new Promise<void>(resolve => ogServer.listen(0, resolve));
      ogPort = (ogServer.address() as {port: number}).port;
      const articleUrl = `http://127.0.0.1:${ogPort}/article`;

      const feedBody =
        '<?xml version="1.0"?><rss version="2.0"><channel>' +
        '<title>T</title><description>D</description><link>https://example.com</link>' +
        `<item><title>Fallback Title</title><link>${articleUrl}</link>` +
        `<guid>${articleUrl}</guid>` +
        '<pubDate>Wed, 05 Aug 2026 09:00:00 GMT</pubDate></item>' +
        '</channel></rss>';
      const feedServer = createServer((_req, res) => {
        res.writeHead(200, {'Content-Type': 'application/rss+xml'});
        res.end(feedBody);
      });
      await new Promise<void>(resolve => feedServer.listen(0, resolve));
      const feedPort = (feedServer.address() as {port: number}).port;

      fs.writeFileSync(
        path.join(testDataDir, 'config.json'),
        JSON.stringify({
          string: '$title',
          publishEmbed: true,
          embedType: 'card',
          languages: ['en'],
          truncate: true,
          runInterval: 60,
          dateField: '',
          imageField: '',
          ogUserAgent: 'bsky.rss/test',
          descriptionClearHTML: true,
          removeDuplicate: false,
        }),
        'utf8',
      );
      fs.writeFileSync(path.join(testDataDir, 'last.txt'), '2026-08-01T00:00:00.000Z', 'utf8');

      const queued: QueueItems[] = [];
      const fakeQueue: QueueHandler = {
        writeQueue: async (item: QueueItems) => {
          queued.push(item);
          return queued;
        },
        start: async () => {},
        runQueue: async (): Promise<QueueItems[]> => queued,
        computeDelay: () => 0,
      };
      const testRssHandler = createRssHandler(fakeQueue, db, testLogger);

      try {
        const reader = await testRssHandler.init({
          fetch_interval: 60,
          fetch_url: new URL(`http://127.0.0.1:${feedPort}/feed.xml`),
        });
        await testRssHandler.start();
        await new Promise(resolve => setTimeout(resolve, 500));
        reader.stop();
      } finally {
        feedServer.close();
        ogServer.close();
      }

      assert.strictEqual(queued.length, 1);
      const embed = queued[0]?.embed;
      assert(embed, 'embed should be built');
      assert.strictEqual(embed.type, 'card');
      assert.strictEqual(embed.uri, articleUrl);
      assert.strictEqual(embed.title, 'Open Graph Title');
      assert.strictEqual(embed.description, 'Open Graph description');
      assert.strictEqual(embed.image, undefined); // og:image pointed at a 404 - fetch failed, non-fatal
    });

    it("falls back to the item's own title/description when the Open Graph fetch fails, end-to-end", async () => {
      // item.link points at a closed local port so og() rejects immediately and
      // handleItem takes its `.catch(() => ({error: true}))` fallback branch.
      const closedPortUrl = 'http://127.0.0.1:1/unreachable';

      const feedBody =
        '<?xml version="1.0"?><rss version="2.0"><channel>' +
        '<title>T</title><description>D</description><link>https://example.com</link>' +
        `<item><title>Item Title</title><link>${closedPortUrl}</link>` +
        `<guid>${closedPortUrl}</guid>` +
        '<pubDate>Wed, 05 Aug 2026 09:00:00 GMT</pubDate>' +
        '<description>Item description</description></item>' +
        '</channel></rss>';
      const feedServer = createServer((_req, res) => {
        res.writeHead(200, {'Content-Type': 'application/rss+xml'});
        res.end(feedBody);
      });
      await new Promise<void>(resolve => feedServer.listen(0, resolve));
      const feedPort = (feedServer.address() as {port: number}).port;

      fs.writeFileSync(
        path.join(testDataDir, 'config.json'),
        JSON.stringify({
          string: '$title',
          publishEmbed: true,
          embedType: 'card',
          languages: ['en'],
          truncate: true,
          runInterval: 60,
          dateField: '',
          imageField: '',
          ogUserAgent: 'bsky.rss/test',
          descriptionClearHTML: true,
          removeDuplicate: false,
        }),
        'utf8',
      );
      fs.writeFileSync(path.join(testDataDir, 'last.txt'), '2026-08-01T00:00:00.000Z', 'utf8');

      const queued: QueueItems[] = [];
      const fakeQueue: QueueHandler = {
        writeQueue: async (item: QueueItems) => {
          queued.push(item);
          return queued;
        },
        start: async () => {},
        runQueue: async (): Promise<QueueItems[]> => queued,
        computeDelay: () => 0,
      };
      const testRssHandler = createRssHandler(fakeQueue, db, testLogger);

      try {
        const reader = await testRssHandler.init({
          fetch_interval: 60,
          fetch_url: new URL(`http://127.0.0.1:${feedPort}/feed.xml`),
        });
        await testRssHandler.start();
        await new Promise(resolve => setTimeout(resolve, 500));
        reader.stop();
      } finally {
        feedServer.close();
      }

      assert.strictEqual(queued.length, 1);
      const embed = queued[0]?.embed;
      assert(embed, 'embed should be built');
      assert.strictEqual(embed.type, 'card');
      assert.strictEqual(embed.uri, closedPortUrl);
      assert.strictEqual(embed.title, 'Item Title');
      assert.strictEqual(embed.description, 'Item description');
      assert.strictEqual(embed.image, undefined);
    });
  });

  describe('Cross-poll deduplication', () => {
    // The shared/feedSource poller deliberately re-delivers every parsed item on every
    // poll (feedsub used to hide this behind its own internal item history). This is the
    // only test that drives the real rssHandler.init()/start() against a real feed, so
    // it is the only thing that can catch the "lastDate never advances" regression -
    // every other test in this file replicates logic inline against local objects.
    it('queues a repeated feed item only once across multiple polls', async () => {
      const feedBody =
        '<?xml version="1.0"?><rss version="2.0"><channel>' +
        '<title>T</title><description>D</description><link>https://example.com</link>' +
        '<item><title>Only Item</title><link>https://example.com/only</link>' +
        '<guid>https://example.com/only</guid>' +
        '<pubDate>Wed, 05 Aug 2026 09:00:00 GMT</pubDate></item>' +
        '</channel></rss>';

      let pollCount = 0;
      const server = createServer((_req, res) => {
        pollCount++;
        res.writeHead(200, {'Content-Type': 'application/rss+xml'});
        res.end(feedBody);
      });
      await new Promise<void>(resolve => server.listen(0, resolve));
      const port = (server.address() as {port: number}).port;

      // publishEmbed:false keeps handleItem entirely offline (no Open Graph/image
      // fetch) while still exercising both staleness guards and the queue handoff.
      fs.writeFileSync(
        path.join(testDataDir, 'config.json'),
        JSON.stringify({
          string: '$title',
          publishEmbed: false,
          languages: ['en'],
          truncate: true,
          runInterval: 60,
          dateField: '',
          imageField: '',
          ogUserAgent: 'bsky.rss/test',
          removeDuplicate: false,
        }),
        'utf8',
      );

      fs.writeFileSync(path.join(testDataDir, 'last.txt'), '2026-08-01T00:00:00.000Z', 'utf8');

      // rssHandler now takes its queue dependency directly - no need to monkey-patch a
      // shared singleton anymore, and testDataDir is removed whole in this file's afterEach,
      // so there's no real last.txt to save/restore around this test.
      const queued: QueueItems[] = [];
      const fakeQueue: QueueHandler = {
        writeQueue: async (item: QueueItems) => {
          queued.push(item);
          return queued;
        },
        start: async () => {},
        runQueue: async (): Promise<QueueItems[]> => queued,
        computeDelay: () => 0,
      };
      const testRssHandler = createRssHandler(fakeQueue, db, testLogger);

      try {
        // 0.002 minutes = 120ms, so several polls fire inside the wait below.
        const reader = await testRssHandler.init({
          fetch_interval: 0.002,
          fetch_url: new URL(`http://127.0.0.1:${port}/feed.xml`),
        });
        await testRssHandler.start();
        await new Promise(resolve => setTimeout(resolve, 500));
        reader.stop();
      } finally {
        server.close();
      }

      assert(pollCount >= 2, `expected at least 2 polls, got ${pollCount}`);
      assert.strictEqual(
        queued.length,
        1,
        `item was queued ${queued.length} times across ${pollCount} polls`,
      );
    });

    it('queues every item in a newest-first batch exactly once, not just the newest', async () => {
      // Break caught: advancing lastDate per-item (instead of once per batch, after all
      // items are processed) meant that on a newest-first feed, queueing item 1 (the
      // newest) already moved lastDate past item 2's date - so item 2 failed the
      // staleness guard and was silently dropped forever, not merely delayed.
      const feedBody =
        '<?xml version="1.0"?><rss version="2.0"><channel>' +
        '<title>T</title><description>D</description><link>https://example.com</link>' +
        '<item><title>Newest</title><link>https://example.com/newest</link>' +
        '<guid>https://example.com/newest</guid>' +
        '<pubDate>Wed, 05 Aug 2026 09:00:00 GMT</pubDate></item>' +
        '<item><title>Middle</title><link>https://example.com/middle</link>' +
        '<guid>https://example.com/middle</guid>' +
        '<pubDate>Wed, 05 Aug 2026 08:00:00 GMT</pubDate></item>' +
        '<item><title>Oldest</title><link>https://example.com/oldest</link>' +
        '<guid>https://example.com/oldest</guid>' +
        '<pubDate>Wed, 05 Aug 2026 07:00:00 GMT</pubDate></item>' +
        '</channel></rss>';

      let pollCount = 0;
      const server = createServer((_req, res) => {
        pollCount++;
        res.writeHead(200, {'Content-Type': 'application/rss+xml'});
        res.end(feedBody);
      });
      await new Promise<void>(resolve => server.listen(0, resolve));
      const port = (server.address() as {port: number}).port;

      fs.writeFileSync(
        path.join(testDataDir, 'config.json'),
        JSON.stringify({
          string: '$title',
          publishEmbed: false,
          languages: ['en'],
          truncate: true,
          runInterval: 60,
          dateField: '',
          imageField: '',
          ogUserAgent: 'bsky.rss/test',
          removeDuplicate: false,
        }),
        'utf8',
      );

      fs.writeFileSync(path.join(testDataDir, 'last.txt'), '2026-08-01T00:00:00.000Z', 'utf8');

      // rssHandler now takes its queue dependency directly - no need to monkey-patch a
      // shared singleton anymore, and testDataDir is removed whole in this file's afterEach,
      // so there's no real last.txt to save/restore around this test.
      const queued: QueueItems[] = [];
      const fakeQueue: QueueHandler = {
        writeQueue: async (item: QueueItems) => {
          queued.push(item);
          return queued;
        },
        start: async () => {},
        runQueue: async (): Promise<QueueItems[]> => queued,
        computeDelay: () => 0,
      };
      const testRssHandler = createRssHandler(fakeQueue, db, testLogger);

      try {
        // 0.002 minutes = 120ms, so several polls fire inside the wait below - proving
        // both "no item lost within one batch" and "no item re-queued across polls".
        const reader = await testRssHandler.init({
          fetch_interval: 0.002,
          fetch_url: new URL(`http://127.0.0.1:${port}/feed.xml`),
        });
        await testRssHandler.start();
        await new Promise(resolve => setTimeout(resolve, 500));
        reader.stop();
      } finally {
        server.close();
      }

      assert(pollCount >= 2, `expected at least 2 polls, got ${pollCount}`);
      assert.deepStrictEqual(
        queued.map(item => item.title).sort(),
        ['Middle', 'Newest', 'Oldest'],
        `expected all 3 items queued exactly once each, got: ${JSON.stringify(queued.map(item => item.title))}`,
      );
    });

    it('substitutes $georss with an OpenStreetMap link built from georss:point', async () => {
      const feedBody =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:georss="http://www.georss.org/georss">' +
        '<title>T</title><id>https://example.com/geo-atom</id>' +
        '<updated>2026-08-07T10:00:00Z</updated>' +
        '<entry><title>Quake</title><id>https://example.com/geo-atom/entry-1</id>' +
        '<published>2026-08-07T09:00:00Z</published><updated>2026-08-07T09:00:00Z</updated>' +
        '<georss:point>47.391 -70.2406</georss:point></entry>' +
        '</feed>';

      const server = createServer((_req, res) => {
        res.writeHead(200, {'Content-Type': 'application/atom+xml'});
        res.end(feedBody);
      });
      await new Promise<void>(resolve => server.listen(0, resolve));
      const port = (server.address() as {port: number}).port;

      fs.writeFileSync(
        path.join(testDataDir, 'config.json'),
        JSON.stringify({
          string: '$title $georss',
          publishEmbed: false,
          languages: ['en'],
          truncate: true,
          runInterval: 60,
          dateField: '',
          imageField: '',
          ogUserAgent: 'bsky.rss/test',
          removeDuplicate: false,
        }),
        'utf8',
      );

      fs.writeFileSync(path.join(testDataDir, 'last.txt'), '2026-08-01T00:00:00.000Z', 'utf8');

      // rssHandler now takes its queue dependency directly - no need to monkey-patch a
      // shared singleton anymore, and testDataDir is removed whole in this file's afterEach,
      // so there's no real last.txt to save/restore around this test.
      const queued: QueueItems[] = [];
      const fakeQueue: QueueHandler = {
        writeQueue: async (item: QueueItems) => {
          queued.push(item);
          return queued;
        },
        start: async () => {},
        runQueue: async (): Promise<QueueItems[]> => queued,
        computeDelay: () => 0,
      };
      const testRssHandler = createRssHandler(fakeQueue, db, testLogger);

      try {
        const reader = await testRssHandler.init({
          fetch_interval: 60,
          fetch_url: new URL(`http://127.0.0.1:${port}/feed.xml`),
        });
        await testRssHandler.start();
        await new Promise(resolve => setTimeout(resolve, 300));
        reader.stop();
      } finally {
        server.close();
      }

      assert.strictEqual(queued.length, 1);
      assert.strictEqual(
        queued[0]?.content,
        'Quake https://www.openstreetmap.org/?mlat=47.391&mlon=-70.2406',
      );
    });

    it('substitutes $key placeholders from mappedValues with real dc:creator data', async () => {
      const feedBody =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        '<channel><title>T</title><description>D</description><link>https://example.com</link>' +
        '<item><title>Article</title><link>https://example.com/article</link>' +
        '<guid>https://example.com/article</guid>' +
        '<pubDate>Wed, 05 Aug 2026 09:00:00 GMT</pubDate>' +
        '<dc:creator>Jane Doe</dc:creator></item>' +
        '</channel></rss>';

      const server = createServer((_req, res) => {
        res.writeHead(200, {'Content-Type': 'application/rss+xml'});
        res.end(feedBody);
      });
      await new Promise<void>(resolve => server.listen(0, resolve));
      const port = (server.address() as {port: number}).port;

      fs.writeFileSync(
        path.join(testDataDir, 'config.json'),
        JSON.stringify({
          string: '$title by $author',
          publishEmbed: false,
          languages: ['en'],
          truncate: true,
          runInterval: 60,
          dateField: '',
          imageField: '',
          ogUserAgent: 'bsky.rss/test',
          removeDuplicate: false,
          mappedValues: [{key: 'author', value: 'dc:creator'}],
        }),
        'utf8',
      );

      fs.writeFileSync(path.join(testDataDir, 'last.txt'), '2026-08-01T00:00:00.000Z', 'utf8');

      // rssHandler now takes its queue dependency directly - no need to monkey-patch a
      // shared singleton anymore, and testDataDir is removed whole in this file's afterEach,
      // so there's no real last.txt to save/restore around this test.
      const queued: QueueItems[] = [];
      const fakeQueue: QueueHandler = {
        writeQueue: async (item: QueueItems) => {
          queued.push(item);
          return queued;
        },
        start: async () => {},
        runQueue: async (): Promise<QueueItems[]> => queued,
        computeDelay: () => 0,
      };
      const testRssHandler = createRssHandler(fakeQueue, db, testLogger);

      try {
        const reader = await testRssHandler.init({
          fetch_interval: 60,
          fetch_url: new URL(`http://127.0.0.1:${port}/feed.xml`),
        });
        await testRssHandler.start();
        await new Promise(resolve => setTimeout(resolve, 300));
        reader.stop();
      } finally {
        server.close();
      }

      assert.strictEqual(queued.length, 1);
      assert.strictEqual(queued[0]?.content, 'Article by Jane Doe');
    });

    it('substitutes $authorName correctly even when the shorter "author" key is declared first in mappedValues', async () => {
      // Confirmed bug: mappedValues substitution followed Object.entries insertion
      // order. The template here only uses $authorName (no separate $author). With
      // "author" declared first, its placeholder "$author" is a literal prefix
      // substring of "$authorName" in the template text, so the .includes('$author')
      // check falsely matches and corrupts the front of $authorName before authorName's
      // own turn ever runs.
      const feedBody =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        '<channel><title>T</title><description>D</description><link>https://example.com</link>' +
        '<item><title>Article</title><link>https://example.com/article</link>' +
        '<guid>https://example.com/article</guid>' +
        '<pubDate>Wed, 05 Aug 2026 09:00:00 GMT</pubDate>' +
        '<dc:creator>Jane</dc:creator><dc:publisher>Jane Smith</dc:publisher></item>' +
        '</channel></rss>';

      const server = createServer((_req, res) => {
        res.writeHead(200, {'Content-Type': 'application/rss+xml'});
        res.end(feedBody);
      });
      await new Promise<void>(resolve => server.listen(0, resolve));
      const port = (server.address() as {port: number}).port;

      fs.writeFileSync(
        path.join(testDataDir, 'config.json'),
        JSON.stringify({
          string: 'By $authorName',
          publishEmbed: false,
          languages: ['en'],
          truncate: true,
          runInterval: 60,
          dateField: '',
          imageField: '',
          ogUserAgent: 'bsky.rss/test',
          removeDuplicate: false,
          mappedValues: [
            {key: 'author', value: 'dc:creator'},
            {key: 'authorName', value: 'dc:publisher'},
          ],
        }),
        'utf8',
      );

      fs.writeFileSync(path.join(testDataDir, 'last.txt'), '2026-08-01T00:00:00.000Z', 'utf8');

      // rssHandler now takes its queue dependency directly - no need to monkey-patch a
      // shared singleton anymore, and testDataDir is removed whole in this file's afterEach,
      // so there's no real last.txt to save/restore around this test.
      const queued: QueueItems[] = [];
      const fakeQueue: QueueHandler = {
        writeQueue: async (item: QueueItems) => {
          queued.push(item);
          return queued;
        },
        start: async () => {},
        runQueue: async (): Promise<QueueItems[]> => queued,
        computeDelay: () => 0,
      };
      const testRssHandler = createRssHandler(fakeQueue, db, testLogger);

      try {
        const reader = await testRssHandler.init({
          fetch_interval: 60,
          fetch_url: new URL(`http://127.0.0.1:${port}/feed.xml`),
        });
        await testRssHandler.start();
        await new Promise(resolve => setTimeout(resolve, 300));
        reader.stop();
      } finally {
        server.close();
      }

      assert.strictEqual(queued.length, 1);
      assert.strictEqual(queued[0]?.content, 'By Jane Smith');
    });

    it('does not let the mappedValues loop touch a $key-shaped placeholder leaked from $description feed content', async () => {
      // Confirmed bug: the mappedValues loop guarded its substitution with
      // `.includes()` on the string-in-progress (already containing $description's
      // substituted content), unlike every other branch which guards against the
      // original template string. So feed-supplied content that happens to
      // literally contain "$author" (e.g. a description reading "buy now $author")
      // got treated as a real placeholder and substituted, corrupting the feed
      // content while leaving the operator's real $author placeholder elsewhere in
      // the template unsubstituted.
      const feedBody =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        '<channel><title>T</title><description>D</description><link>https://example.com</link>' +
        '<item><title>Article</title><link>https://example.com/article</link>' +
        '<guid>https://example.com/article</guid>' +
        '<pubDate>Wed, 05 Aug 2026 09:00:00 GMT</pubDate>' +
        '<description>buy now $author</description>' +
        '<dc:creator>Real Author</dc:creator></item>' +
        '</channel></rss>';

      const server = createServer((_req, res) => {
        res.writeHead(200, {'Content-Type': 'application/rss+xml'});
        res.end(feedBody);
      });
      await new Promise<void>(resolve => server.listen(0, resolve));
      const port = (server.address() as {port: number}).port;

      fs.writeFileSync(
        path.join(testDataDir, 'config.json'),
        JSON.stringify({
          string: '$description | $author',
          publishEmbed: false,
          languages: ['en'],
          truncate: true,
          runInterval: 60,
          dateField: '',
          imageField: '',
          ogUserAgent: 'bsky.rss/test',
          removeDuplicate: false,
          descriptionClearHTML: false,
          mappedValues: [{key: 'author', value: 'dc:creator'}],
        }),
        'utf8',
      );

      fs.writeFileSync(path.join(testDataDir, 'last.txt'), '2026-08-01T00:00:00.000Z', 'utf8');

      // rssHandler now takes its queue dependency directly - no need to monkey-patch a
      // shared singleton anymore, and testDataDir is removed whole in this file's afterEach,
      // so there's no real last.txt to save/restore around this test.
      const queued: QueueItems[] = [];
      const fakeQueue: QueueHandler = {
        writeQueue: async (item: QueueItems) => {
          queued.push(item);
          return queued;
        },
        start: async () => {},
        runQueue: async (): Promise<QueueItems[]> => queued,
        computeDelay: () => 0,
      };
      const testRssHandler = createRssHandler(fakeQueue, db, testLogger);

      try {
        const reader = await testRssHandler.init({
          fetch_interval: 60,
          fetch_url: new URL(`http://127.0.0.1:${port}/feed.xml`),
        });
        await testRssHandler.start();
        await new Promise(resolve => setTimeout(resolve, 300));
        reader.stop();
      } finally {
        server.close();
      }

      assert.strictEqual(queued.length, 1);
      assert.strictEqual(queued[0]?.content, 'buy now $author | Real Author');
    });
  });

  describe('User agent configuration', () => {
    it('should use custom user agent', () => {
      const config = {ogUserAgent: 'custom-bot/1.0'};

      assert.strictEqual(config.ogUserAgent, 'custom-bot/1.0');
    });

    it('should fallback to default user agent', () => {
      const config = {ogUserAgent: ''};
      const defaultUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

      const userAgent = config.ogUserAgent || defaultUserAgent;

      assert.strictEqual(userAgent, defaultUserAgent);
    });
  });
});
