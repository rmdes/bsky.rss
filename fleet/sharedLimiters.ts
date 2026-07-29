export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error(`ConcurrencyLimiter max must be >= 1, got ${max}`);
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
}
