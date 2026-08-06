import {parseFeed} from 'feedsmith';
import {FeedSourceError, type ParsedFeedResult} from './types.ts';

export function parseRawFeed(rawBody: string): ParsedFeedResult {
  try {
    return parseFeed(rawBody);
  } catch (error) {
    throw new FeedSourceError('Unable to parse feed content', error);
  }
}
