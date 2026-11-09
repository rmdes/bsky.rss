// fleet/configReconciler.ts
// Applies per-bot config changes while the fleet runs: every 10 s it fingerprints each bot's
// config, compares with what is running, and starts, stops, or restarts only the bots that
// differ, one at a time. See documentation/specs/2026-11-09-fleet-config-reload-design.md.
import {Logger, formatDebugError} from '../shared/logging/logger.ts';
import {changedFields, type BotFingerprint} from './botFingerprint.ts';
import type {ReloadRequests} from './reloadRequests.ts';
import type {ConfigOutcome} from './botOperations.ts';

export type StopReason = 'reload' | 'disabled' | 'directory removed';

export interface RunningBotConfig<Spec> {
  hash: string;
  fields: Record<string, string>;
  spec: Spec;
}

export interface ConfigReconcilerOptions<Spec> {
  readSecrets(): Record<string, string>;
  listBotIds(): string[];
  fingerprint(secrets: Readonly<Record<string, string>>, botId: string): BotFingerprint;
  loadSpec(secrets: Readonly<Record<string, string>>, botId: string): Spec;
  takeReloadRequests(): {ok: true; requests: ReloadRequests} | {ok: false; error: string};
  startBot(spec: Spec): Promise<void>;
  stopBot(botId: string, reason: StopReason): Promise<void>;
  recordOutcome(botId: string, outcome: ConfigOutcome): void;
  logger: Logger;
}

const DEFAULT_INTERVAL_MS = 10_000;
const MISSING_TICKS_BEFORE_STOP = 2;

// A message we can log safely: never a parser message (it may quote file content).
function describe(error: unknown): string {
  if (error instanceof SyntaxError) return 'invalid JSON';
  return error instanceof Error ? error.message : String(error);
}

export class ConfigReconciler<Spec> {
  private readonly missingTicks = new Map<string, number>();
  private readonly rejectedLogged = new Map<string, string>(); // botId -> rejection key
  private readonly warned = new Set<string>(); // fleet-level warnings already logged
  private ticking = false;
  private stopping = false; // set by stop(): the tick in flight finishes its current bot only
  private inFlight: Promise<void> = Promise.resolve();
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly options: ConfigReconcilerOptions<Spec>,
    private readonly running: Map<string, RunningBotConfig<Spec>>,
    private readonly failed: Map<string, string>,
  ) {}

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    // tick() records inFlight itself, and only when it actually runs: assigning the result here
    // would let a skipped tick replace the real in-flight promise that stop() waits on.
    this.interval = setInterval(() => void this.tick(), intervalMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    await this.inFlight.catch(() => undefined);
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopping) return; // the previous tick is still applying changes
    this.ticking = true;
    // A tick must never reject: start() fires it unawaited, and repeated unhandled rejections
    // make processSafety exit the whole fleet.
    const current = this.reconcile()
      .catch(error => {
        this.options.logger.summary('CONFIG', 'config reconcile failed; will retry next tick');
        this.options.logger.debug('CONFIG', formatDebugError(error));
      })
      .finally(() => {
        this.ticking = false;
      });
    this.inFlight = current;
    await current;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.options.logger.summary('CONFIG', message);
  }

  private async reconcile(): Promise<void> {
    let secrets: Record<string, string>;
    let botIds: string[];
    try {
      secrets = this.options.readSecrets();
      this.warned.delete('secrets');
    } catch {
      this.warnOnce(
        'secrets',
        'secrets file unreadable or invalid; config changes paused, all bots keep running',
      );
      return;
    }
    try {
      botIds = this.options.listBotIds();
      this.warned.delete('bots');
    } catch {
      this.warnOnce(
        'bots',
        'bots directory unreadable; config changes paused, all bots keep running',
      );
      return;
    }
    const taken = this.options.takeReloadRequests();
    let requests: ReloadRequests = {all: false, botIds: []};
    if (taken.ok) {
      requests = taken.requests;
      this.warned.delete('requests');
    } else {
      this.warnOnce('requests', `reload requests ignored: ${taken.error}`);
    }

    const onDisk = new Set(botIds);
    // A bot whose directory is gone must not stay blocked if the same directory comes back.
    for (const botId of [...this.failed.keys(), ...this.rejectedLogged.keys()]) {
      if (onDisk.has(botId)) continue;
      this.failed.delete(botId);
      this.rejectedLogged.delete(botId);
    }
    for (const botId of [...this.running.keys()]) {
      if (onDisk.has(botId)) continue;
      if (this.stopping) return;
      const missing = (this.missingTicks.get(botId) ?? 0) + 1;
      this.missingTicks.set(botId, missing);
      if (missing >= MISSING_TICKS_BEFORE_STOP) {
        await this.isolated(botId, () => this.stop_(botId, 'directory removed'));
      }
    }

    for (const botId of botIds) {
      if (this.stopping) return;
      this.missingTicks.delete(botId);
      await this.isolated(botId, () => this.reconcileBot(botId, secrets, requests));
    }
  }

  // One bot's failure (a throwing callback) never aborts the tick for the others. No error text
  // in the summary line: callbacks' messages may quote config values.
  private async isolated(botId: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.options.logger.summary(
        'CONFIG',
        'config change failed; will retry when its config changes',
        botId,
      );
      this.options.logger.debug('CONFIG', formatDebugError(error), botId);
    }
  }

  private async reconcileBot(
    botId: string,
    secrets: Record<string, string>,
    requests: ReloadRequests,
  ): Promise<void> {
    const requested = requests.all || requests.botIds.includes(botId);
    const fingerprint = this.options.fingerprint(secrets, botId);
    const running = this.running.get(botId);

    if (!fingerprint.ok) {
      this.reject(botId, `error:${fingerprint.error}`, fingerprint.error, Boolean(running));
      return;
    }
    if (!fingerprint.enabled) {
      this.failed.delete(botId);
      if (running) await this.stop_(botId, 'disabled');
      return;
    }
    if (running) {
      // Back on the running config: a later identical break is a new event worth logging.
      if (fingerprint.hash === running.hash) {
        this.rejectedLogged.delete(botId);
        if (!requested) return;
      }
      if (this.failed.get(botId) === fingerprint.hash && !requested) return;
      await this.restart(botId, fingerprint, running, secrets, requested);
    } else {
      if (this.failed.get(botId) === fingerprint.hash && !requested) return;
      await this.start_(botId, fingerprint, secrets);
    }
  }

  private reject(botId: string, key: string, reason: string, isRunning: boolean): void {
    if (this.rejectedLogged.get(botId) === key) return;
    this.rejectedLogged.set(botId, key);
    this.options.logger.summary(
      'CONFIG',
      isRunning ? `reload rejected: ${reason}` : `not started: ${reason}`,
      botId,
    );
    this.options.recordOutcome(botId, isRunning ? 'reload-rejected' : 'start-failed');
  }

  private loadSpec(
    botId: string,
    fingerprint: BotFingerprint & {ok: true},
    secrets: Record<string, string>,
    isRunning: boolean,
  ): Spec | undefined {
    try {
      return this.options.loadSpec(secrets, botId);
    } catch (error) {
      this.reject(botId, `load:${fingerprint.hash}`, describe(error), isRunning);
      this.failed.set(botId, fingerprint.hash);
      return undefined;
    }
  }

  private async start_(
    botId: string,
    fingerprint: BotFingerprint & {ok: true},
    secrets: Record<string, string>,
  ): Promise<void> {
    const spec = this.loadSpec(botId, fingerprint, secrets, false);
    if (spec === undefined) return;
    try {
      await this.options.startBot(spec);
    } catch (error) {
      this.failed.set(botId, fingerprint.hash);
      this.options.logger.summary('CONFIG', 'failed to start', botId);
      this.options.logger.debug('CONFIG', formatDebugError(error), botId);
      this.options.recordOutcome(botId, 'start-failed');
      return;
    }
    this.running.set(botId, {hash: fingerprint.hash, fields: fingerprint.fields, spec});
    this.failed.delete(botId);
    this.rejectedLogged.delete(botId);
    this.options.logger.summary('CONFIG', 'started', botId);
    this.options.recordOutcome(botId, 'started');
  }

  private async restart(
    botId: string,
    fingerprint: BotFingerprint & {ok: true},
    previous: RunningBotConfig<Spec>,
    secrets: Record<string, string>,
    requested: boolean,
  ): Promise<void> {
    const spec = this.loadSpec(botId, fingerprint, secrets, true);
    if (spec === undefined) return; // the old worker keeps running
    try {
      await this.options.stopBot(botId, 'reload');
    } catch (error) {
      // The old worker's state is unknown: treat it as not running, and do not start a second one.
      this.running.delete(botId);
      this.failed.set(botId, fingerprint.hash);
      try {
        this.options.recordOutcome(botId, 'start-failed'); // keep fleet:status honest
      } catch {
        // must not mask the original error
      }
      throw error;
    }
    try {
      await this.options.startBot(spec);
    } catch (error) {
      this.failed.set(botId, fingerprint.hash);
      // Bookkeeping that can throw (logging, recordOutcome) always runs after worker state is
      // settled, so the rollback is never skipped and `running` always matches reality.
      let restored = false;
      let rollbackError: unknown;
      try {
        await this.options.startBot(previous.spec);
        restored = true;
      } catch (e) {
        rollbackError = e;
        this.running.delete(botId);
      }
      this.options.logger.debug('CONFIG', formatDebugError(error), botId);
      if (restored) {
        this.options.logger.summary('CONFIG', 'reload failed, previous config restored', botId);
        this.options.recordOutcome(botId, 'reload-failed-restored');
      } else {
        this.options.logger.summary(
          'CONFIG',
          'reload failed and previous config failed too; bot stopped',
          botId,
        );
        this.options.logger.debug('CONFIG', formatDebugError(rollbackError), botId);
        this.options.recordOutcome(botId, 'start-failed');
      }
      return;
    }
    const changed = changedFields(previous.fields, fingerprint.fields);
    this.running.set(botId, {hash: fingerprint.hash, fields: fingerprint.fields, spec});
    this.failed.delete(botId);
    this.rejectedLogged.delete(botId);
    this.options.logger.summary(
      'CONFIG',
      changed.length > 0
        ? `reloaded: ${changed.join(', ')} changed`
        : requested
          ? 'reloaded (requested)'
          : 'reloaded',
      botId,
    );
    this.options.recordOutcome(botId, 'reloaded');
  }

  private async stop_(botId: string, reason: StopReason): Promise<void> {
    try {
      await this.options.stopBot(botId, reason);
    } finally {
      this.running.delete(botId); // even if stopping threw: never retry forever
      this.missingTicks.delete(botId);
    }
    this.options.logger.summary('CONFIG', `stopped (${reason})`, botId);
  }
}
