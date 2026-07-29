import type { BotWorker } from "./botWorker.ts";
import type { BotSpec } from "./configLoader.ts";

export interface AuthCoordinatorOptions {
  bots: BotSpec[];
  staggerSeconds: number;
  activateBot: (spec: BotSpec) => Promise<BotWorker>;
}

function log(botId: string, message: string): void {
  console.log(`[${new Date().toUTCString()}] - [bsky.rss AUTH] [${botId}] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AuthCoordinator {
  private workers: BotWorker[] = [];
  private failures: { botId: string; error: string }[] = [];

  constructor(private options: AuthCoordinatorOptions) {}

  async start(): Promise<void> {
    const { bots, staggerSeconds, activateBot } = this.options;
    for (let i = 0; i < bots.length; i++) {
      const spec = bots[i]!;
      try {
        const worker = await activateBot(spec);
        this.workers.push(worker);
        log(spec.botId, "Activated");
      } catch (err) {
        this.failures.push({ botId: spec.botId, error: String(err) });
        log(spec.botId, `Failed to activate, skipping: ${err}`);
      }
      if (i < bots.length - 1) await sleep(staggerSeconds * 1000);
    }
  }

  activeWorkers(): BotWorker[] {
    return [...this.workers];
  }

  activationFailures(): { botId: string; error: string }[] {
    return this.failures;
  }

  stopAll(): void {
    for (const worker of this.workers) worker.stop();
  }
}
