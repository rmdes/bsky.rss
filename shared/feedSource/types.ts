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
  ) {
    super(message);
    this.name = 'FeedSourceError';
  }
}

export interface FeedSourceCallbacks {
  /** Fired once per successful poll, with the full item batch (may be empty). */
  onItems: (items: NormalizedItem[]) => void;
  /** Fired once per item, in feed order. A rejection here is caught by the poller
   * and reported via onError - it does not stop the batch or crash the process. */
  onItem: (item: NormalizedItem) => Promise<void>;
  /** Fired on a fetch failure, a parse failure, or a single item's onItem rejecting. */
  onError: (error: FeedSourceError) => void;
}

export interface FeedSource {
  start(callbacks: FeedSourceCallbacks): void;
  stop(): void;
}

export type FetchFeedBody = (url: string, timeoutMs: number) => Promise<string>;
