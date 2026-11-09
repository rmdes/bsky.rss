// fleet/botLifecycle.ts
// Starts and stops one bot at runtime (initial activation and config reloads), keeping the
// coordinator's worker list, the per-bot operations map, and notifier claims in step.
import {Logger} from '../shared/logging/logger.ts';
import type {AuthCoordinator} from './authCoordinator.ts';
import {BotOperations} from './botOperations.ts';
import type {BotWorker} from './botWorker.ts';
import type {BotSpec} from './configLoader.ts';
import type {NotifierClaims} from './notifierClaims.ts';
import type {StopReason} from './configReconciler.ts';

export interface BotLifecycleOptions {
  coordinator: AuthCoordinator;
  operations: Map<string, BotOperations>;
  claims: NotifierClaims;
  buildWorker: (spec: BotSpec, notify: boolean) => Promise<BotWorker>;
  shutdownTimeoutMs: number;
  logger: Logger;
}

export interface BotLifecycle {
  build(spec: BotSpec): Promise<BotWorker>;
  startBot(spec: BotSpec): Promise<void>;
  stopBot(botId: string, reason: StopReason): Promise<void>;
}

export function createBotLifecycle(options: BotLifecycleOptions): BotLifecycle {
  async function build(spec: BotSpec): Promise<BotWorker> {
    let operations = options.operations.get(spec.botId);
    if (!operations) {
      operations = new BotOperations(spec.botId);
      options.operations.set(spec.botId, operations);
    }
    const notify = options.claims.claim(spec.botId, spec.identifier);
    try {
      const worker = await options.buildWorker(spec, notify);
      operations.recordConfigLoaded();
      return worker;
    } catch (error) {
      if (notify) options.claims.release(spec.botId);
      throw error;
    }
  }

  return {
    build,

    async startBot(spec: BotSpec): Promise<void> {
      let worker: BotWorker;
      try {
        worker = await build(spec);
      } catch (error) {
        options.coordinator.recordFailure(spec.botId, String(error));
        throw error;
      }
      options.coordinator.addWorker(worker);
    },

    async stopBot(botId: string, reason: StopReason): Promise<void> {
      // Never leave a half-stopped bot behind: the worker is unregistered first, and the claim
      // and bookkeeping are cleaned up even when shutdown throws (the error still propagates).
      const worker = options.coordinator.removeWorker(botId);
      let releasedIdentifier: string | undefined;
      try {
        if (worker) await worker.shutdown(options.shutdownTimeoutMs);
      } finally {
        releasedIdentifier = options.claims.release(botId);
        if (reason !== 'reload') {
          // a reload starts the same bot again right away
          options.operations.delete(botId);
          options.coordinator.forgetFailure(botId);
        }
      }
      if (reason !== 'reload' && releasedIdentifier) {
        options.logger.summary(
          'CONFIG',
          `notifications for @${releasedIdentifier} paused until another config for it starts`,
          botId,
        );
      }
    },
  };
}
