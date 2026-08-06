import type {parseFeed} from 'feedsmith';

export type ParsedFeedResult = ReturnType<typeof parseFeed>;

export interface NormalizedItem {
  id: string;
  title: string | undefined;
  link: string | undefined;
  date: string | undefined;
  description: string | undefined;
  content: string | undefined;
  imageUrl: string | undefined;
}

export interface FeedSourceConfig {
  imageField?: string;
}

export class FeedSourceError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    // 'poll' (default): the whole poll failed (fetch or parse) - callers should treat
    // this as feed-health-affecting. 'item': one item's onItem handler rejected while
    // the rest of the batch kept processing - not a feed outage, must not affect feed
    // health state (matches the pre-migration feedsub-based behavior, where an 'error'
    // event and a per-item handler rejection were always distinguishable).
    public readonly scope: 'poll' | 'item' = 'poll',
  ) {
    super(message);
    this.name = 'FeedSourceError';
  }
}

export interface FeedSourceCallbacks {
  /** Fired once per successful poll, after every item in the batch has finished
   * going through onItem (success or per-item failure) - not when the batch is
   * fetched. Carries the full batch (may be empty). */
  onItems: (items: NormalizedItem[]) => void;
  /** Fired once per item, in feed order. A rejection here is caught by the poller
   * and reported via onError - it does not stop the batch or crash the process. */
  onItem: (item: NormalizedItem) => Promise<void>;
  /** Fired on a fetch failure, a parse failure, or a single item's onItem rejecting -
   * check error.scope ('poll' vs 'item') to tell these apart. */
  onError: (error: FeedSourceError) => void;
}

export interface FeedSource {
  start(callbacks: FeedSourceCallbacks): void;
  stop(): void;
}

export type FetchFeedBody = (url: string, timeoutMs: number) => Promise<string>;
