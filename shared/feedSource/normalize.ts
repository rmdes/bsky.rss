import type {Rss} from 'feedsmith/types';
import type {DeepPartial} from 'feedsmith/types';
import type {FeedSourceConfig, NormalizedItem, ParsedFeedResult} from './types.ts';
import {FeedSourceError} from './types.ts';
import {resolveImageUrl} from './imageResolver.ts';

function normalizeRssItem(item: DeepPartial<Rss.Item<string>>): NormalizedItem {
  return {
    id: item.guid?.value || item.link || '',
    title: item.title,
    link: item.link,
    date: item.pubDate,
    description: item.description,
    content: item.content?.encoded,
    imageUrl: resolveImageUrl(item, undefined),
  };
}

export function normalizeFeed(
  parsed: ParsedFeedResult,
  config: FeedSourceConfig,
): NormalizedItem[] {
  if (parsed.format === 'rss') {
    return (parsed.feed.items ?? []).map(item => ({
      ...normalizeRssItem(item),
      imageUrl: resolveImageUrl(item, config.imageField),
    }));
  }
  throw new FeedSourceError(`Unsupported feed format: ${parsed.format}`);
}
