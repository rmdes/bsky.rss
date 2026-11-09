import type {BotWorker} from './botWorker.ts';
import type {BotSpec} from './configLoader.ts';
import {Logger, formatDebugError} from '../shared/logging/logger.ts';

export interface AuthCoordinatorOptions {
  bots: BotSpec[];
  staggerSeconds: number;
  activateBot: (spec: BotSpec) => Promise<BotWorker>;
  logger: Logger;
}

export class AuthCoordinator {
  private workers: BotWorker[] = [];
  private failures: {botId: string; error: string}[] = [];
  private aborted = false;
  private abortController: AbortController | null = null;

  constructor(private options: AuthCoordinatorOptions) {}

  async start(): Promise<void> {
    const {bots, staggerSeconds, activateBot} = this.options;
    for (let i = 0; i < bots.length; i++) {
      if (this.aborted) break;
      const spec = bots[i]!;
      try {
        const worker = await activateBot(spec);
        this.workers.push(worker);
        this.options.logger.summary('AUTH', 'Activated', spec.botId);
      } catch (err) {
        this.failures.push({botId: spec.botId, error: String(err)});
        this.options.logger.summary('AUTH', 'Failed to activate, skipping', spec.botId);
        this.options.logger.debug('AUTH', formatDebugError(err), spec.botId);
      }
      if (this.aborted) break;
      if (i < bots.length - 1) await this.interruptibleSleep(staggerSeconds * 1000);
    }
  }

  abortActivation(): void {
    this.aborted = true;
    this.abortController?.abort();
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.abortController = new AbortController();
      const timer = setTimeout(resolve, ms);
      this.abortController.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  activeWorkers(): BotWorker[] {
    return [...this.workers];
  }

  activationFailures(): {botId: string; error: string}[] {
    return this.failures;
  }

  // Used by the config reconciler (fleet/configReconciler.ts) to change the running set after
  // the initial staggered activation.
  addWorker(worker: BotWorker): void {
    this.workers = [...this.workers.filter(existing => existing.botId !== worker.botId), worker];
    this.forgetFailure(worker.botId);
  }

  removeWorker(botId: string): BotWorker | undefined {
    const worker = this.workers.find(existing => existing.botId === botId);
    this.workers = this.workers.filter(existing => existing.botId !== botId);
    return worker;
  }

  recordFailure(botId: string, error: string): void {
    this.failures = [...this.failures.filter(failure => failure.botId !== botId), {botId, error}];
  }

  forgetFailure(botId: string): void {
    this.failures = this.failures.filter(failure => failure.botId !== botId);
  }

  async shutdownAll(timeoutMs: number): Promise<void> {
    await Promise.all(this.workers.map(worker => worker.shutdown(timeoutMs)));
  }
}
