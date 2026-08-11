export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly maxQueueSize: number;

  constructor(private readonly max: number, maxQueueSize: number = 1000) {
    if (max < 1) throw new Error(`ConcurrencyLimiter max must be >= 1, got ${max}`);
    this.maxQueueSize = maxQueueSize;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
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

    return new Promise((resolve) => {
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

  withOgLimit<T>(fn: () => Promise<T>): Promise<T> {
    return this.ogLimiter.run(fn);
  }

  withImageLimit<T>(fn: () => Promise<T>): Promise<T> {
    return this.imageLimiter.run(fn);
  }

  /**
   * Get queue depths for monitoring.
   */
  getQueueDepths(): { ogQueue: number; imageQueue: number } {
    return {
      ogQueue: this.ogLimiter.getQueueDepth(),
      imageQueue: this.imageLimiter.getQueueDepth(),
    };
  }
}
