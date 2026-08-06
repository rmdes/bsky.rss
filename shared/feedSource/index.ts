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

export type {
  FeedSource,
  FeedSourceCallbacks,
  FeedSourceConfig,
  FeedSourceError,
  NormalizedItem,
} from './types.ts';
