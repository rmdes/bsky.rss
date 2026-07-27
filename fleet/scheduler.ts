export interface SchedulerConfig {
  minSpacing: number;
  maxSpacing: number;
  spacingWindow: number;
  adaptiveSpacing: boolean;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export class Scheduler {
  private lastPostTimestamp = 0;
  private rateLimitDeadline = 0;

  constructor(private config: SchedulerConfig) {}

  private computeDelaySeconds(queueDepth: number): number {
    if (!this.config.adaptiveSpacing) return 0;
    if (queueDepth <= 1) return 0;
    const window = this.config.spacingWindow || 600;
    const min = this.config.minSpacing || 1;
    const max = this.config.maxSpacing || 60;
    return clamp(window / queueDepth, min, max);
  }

  private nextEligibleTime(queueDepth: number): number {
    const minSpacingDeadline = this.lastPostTimestamp
      ? this.lastPostTimestamp + this.config.minSpacing * 1000
      : 0;
    const adaptiveDeadline = this.lastPostTimestamp
      ? this.lastPostTimestamp + this.computeDelaySeconds(queueDepth) * 1000
      : 0;
    return Math.max(minSpacingDeadline, adaptiveDeadline, this.rateLimitDeadline);
  }

  isEligibleNow(queueDepth: number): boolean {
    return Date.now() >= this.nextEligibleTime(queueDepth);
  }

  recordPost(): void {
    this.lastPostTimestamp = Date.now();
  }

  setRateLimitDeadline(retryAfterSeconds: number): void {
    this.rateLimitDeadline = retryAfterSeconds > 0 ? Date.now() + retryAfterSeconds * 1000 : 0;
  }
}
