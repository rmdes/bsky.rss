export type FeedState = 'starting' | 'ok' | 'failing';

export type FeedFailureCategory =
  | `http-${number}`
  | 'timeout'
  | 'dns'
  | 'tls'
  | 'connection'
  | 'parse'
  | 'other';

export interface BotCounters {
  feedPollSucceeded: number;
  feedPollFailed: number;
  openGraphAttempted: number;
  openGraphSucceeded: number;
  openGraphFallback: number;
  queued: number;
  policySkipped: number;
  postSucceeded: number;
  postUncertain: number;
  postDeferred: number;
  postException: number;
}

export interface BotOperationalSnapshot {
  botId: string;
  feedState: FeedState;
  lastFeedSuccessAt: string | null;
  lastFeedFailureAt: string | null;
  consecutiveFeedFailures: number;
  lastFeedFailureCategory: FeedFailureCategory | null;
  lastPostSuccessAt: string | null;
  counters: BotCounters;
}

export function emptyBotCounters(): BotCounters {
  return {
    feedPollSucceeded: 0,
    feedPollFailed: 0,
    openGraphAttempted: 0,
    openGraphSucceeded: 0,
    openGraphFallback: 0,
    queued: 0,
    policySkipped: 0,
    postSucceeded: 0,
    postUncertain: 0,
    postDeferred: 0,
    postException: 0,
  };
}

export const counterNames = Object.keys(emptyBotCounters()) as readonly (keyof BotCounters)[];

export class BotOperations {
  private feedState: FeedState = 'starting';
  private lastFeedSuccessAt: string | null = null;
  private lastFeedFailureAt: string | null = null;
  private consecutiveFeedFailures = 0;
  private lastFeedFailureCategory: FeedFailureCategory | null = null;
  private lastPostSuccessAt: string | null = null;
  private readonly counters = emptyBotCounters();

  constructor(
    private readonly botId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  recordFeedSuccess(): {recoveredFailures: number} {
    const recoveredFailures = this.consecutiveFeedFailures;
    this.counters.feedPollSucceeded++;
    this.feedState = 'ok';
    this.lastFeedSuccessAt = this.now().toISOString();
    this.consecutiveFeedFailures = 0;
    return {recoveredFailures};
  }

  recordFeedFailure(category: FeedFailureCategory): {
    becameFailing: boolean;
    consecutiveFailures: number;
  } {
    const becameFailing = this.feedState !== 'failing';
    this.counters.feedPollFailed++;
    this.feedState = 'failing';
    this.lastFeedFailureAt = this.now().toISOString();
    this.consecutiveFeedFailures++;
    this.lastFeedFailureCategory = category;
    return {becameFailing, consecutiveFailures: this.consecutiveFeedFailures};
  }

  recordOpenGraphSuccess(): void {
    this.counters.openGraphAttempted++;
    this.counters.openGraphSucceeded++;
  }

  recordOpenGraphFallback(): void {
    this.counters.openGraphAttempted++;
    this.counters.openGraphFallback++;
  }

  recordQueued(): void {
    this.counters.queued++;
  }

  recordPolicySkip(): void {
    this.counters.policySkipped++;
  }

  recordPostSuccess(): void {
    this.counters.postSucceeded++;
    this.lastPostSuccessAt = this.now().toISOString();
  }

  recordPostUncertain(): void {
    this.counters.postUncertain++;
  }

  recordPostDeferred(): void {
    this.counters.postDeferred++;
  }

  recordPostException(): void {
    this.counters.postException++;
  }

  snapshot(): BotOperationalSnapshot {
    return {
      botId: this.botId,
      feedState: this.feedState,
      lastFeedSuccessAt: this.lastFeedSuccessAt,
      lastFeedFailureAt: this.lastFeedFailureAt,
      consecutiveFeedFailures: this.consecutiveFeedFailures,
      lastFeedFailureCategory: this.lastFeedFailureCategory,
      lastPostSuccessAt: this.lastPostSuccessAt,
      counters: {...this.counters},
    };
  }
}

export function classifyFeedFailure(error: unknown): FeedFailureCategory {
  const status = numberProperty(error, 'status') ?? numberProperty(error, 'statusCode');
  if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) {
    return `http-${status}`;
  }

  const code = stringProperty(error, 'code').toUpperCase();
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return 'timeout';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns';
  if (code.startsWith('ERR_TLS') || code.includes('CERT')) return 'tls';
  if (['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'UND_ERR_SOCKET'].includes(code))
    return 'connection';

  const message = stringProperty(error, 'message').toLowerCase();
  if (/(timed? out|timeout)/.test(message)) return 'timeout';
  if (/(getaddrinfo|dns|name or service not known)/.test(message)) return 'dns';
  if (/(certificate|tls|ssl)/.test(message)) return 'tls';
  if (/(connection refused|socket hang up|connection reset|network unreachable)/.test(message))
    return 'connection';
  if (/(xml|parser|parse error|unexpected (close |end )?tag|mismatched tag)/.test(message))
    return 'parse';
  return 'other';
}

function property(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    return Reflect.get(error, key);
  } catch {
    return undefined;
  }
}

function numberProperty(error: unknown, key: string): number | undefined {
  const value = property(error, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringProperty(error: unknown, key: string): string {
  const value = property(error, key);
  return typeof value === 'string' ? value : '';
}
