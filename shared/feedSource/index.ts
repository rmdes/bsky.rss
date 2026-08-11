import {createPoller, type PollerOptions} from './poller.ts';
import type {FeedSource, FeedSourceConfig} from './types.ts';

export function createFeedSource(
  feedUrl: URL,
  intervalMinutes: number,
  config: FeedSourceConfig = {},
  options: PollerOptions = {},
): FeedSource {
  return createPoller(feedUrl, intervalMinutes, config, options);
}

// Re-export markdown link functions for convenience
export {extractMarkdownLinks, finalizeMarkdownLinks, buildFacets} from './markdownLinks.ts';

export type {
  FeedSource,
  FeedSourceCallbacks,
  FeedSourceConfig,
  FeedSourceError,
  NormalizedItem,
} from './types.ts';

// Re-export markdown types for convenience
export type {
  MarkdownFacet,
  ExtractedMarkdownLinks,
  MarkdownLinkResult,
} from './markdownLinks.ts';
