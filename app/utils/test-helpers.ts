/**
 * Test helpers and mocks for app/ module testing
 */

import {readFileSync} from 'fs';
import {join} from 'path';

/**
 * Load test fixtures
 */
export function loadFixture(path: string): string {
  return readFileSync(
    join(__dirname, '../../test-fixtures', path),
    'utf-8'
  );
}

export function loadJSONFixture(path: string): any {
  return JSON.parse(loadFixture(path));
}

/**
 * Mock Bluesky API responses
 */
export const mockBskyResponses = {
  sessionCreate: {
    success: {
      accessJwt: 'mock-access-jwt-token',
      refreshJwt: 'mock-refresh-jwt-token',
      handle: 'test.bsky.social',
      did: 'did:plc:mocktestuser123',
      email: 'test@example.com',
      emailConfirmed: true,
    },
    rateLimited: {
      error: 'RateLimitExceeded',
      message: 'Rate limit exceeded',
    },
    invalidCredentials: {
      error: 'AuthenticationRequired',
      message: 'Invalid identifier or password',
    },
  },

  createRecord: {
    success: {
      uri: 'at://did:plc:mocktestuser123/app.bsky.feed.post/abc123xyz',
      cid: 'bafytest123456',
    },
    rateLimited: {
      error: 'RateLimitExceeded',
      message: 'Rate limit exceeded',
    },
  },

  uploadBlob: {
    success: {
      blob: {
        $type: 'blob',
        ref: {$link: 'bafyimagetest123'},
        mimeType: 'image/jpeg',
        size: 12345,
      },
    },
  },
};

/**
 * Mock RSS feed items
 */
export const mockRSSItems = {
  standard: {
    title: 'Test Article Title',
    link: 'https://example.com/article-1',
    description: 'This is a test article description',
    pubDate: new Date('2026-08-05T10:00:00Z'),
    guid: 'https://example.com/article-1',
  },

  withHTML: {
    title: 'Article with &lt;HTML&gt; entities',
    link: 'https://example.com/article-2',
    description: 'Description with &lt;strong&gt;HTML&lt;/strong&gt; tags',
    pubDate: new Date('2026-08-05T09:00:00Z'),
  },

  withImage: {
    title: 'Article with Image',
    link: 'https://example.com/article-3',
    description: 'Has an image',
    pubDate: new Date('2026-08-05T08:00:00Z'),
    enclosures: [
      {
        url: 'https://example.com/image.jpg',
        type: 'image/jpeg',
        length: 54321,
      },
    ],
  },

  minimal: {
    title: 'Minimal Article',
    link: 'https://example.com/article-4',
  },
};

/**
 * Mock Open Graph data
 */
export const mockOpenGraphData = {
  success: {
    result: {
      ogTitle: 'Open Graph Title',
      ogDescription: 'Open Graph Description',
      ogUrl: 'https://example.com/og-article',
      ogImage: [
        {
          url: 'https://example.com/og-image.jpg',
          width: 1200,
          height: 630,
          type: 'image/jpeg',
        },
      ],
    },
    error: false,
  },

  error: {
    error: true,
    errorMessage: 'Failed to fetch Open Graph data',
  },

  malformedUrl: {
    result: {
      ogTitle: 'Article',
      ogUrl: 'https//example.com/malformed', // Missing colon
    },
    error: false,
  },
};

/**
 * Mock filesystem operations
 */
export class MockFileSystem {
  private files: Map<string, string> = new Map();

  writeFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  readFile(path: string): string {
    const content = this.files.get(path);
    if (!content) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    return content;
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  reset(): void {
    this.files.clear();
  }

  getFiles(): Map<string, string> {
    return new Map(this.files);
  }
}

/**
 * Sleep utility for tests
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a mock config
 */
export function createMockConfig(overrides?: Partial<Config>): Config {
  return {
    string: '$title - $link',
    publishEmbed: true,
    embedType: 'card',
    languages: ['en'],
    ogUserAgent: 'bsky.rss/test',
    truncate: true,
    runInterval: 60,
    dateField: '',
    publishDate: false,
    imageField: '',
    imageAlt: '$title',
    forceDescriptionEmbed: false,
    removeDuplicate: false,
    descriptionClearHTML: true,
    titleClearHTML: false,
    adaptiveSpacing: false,
    spacingWindow: 600,
    minSpacing: 1,
    maxSpacing: 60,
    ...overrides,
  };
}

/**
 * Assert helpers
 */
export function assertDateRecent(date: Date, withinMs: number = 5000): void {
  const now = Date.now();
  const timestamp = date.getTime();
  const diff = Math.abs(now - timestamp);

  if (diff > withinMs) {
    throw new Error(
      `Date ${date.toISOString()} is not recent (diff: ${diff}ms > ${withinMs}ms)`
    );
  }
}

export function assertMatchesPattern(
  value: string,
  pattern: RegExp,
  message?: string
): void {
  if (!pattern.test(value)) {
    throw new Error(
      message ||
        `Value "${value}" does not match pattern ${pattern.toString()}`
    );
  }
}
