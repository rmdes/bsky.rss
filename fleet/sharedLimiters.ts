import type {Logger} from '../shared/logging/logger.ts';

type LimiterEvent = 'waiting' | 'acquired' | 'released';

export interface LimiterDebugContext {
  logger: Logger;
  botId: string;
}

export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly maxQueueSize: number;

  constructor(
    private readonly max: number,
    maxQueueSize: number = 1000,
  ) {
    if (max < 1) throw new Error(`ConcurrencyLimiter max must be >= 1, got ${max}`);
    this.maxQueueSize = maxQueueSize;
  }

  async run<T>(fn: () => Promise<T>, observe?: (event: LimiterEvent) => void): Promise<T> {
    if (this.active >= this.max) this.notify(observe, 'waiting');
    await this.acquire();
    this.notify(observe, 'acquired');
    try {
      return await fn();
    } finally {
      this.release();
      this.notify(observe, 'released');
    }
  }

  private notify(observe: ((event: LimiterEvent) => void) | undefined, event: LimiterEvent): void {
    try {
      observe?.(event);
    } catch {
      // Diagnostics cannot change limiter acquisition or release behavior.
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }

    if (this.queue.length >= this.maxQueueSize) {
      throw new Error(`ConcurrencyLimiter queue full (${this.maxQueueSize})`);
    }

    return new Promise(resolve => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  /**
   * Get current queue depth for monitoring.
   */
  getQueueDepth(): number {
    return this.queue.length;
  }

  /**
   * Get current number of active operations.
   */
  getActive(): number {
    return this.active;
  }
}

export interface SharedLimitersConfig {
  maxConcurrentOpenGraphFetches: number;
  maxConcurrentImageJobs: number;
  maxImageDownloadBytes: number;
  httpTimeoutMs: number;
}

export class SharedLimiters {
  readonly httpTimeoutMs: number;
  readonly maxImageDownloadBytes: number;
  private readonly ogLimiter: ConcurrencyLimiter;
  private readonly imageLimiter: ConcurrencyLimiter;

  constructor(config: SharedLimitersConfig) {
    this.ogLimiter = new ConcurrencyLimiter(config.maxConcurrentOpenGraphFetches);
    this.imageLimiter = new ConcurrencyLimiter(config.maxConcurrentImageJobs);
    this.httpTimeoutMs = config.httpTimeoutMs;
    this.maxImageDownloadBytes = config.maxImageDownloadBytes;
  }

  withOgLimit<T>(fn: () => Promise<T>, debug?: LimiterDebugContext): Promise<T> {
    return this.ogLimiter.run(fn, limiterObserver('Open Graph', debug));
  }

  withImageLimit<T>(fn: () => Promise<T>, debug?: LimiterDebugContext): Promise<T> {
    return this.imageLimiter.run(fn, limiterObserver('Image', debug));
  }

  /**
   * Get queue depths for monitoring.
   */
  getQueueDepths(): {ogQueue: number; imageQueue: number} {
    return {
      ogQueue: this.ogLimiter.getQueueDepth(),
      imageQueue: this.imageLimiter.getQueueDepth(),
    };
  }
}

function limiterObserver(
  operation: string,
  debug: LimiterDebugContext | undefined,
): ((event: LimiterEvent) => void) | undefined {
  if (!debug) return undefined;
  return event => {
    const message =
      event === 'waiting'
        ? `${operation} waiting for shared limiter capacity`
        : `${operation} ${event} shared limiter`;
    debug.logger.debug('LIMITER', message, debug.botId);
  };
}
