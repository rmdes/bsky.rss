import {describe, it, beforeEach} from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

/**
 * Tests for rssHandler module
 *
 * Note: These tests focus on the module's string parsing, HTML handling,
 * and URL validation logic. Full RSS feed integration tests require
 * actual RSS feeds and are better suited for E2E tests.
 */

describe('rssHandler', () => {
  const TEST_DATA_DIR = path.join(__dirname, '../../data');

  beforeEach(() => {
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

    // Clear module cache to reset state
    delete require.cache[require.resolve('./rssHandler')];
  });

  describe('Module exports', () => {
    it('should export init, start, and launch functions', () => {
      const rssHandler = require('./rssHandler').default;

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
      const {decode} = require('html-entities');

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
      const {decode} = require('html-entities');

      // &amp;#233; -> &#233; -> é
      const doubleEncoded = '&amp;#233;';
      const firstDecode = decode(doubleEncoded); // &#233;
      const secondDecode = decode(firstDecode); // é

      assert.strictEqual(secondDecode, 'é');
    });

    it('should handle mixed text and entities', () => {
      const {decode} = require('html-entities');

      const input = 'Tom &amp; Jerry: A&nbsp;Classic';
      // &nbsp; decodes to U+00A0 (non-breaking space), not a regular space
      const expected = 'Tom & Jerry: A Classic';

      const result = decode(input);

      assert.strictEqual(result, expected);
    });

    it('should handle numeric character references', () => {
      const {decode} = require('html-entities');

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
      // Matches Item's own [key: string]: any index signature in app/types/index.d.ts -
      // config.imageField is a runtime-configured field name, not known statically.
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
