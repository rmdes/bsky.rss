import axios from 'axios';
import {parseRawFeed} from './parse.ts';
import {normalizeFeed} from './normalize.ts';
import {FeedSourceError} from './types.ts';
import type {
  FeedSource,
  FeedSourceCallbacks,
  FeedSourceConfig,
  FetchFeedBody,
  NormalizedItem,
} from './types.ts';

// Generous for a feed body (the largest real feeds here are a few MB) while keeping a
// malicious or misbehaving URL from streaming unbounded data into memory, matching the
// cap the image-download path already has.
const MAX_FEED_BODY_BYTES = 20_000_000;

const defaultFetch: FetchFeedBody = async (url, timeoutMs) => {
  const response = await axios.get<string>(url, {
    responseType: 'text',
    timeout: timeoutMs,
    maxContentLength: MAX_FEED_BODY_BYTES,
    maxBodyLength: MAX_FEED_BODY_BYTES,
  });
  return response.data;
};

export interface PollerOptions {
  fetchTimeoutMs?: number;
  fetchBody?: FetchFeedBody;
}

export function createPoller(
  feedUrl: URL,
  intervalMinutes: number,
  config: FeedSourceConfig,
  options: PollerOptions = {},
): FeedSource {
  const fetchBody = options.fetchBody ?? defaultFetch;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 10_000;
  let timer: NodeJS.Timeout | null = null;
  let callbacks: FeedSourceCallbacks | null = null;
  let polling = false;

  async function pollOnce(): Promise<void> {
    if (!callbacks) return;
    // A poll's per-item work (Open Graph fetch + image download, per item) can easily
    // outlast intervalMinutes on a large batch. Without this, setInterval starts a
    // second overlapping pass over the same items while the first is still running.
    if (polling) return;
    polling = true;
    const cb = callbacks;
    try {
      let items: NormalizedItem[];
      try {
        const body = await fetchBody(String(feedUrl), fetchTimeoutMs);
        items = normalizeFeed(parseRawFeed(body), config);
      } catch (error) {
        cb.onError(
          error instanceof FeedSourceError
            ? error
            : new FeedSourceError('Feed fetch failed', error),
        );
        return;
      }
      for (const item of items) {
        try {
          await cb.onItem(item);
        } catch (error) {
          cb.onError(new FeedSourceError('Item handling failed', error, 'item'));
        }
      }
      cb.onItems(items);
    } finally {
      polling = false;
    }
  }

  return {
    start(cb: FeedSourceCallbacks): void {
      callbacks = cb;
      void pollOnce();
      timer = setInterval(() => void pollOnce(), intervalMinutes * 60_000);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      callbacks = null;
    },
  };
}
