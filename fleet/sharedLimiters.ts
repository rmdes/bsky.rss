import type { FleetLogger } from "./logging.ts";

type LimiterEvent = "waiting" | "acquired" | "released";

export interface LimiterDebugContext {
  logger: FleetLogger;
  botId: string;
}

export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error(`ConcurrencyLimiter max must be >= 1, got ${max}`);
  }

  async run<T>(
    fn: () => Promise<T>,
    observe?: (event: LimiterEvent) => void
  ): Promise<T> {
    if (this.active >= this.max) this.notify(observe, "waiting");
    await this.acquire();
    this.notify(observe, "acquired");
    try {
      return await fn();
    } finally {
      this.release();
      this.notify(observe, "released");
    }
  }

  private notify(
    observe: ((event: LimiterEvent) => void) | undefined,
    event: LimiterEvent
  ): void {
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

  withOgLimit<T>(fn: () => Promise<T>, debug?: LimiterDebugContext): Promise<T> {
    return this.ogLimiter.run(fn, limiterObserver("Open Graph", debug));
  }

  withImageLimit<T>(fn: () => Promise<T>, debug?: LimiterDebugContext): Promise<T> {
    return this.imageLimiter.run(fn, limiterObserver("Image", debug));
  }
}

function limiterObserver(
  operation: string,
  debug: LimiterDebugContext | undefined
): ((event: LimiterEvent) => void) | undefined {
  if (!debug) return undefined;
  return (event) => {
    const message = event === "waiting"
      ? `${operation} waiting for shared limiter capacity`
      : `${operation} ${event} shared limiter`;
    debug.logger.debug("LIMITER", message, debug.botId);
  };
}
