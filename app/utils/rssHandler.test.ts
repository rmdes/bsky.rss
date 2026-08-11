import {describe, it, test, beforeEach} from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import {createServer} from 'node:http';
import {decode} from 'html-entities';
import queueHandler from './queueHandler.ts';

/**
 * Tests for rssHandler module
 *
 * Note: These tests focus on the module's string parsing, HTML handling,
 * and URL validation logic. Full RSS feed integration tests require
 * actual RSS feeds and are better suited for E2E tests.
 */

describe('rssHandler', () => {
  const TEST_DATA_DIR = path.join(import.meta.dirname, '../../data');
  let rssHandler: typeof import('./rssHandler.ts').default;

  beforeEach(async () => {
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

    if (!fs.existsSync(TEST_DATA_DIR)) {
      fs.mkdirSync(TEST_DATA_DIR, {recursive: true});
    }

    fs.writeFileSync(path.join(TEST_DATA_DIR, 'config.json'), JSON.stringify(testConfig), 'utf8');

    rssHandler = (await import(`./rssHandler.ts?t=${crypto.randomUUID()}`)).default;
  });

  describe('Module exports', () => {
    it('should export init, start, and launch functions', () => {
      assert(typeof rssHandler.init === 'function');
      assert(typeof rssHandler.start === 'function');
      assert(typeof rssHandler.launch === 'function');
    });
  });

  describe('String template parsing', () => {
    it('should replace $title placeholder', () => {
      const mockItem = {
        title: 'Test Article Title',
        link: 'https://example.com/article',
        description: 'Test description',
      };

      const template = '$title';
      const expected = 'Test Article Title';

      // Test the logic
      const result = template.replace('$title', mockItem.title);
      assert.strictEqual(result, expected);
    });

    it('should replace $link placeholder', () => {
      const mockItem = {
        title: 'Test Article',
        link: 'https://example.com/article',
        description: 'Test description',
      };

      const template = 'Read more: $link';
      const expected = 'Read more: https://example.com/article';

      const result = template.replace('$link', mockItem.link);
      assert.strictEqual(result, expected);
    });

    it('should use link directly as a plain string (NormalizedItem.link is never an object)', () => {
      // feedsub's Item.link could be a plain string or {href: string}, requiring a
      // typeof check to unwrap it. NormalizedItem.link (shared/feedSource) is always
      // string | undefined, so rssHandler.ts no longer has an object-link branch.
      const mockItem = {
        title: 'Test Article',
        link: 'https://example.com/article',
        description: 'Test description',
      };

      const template = '$link';
      const result = template.replace('$link', mockItem.link);

      assert.strictEqual(result, 'https://example.com/article');
    });

    it('should replace $description placeholder', () => {
      const mockItem = {
        title: 'Test Article',
        link: 'https://example.com/article',
        description: 'This is a test description',
      };

      const template = '$title - $description';
      let result = template.replace('$title', mockItem.title);
      result = result.replace('$description', mockItem.description);

      assert.strictEqual(result, 'Test Article - This is a test description');
    });

    it('should handle multiple placeholders', () => {
      const mockItem = {
        title: 'My Article',
        link: 'https://blog.com/post',
        description: 'Article about testing',
      };

      const template = '$title - $link - $description';
      const result = template
        .replace('$title', mockItem.title)
        .replace('$link', mockItem.link)
        .replace('$description', mockItem.description);

      assert.strictEqual(result, 'My Article - https://blog.com/post - Article about testing');
    });

    it('should truncate long strings to 300 characters', () => {
      const longText =
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident.';

      assert(longText.length > 300);

      // Truncation logic: slice to 277 + "..."
      const truncated = longText.slice(0, 277) + '...';

      assert.strictEqual(truncated.length, 280);
      assert(truncated.endsWith('...'));
    });

    it('should not truncate strings under 300 characters', () => {
      const shortText = 'This is a short string';

      assert(shortText.length <= 300);

      // No truncation needed
      const result = shortText;

      assert.strictEqual(result, shortText);
      assert(!result.endsWith('...'));
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
    it('should remove simple HTML tags', () => {
      const htmlString = '<p>Hello world</p>';
      const expected = 'Hello world';

      const result = htmlString.replace(/<\/?[^>]+(>|$)/g, ' ').trim();

      assert.strictEqual(result, expected);
    });

    it('should remove multiple HTML tags', () => {
      const htmlString = '<div><p>Paragraph</p><span>Span text</span></div>';
      const expected = 'Paragraph Span text';

      const result = htmlString
        .replace(/<\/?[^>]+(>|$)/g, ' ')
        .trim()
        .replace(/  +/g, ' ');

      assert.strictEqual(result, expected);
    });

    it('should replace &nbsp; with space', () => {
      const htmlString = 'Hello&nbsp;world';
      const expected = 'Hello world';

      const result = htmlString.replaceAll('&nbsp;', ' ');

      assert.strictEqual(result, expected);
    });

    it('should handle strong/em tags', () => {
      const htmlString = 'This is <strong>bold</strong> and <em>italic</em> text';
      const expected = 'This is bold and italic text';

      const result = htmlString
        .replace(/<\/?[^>]+(>|$)/g, ' ')
        .trim()
        .replace(/  +/g, ' ');

      assert.strictEqual(result, expected);
    });

    it('should handle nested tags', () => {
      const htmlString = '<div><p>Outer <span>inner</span> text</p></div>';
      const expected = 'Outer inner text';

      const result = htmlString
        .replace(/<\/?[^>]+(>|$)/g, ' ')
        .trim()
        .replace(/  +/g, ' ');

      assert.strictEqual(result, expected);
    });

    it('should handle self-closing tags', () => {
      const htmlString = 'Line one<br/>Line two<hr/>Line three';
      const expected = 'Line one Line two Line three';

      const result = htmlString
        .replace(/<\/?[^>]+(>|$)/g, ' ')
        .trim()
        .replace(/  +/g, ' ');

      assert.strictEqual(result, expected);
    });

    it('should collapse multiple spaces', () => {
      const htmlString = '<p>Text   with    multiple     spaces</p>';
      const expected = 'Text with multiple spaces';

      const result = htmlString
        .replace(/<\/?[^>]+(>|$)/g, ' ')
        .trim()
        .replace(/  +/g, ' ');

      assert.strictEqual(result, expected);
    });
  });

  describe('HTML entity decoding', () => {
    it('should handle encoded HTML entities', () => {
      // html-entities library tests
      const testCases = [
        {input: '&lt;', expected: '<'},
        {input: '&gt;', expected: '>'},
        {input: '&amp;', expected: '&'},
        {input: '&quot;', expected: '"'},
        {input: '&#233;', expected: 'é'},
        {input: '&#8217;', expected: '’'}, // Right single quote
      ];

      testCases.forEach(tc => {
        const result = decode(tc.input);
        assert.strictEqual(result, tc.expected, `Failed for ${tc.input}`);
      });
    });

    it('should handle double-encoded entities', () => {
      // &amp;#233; -> &#233; -> é
      const doubleEncoded = '&amp;#233;';
      const firstDecode = decode(doubleEncoded); // &#233;
      const secondDecode = decode(firstDecode); // é

      assert.strictEqual(secondDecode, 'é');
    });

    it('should handle mixed text and entities', () => {
      const input = 'Tom &amp; Jerry: A&nbsp;Classic';
      // &nbsp; decodes to U+00A0 (non-breaking space), not a regular space
      const expected = 'Tom & Jerry: A Classic';

      const result = decode(input);

      assert.strictEqual(result, expected);
    });

    it('should handle numeric character references', () => {
      const input = '&#8220;Hello&#8221;'; // Smart quotes (char codes 8220 and 8221)
      const result = decode(input);

      // Should decode and contain Hello
      assert(result.includes('Hello'));
      // Result should not be the same as input (it was decoded)
      assert.notStrictEqual(result, input);
      // Should be longer than just "Hello" (has quotes)
      assert(result.length > 'Hello'.length);
    });
  });

  describe('URL validation and fixing', () => {
    it('should fix malformed https URL', () => {
      const malformed = 'https//example.com/path';
      const expected = 'https://example.com/path';

      const result = malformed.replace(/^https\/\//i, 'https://');

      assert.strictEqual(result, expected);
    });

    it('should fix malformed http URL', () => {
      const malformed = 'http//example.com/path';
      const expected = 'http://example.com/path';

      const result = malformed.replace(/^http\/\//i, 'http://');

      assert.strictEqual(result, expected);
    });

    it('should not modify well-formed URLs', () => {
      const wellFormed = 'https://example.com/path';

      const result = wellFormed.replace(/^https\/\//i, 'https://').replace(/^http\/\//i, 'http://');

      assert.strictEqual(result, wellFormed);
    });

    it('should validate URLs with regex', () => {
      const urlRegex = new RegExp(
        '^(h|H)(t|T)(t|T)(p|P)(s|S)?:\\/\\/[-a-zA-Z0-9@:%._\\+~#=]{1,256}\\.[a-zA-Z0-9()]{1,6}\\b([-a-zA-Z0-9()@:%_\\+.~#?&//=]*)',
      );

      const validUrls = [
        'https://example.com',
        'http://example.com/path',
        'https://sub.example.com',
        'https://example.com/path?query=value',
        'https://example.com:8080/path',
      ];

      const invalidUrls = [
        'not-a-url',
        'https//example.com', // Missing colon
        'htp://example.com', // Typo in protocol
      ];

      validUrls.forEach(url => {
        assert(urlRegex.test(url), `${url} should be valid`);
      });

      invalidUrls.forEach(url => {
        assert(!urlRegex.test(url), `${url} should be invalid`);
      });
    });

    it('should handle case-insensitive protocol fixing', () => {
      const testCases = [
        {input: 'HTTPS//example.com', expected: 'https://example.com'},
        {input: 'HttPs//example.com', expected: 'https://example.com'},
        {input: 'HTTP//example.com', expected: 'http://example.com'},
      ];

      testCases.forEach(tc => {
        const result = tc.input.replace(/^https\/\//i, 'https://').replace(/^http\/\//i, 'http://');
        assert.strictEqual(result, tc.expected);
      });
    });
  });

  describe('Configuration handling', () => {
    it('should use titleClearHTML config for title processing', () => {
      const config = {titleClearHTML: true};
      const title = '<strong>Bold Title</strong>';

      if (config.titleClearHTML) {
        const cleaned = title.replace(/<\/?[^>]+(>|$)/g, ' ').trim();
        assert.strictEqual(cleaned, 'Bold Title');
      }
    });

    it('should use descriptionClearHTML config for description', () => {
      const config = {descriptionClearHTML: true};
      const description = '<p>Description with <em>tags</em></p>';

      if (config.descriptionClearHTML) {
        const cleaned = description
          .replace(/<\/?[^>]+(>|$)/g, ' ')
          .trim()
          .replace(/  +/g, ' ');
        assert.strictEqual(cleaned, 'Description with tags');
      }
    });

    it('should handle imageAlt template string', () => {
      const config = {imageAlt: '$title'};
      const item = {title: 'Test Image'};

      const imageAlt = config.imageAlt.replace('$title', item.title);

      assert.strictEqual(imageAlt, 'Test Image');
    });

    it('should respect publishEmbed config', () => {
      const config1 = {publishEmbed: true};
      const config2 = {publishEmbed: false};

      assert.strictEqual(config1.publishEmbed, true);
      assert.strictEqual(config2.publishEmbed, false);
    });

    it('should support different embed types', () => {
      const validEmbedTypes = ['card', 'image'];

      validEmbedTypes.forEach(type => {
        const config = {embedType: type};
        assert(validEmbedTypes.includes(config.embedType));
      });
    });

    it('should handle date field configuration', () => {
      const item = {
        pubdate: '2026-08-05T10:00:00Z',
        published: '2026-08-05T09:00:00Z',
        customDate: '2026-08-05T08:00:00Z',
      };

      const config1 = {dateField: ''};
      const config2 = {dateField: 'customDate'};
      const fallback = item.pubdate ? item.pubdate : item.published;

      // Without custom dateField, fall back to pubdate or published
      const date1 = config1.dateField ? item[config1.dateField as keyof typeof item] : fallback;

      // With custom dateField, use that field
      const date2 = config2.dateField ? item[config2.dateField as keyof typeof item] : fallback;

      assert.strictEqual(date1, '2026-08-05T10:00:00Z');
      assert.strictEqual(date2, '2026-08-05T08:00:00Z');
    });

    it('should handle imageField configuration', () => {
      // config.imageField is a runtime-configured field name, not known statically,
      // hence the index signature on the local shape here.
      const item: {enclosure: {url: string; type: string}; [key: string]: unknown} = {
        enclosure: {
          url: 'https://example.com/image.jpg',
          type: 'image/jpeg',
        },
      };

      const config = {imageField: 'enclosure'};

      if (config.imageField && Object.keys(item).includes(config.imageField)) {
        const imageData = item[config.imageField] as {url: string; type: string};
        if (imageData && Object.keys(imageData).includes('url')) {
          assert.strictEqual(imageData.url, 'https://example.com/image.jpg');
        }
      }
    });

    it('should validate image type in imageField', () => {
      const item1 = {
        enclosure: {
          url: 'https://example.com/image.jpg',
          type: 'image/jpeg',
        },
      };

      const item2 = {
        enclosure: {
          url: 'https://example.com/audio.mp3',
          type: 'audio/mpeg',
        },
      };

      // Should accept image types
      assert(item1.enclosure.type.startsWith('image'));

      // Should reject non-image types
      assert(!item2.enclosure.type.startsWith('image'));
    });
  });

  describe('Embed construction', () => {
    it('should build card embed with all fields', () => {
      const embed = {
        type: 'card',
        uri: 'https://example.com/article',
        title: 'Article Title',
        description: 'Article description',
        image: Buffer.from('fake-image'),
        imageAlt: 'Image alt text',
      };

      assert.strictEqual(embed.type, 'card');
      assert.strictEqual(embed.uri, 'https://example.com/article');
      assert(embed.title);
      assert(embed.description);
      assert(Buffer.isBuffer(embed.image));
    });

    it('should build image embed', () => {
      const embed = {
        type: 'image',
        uri: 'https://example.com',
        title: 'Title',
        image: Buffer.from('fake-image'),
        imageAlt: 'Image description',
      };

      assert.strictEqual(embed.type, 'image');
      assert(Buffer.isBuffer(embed.image));
      assert(embed.imageAlt);
    });

    it('should handle embed without description', () => {
      const embed = {
        type: 'card',
        uri: 'https://example.com',
        title: 'Title',
        description: undefined,
        image: undefined,
        imageAlt: undefined,
      };

      assert.strictEqual(embed.description, undefined);
    });

    it('should handle embed without image', () => {
      const embed = {
        type: 'card',
        uri: 'https://example.com',
        title: 'Title',
        description: 'Description',
        image: undefined,
      };

      assert.strictEqual(embed.image, undefined);
    });

    it('should fallback to item title if no OG title', () => {
      const openGraphData: {error: boolean; ogTitle?: string} = {error: false};
      const item = {title: 'RSS Item Title'};

      const title = openGraphData.ogTitle ? openGraphData.ogTitle : item.title;

      assert.strictEqual(title, 'RSS Item Title');
    });

    it('should use OG title when available', () => {
      const openGraphData = {
        error: false,
        ogTitle: 'Open Graph Title',
      };
      const item = {title: 'RSS Item Title'};

      const title = openGraphData.ogTitle ? openGraphData.ogTitle : item.title;

      assert.strictEqual(title, 'Open Graph Title');
    });

    it('should fallback to item description', () => {
      const item = {
        description: 'Item description',
        content: 'Item content',
      };

      const description = item.description ? item.description : item.content;

      assert.strictEqual(description, 'Item description');
    });

    it('should use content if no description', () => {
      const item: {content: string; description?: string} = {
        content: 'Item content',
      };

      const description = item.description ? item.description : item.content;

      assert.strictEqual(description, 'Item content');
    });
  });

  describe('Date handling', () => {
    it('should compare dates correctly', () => {
      const date1 = new Date('2026-08-05T10:00:00Z');
      const date2 = new Date('2026-08-05T09:00:00Z');

      assert(date1 > date2);
      assert(date2 <= date1);
    });

    it('should handle date strings', () => {
      const dateString = '2026-08-05T10:00:00Z';
      const date = new Date(dateString);

      assert(date instanceof Date);
      assert.strictEqual(date.toISOString(), '2026-08-05T10:00:00.000Z');
    });

    it('should skip items older than lastDate', () => {
      const lastDate = '2026-08-05T10:00:00Z';
      const oldItem = {date: '2026-08-05T09:00:00Z'};
      const newItem = {date: '2026-08-05T11:00:00Z'};

      const shouldSkipOld = new Date(oldItem.date) <= new Date(lastDate);
      const shouldSkipNew = new Date(newItem.date) <= new Date(lastDate);

      assert.strictEqual(shouldSkipOld, true);
      assert.strictEqual(shouldSkipNew, false);
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
        path.join(TEST_DATA_DIR, 'config.json'),
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

      const lastPath = path.join(TEST_DATA_DIR, 'last.txt');
      const savedLast = fs.existsSync(lastPath) ? fs.readFileSync(lastPath, 'utf8') : null;
      fs.writeFileSync(lastPath, '2026-08-01T00:00:00.000Z', 'utf8');

      // Patch the shared queueHandler singleton before loading a fresh rssHandler, so
      // rssHandler's own `import queue from './queueHandler.ts'` (no cache-busting query
      // string, unlike the freshly-imported rssHandler below) resolves to this same,
      // already-patched instance.
      const realWriteQueue = queueHandler.writeQueue;
      const queued: QueueItems[] = [];
      queueHandler.writeQueue = async (item: QueueItems) => {
        queued.push(item);
        return queued;
      };

      const rssHandler = (await import(`./rssHandler.ts?t=${crypto.randomUUID()}`)).default;

      try {
        // 0.002 minutes = 120ms, so several polls fire inside the wait below.
        const reader = await rssHandler.init({
          fetch_interval: 0.002,
          fetch_url: new URL(`http://127.0.0.1:${port}/feed.xml`),
        });
        await rssHandler.start();
        await new Promise(resolve => setTimeout(resolve, 500));
        reader.stop();
      } finally {
        queueHandler.writeQueue = realWriteQueue;
        if (savedLast === null) fs.rmSync(lastPath, {force: true});
        else fs.writeFileSync(lastPath, savedLast, 'utf8');
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
        path.join(TEST_DATA_DIR, 'config.json'),
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

      const lastPath = path.join(TEST_DATA_DIR, 'last.txt');
      const savedLast = fs.existsSync(lastPath) ? fs.readFileSync(lastPath, 'utf8') : null;
      fs.writeFileSync(lastPath, '2026-08-01T00:00:00.000Z', 'utf8');

      const realWriteQueue = queueHandler.writeQueue;
      const queued: QueueItems[] = [];
      queueHandler.writeQueue = async (item: QueueItems) => {
        queued.push(item);
        return queued;
      };

      const rssHandler = (await import(`./rssHandler.ts?t=${crypto.randomUUID()}`)).default;

      try {
        // 0.002 minutes = 120ms, so several polls fire inside the wait below - proving
        // both "no item lost within one batch" and "no item re-queued across polls".
        const reader = await rssHandler.init({
          fetch_interval: 0.002,
          fetch_url: new URL(`http://127.0.0.1:${port}/feed.xml`),
        });
        await rssHandler.start();
        await new Promise(resolve => setTimeout(resolve, 500));
        reader.stop();
      } finally {
        queueHandler.writeQueue = realWriteQueue;
        if (savedLast === null) fs.rmSync(lastPath, {force: true});
        else fs.writeFileSync(lastPath, savedLast, 'utf8');
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
        path.join(TEST_DATA_DIR, 'config.json'),
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

      const lastPath = path.join(TEST_DATA_DIR, 'last.txt');
      const savedLast = fs.existsSync(lastPath) ? fs.readFileSync(lastPath, 'utf8') : null;
      fs.writeFileSync(lastPath, '2026-08-01T00:00:00.000Z', 'utf8');

      const realWriteQueue = queueHandler.writeQueue;
      const queued: QueueItems[] = [];
      queueHandler.writeQueue = async (item: QueueItems) => {
        queued.push(item);
        return queued;
      };

      const rssHandler = (await import(`./rssHandler.ts?t=${crypto.randomUUID()}`)).default;

      try {
        const reader = await rssHandler.init({
          fetch_interval: 60,
          fetch_url: new URL(`http://127.0.0.1:${port}/feed.xml`),
        });
        await rssHandler.start();
        await new Promise(resolve => setTimeout(resolve, 300));
        reader.stop();
      } finally {
        queueHandler.writeQueue = realWriteQueue;
        if (savedLast === null) fs.rmSync(lastPath, {force: true});
        else fs.writeFileSync(lastPath, savedLast, 'utf8');
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
        path.join(TEST_DATA_DIR, 'config.json'),
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

      const lastPath = path.join(TEST_DATA_DIR, 'last.txt');
      const savedLast = fs.existsSync(lastPath) ? fs.readFileSync(lastPath, 'utf8') : null;
      fs.writeFileSync(lastPath, '2026-08-01T00:00:00.000Z', 'utf8');

      const realWriteQueue = queueHandler.writeQueue;
      const queued: QueueItems[] = [];
      queueHandler.writeQueue = async (item: QueueItems) => {
        queued.push(item);
        return queued;
      };

      const rssHandler = (await import(`./rssHandler.ts?t=${crypto.randomUUID()}`)).default;

      try {
        const reader = await rssHandler.init({
          fetch_interval: 60,
          fetch_url: new URL(`http://127.0.0.1:${port}/feed.xml`),
        });
        await rssHandler.start();
        await new Promise(resolve => setTimeout(resolve, 300));
        reader.stop();
      } finally {
        queueHandler.writeQueue = realWriteQueue;
        if (savedLast === null) fs.rmSync(lastPath, {force: true});
        else fs.writeFileSync(lastPath, savedLast, 'utf8');
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
        path.join(TEST_DATA_DIR, 'config.json'),
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

      const lastPath = path.join(TEST_DATA_DIR, 'last.txt');
      const savedLast = fs.existsSync(lastPath) ? fs.readFileSync(lastPath, 'utf8') : null;
      fs.writeFileSync(lastPath, '2026-08-01T00:00:00.000Z', 'utf8');

      const realWriteQueue = queueHandler.writeQueue;
      const queued: QueueItems[] = [];
      queueHandler.writeQueue = async (item: QueueItems) => {
        queued.push(item);
        return queued;
      };

      const rssHandler = (await import(`./rssHandler.ts?t=${crypto.randomUUID()}`)).default;

      try {
        const reader = await rssHandler.init({
          fetch_interval: 60,
          fetch_url: new URL(`http://127.0.0.1:${port}/feed.xml`),
        });
        await rssHandler.start();
        await new Promise(resolve => setTimeout(resolve, 300));
        reader.stop();
      } finally {
        queueHandler.writeQueue = realWriteQueue;
        if (savedLast === null) fs.rmSync(lastPath, {force: true});
        else fs.writeFileSync(lastPath, savedLast, 'utf8');
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
        path.join(TEST_DATA_DIR, 'config.json'),
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

      const lastPath = path.join(TEST_DATA_DIR, 'last.txt');
      const savedLast = fs.existsSync(lastPath) ? fs.readFileSync(lastPath, 'utf8') : null;
      fs.writeFileSync(lastPath, '2026-08-01T00:00:00.000Z', 'utf8');

      const realWriteQueue = queueHandler.writeQueue;
      const queued: QueueItems[] = [];
      queueHandler.writeQueue = async (item: QueueItems) => {
        queued.push(item);
        return queued;
      };

      const rssHandler = (await import(`./rssHandler.ts?t=${crypto.randomUUID()}`)).default;

      try {
        const reader = await rssHandler.init({
          fetch_interval: 60,
          fetch_url: new URL(`http://127.0.0.1:${port}/feed.xml`),
        });
        await rssHandler.start();
        await new Promise(resolve => setTimeout(resolve, 300));
        reader.stop();
      } finally {
        queueHandler.writeQueue = realWriteQueue;
        if (savedLast === null) fs.rmSync(lastPath, {force: true});
        else fs.writeFileSync(lastPath, savedLast, 'utf8');
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
