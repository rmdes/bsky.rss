// fleet/configReconciler.test.ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Logger, type LogRecord} from '../shared/logging/logger.ts';
import type {BotFingerprint} from './botFingerprint.ts';
import {NO_RELOAD_REQUESTS, type ReloadRequests} from './reloadRequests.ts';
import type {ConfigOutcome} from './botOperations.ts';
import {ConfigReconciler, type RunningBotConfig, type StopReason} from './configReconciler.ts';

interface Spec {
  botId: string;
  hash: string;
}

function fp(
  botId: string,
  hash: string,
  extra: Partial<{enabled: boolean; fields: Record<string, string>}> = {},
): BotFingerprint {
  return {
    ok: true,
    botId,
    enabled: extra.enabled ?? true,
    hash,
    fields: extra.fields ?? {feedUrl: hash},
  };
}

function harness(initial: Record<string, string> = {}) {
  const disk = new Map<string, BotFingerprint>();
  const calls: string[] = [];
  const outcomes: [string, ConfigOutcome][] = [];
  const records: LogRecord[] = [];
  const state = {
    secretsError: undefined as Error | undefined,
    loadErrors: new Map<string, Error>(),
    startFailures: new Set<string>(), // hashes that fail to start
    requests: NO_RELOAD_REQUESTS as ReloadRequests,
    startGate: undefined as Promise<void> | undefined,
    stopFailures: new Set<string>(), // bot ids whose stopBot throws
    recordFailures: new Set<string>(), // bot ids whose recordOutcome throws
    takeError: undefined as string | undefined,
  };
  const running = new Map<string, RunningBotConfig<Spec>>();
  for (const [botId, hash] of Object.entries(initial)) {
    disk.set(botId, fp(botId, hash));
    running.set(botId, {hash, fields: {feedUrl: hash}, spec: {botId, hash}});
  }
  const failed = new Map<string, string>();
  const reconciler = new ConfigReconciler<Spec>(
    {
      readSecrets: () => {
        if (state.secretsError) throw state.secretsError;
        return {};
      },
      listBotIds: () => [...disk.keys()].sort(),
      fingerprint: (_secrets, botId) => disk.get(botId)!,
      loadSpec: (_secrets, botId) => {
        const error = state.loadErrors.get(botId);
        if (error) throw error;
        const current = disk.get(botId)!;
        return {botId, hash: current.ok ? current.hash : 'x'};
      },
      takeReloadRequests: () => {
        if (state.takeError) return {ok: false, error: state.takeError};
        const requests = state.requests;
        state.requests = NO_RELOAD_REQUESTS;
        return {ok: true, requests};
      },
      startBot: async spec => {
        calls.push(`start ${spec.botId}@${spec.hash}`);
        if (state.startGate) await state.startGate;
        if (state.startFailures.has(spec.hash)) throw new Error('login rejected');
      },
      stopBot: async (botId: string, reason: StopReason) => {
        calls.push(`stop ${botId} (${reason})`);
        if (state.stopFailures.has(botId)) throw new Error('stop blew up');
      },
      recordOutcome: (botId, outcome) => {
        outcomes.push([botId, outcome]);
        if (state.recordFailures.has(botId)) throw new Error('record blew up');
      },
      logger: new Logger({defaultLevel: 'debug', sink: (_line, record) => records.push(record)}),
    },
    running,
    failed,
  );
  const summaries = () =>
    records.filter(r => r.level === 'summary').map(r => `${r.botId ?? ''} ${r.message}`);
  return {reconciler, disk, calls, outcomes, records, summaries, state, failed};
}

test('an unchanged running bot is left alone', async () => {
  const h = harness({a: 'h1'});
  await h.reconciler.tick();
  assert.deepEqual(h.calls, []);
});

test('a new enabled directory starts its bot', async () => {
  const h = harness();
  h.disk.set('a', fp('a', 'h1'));
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['start a@h1']);
  assert.deepEqual(h.outcomes, [['a', 'started']]);
  assert.ok(h.summaries().includes('a started'));
});

test('a changed fingerprint stops the old worker before starting the new one, naming changed fields', async () => {
  const h = harness({a: 'h1'});
  h.disk.set('a', fp('a', 'h2', {fields: {feedUrl: 'h2'}}));
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['stop a (reload)', 'start a@h2']);
  assert.deepEqual(h.outcomes, [['a', 'reloaded']]);
  assert.ok(h.summaries().includes('a reloaded: feedUrl changed'));
  await h.reconciler.tick();
  assert.equal(h.calls.length, 2); // applied hash is now the running one
});

test('a requested reload restarts an unchanged bot; "*" restarts every bot', async () => {
  const h = harness({a: 'h1', b: 'h2'});
  h.state.requests = {all: false, botIds: ['a']};
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['stop a (reload)', 'start a@h1']);
  assert.ok(h.summaries().includes('a reloaded (requested)'));
  h.calls.length = 0;
  h.state.requests = {all: true, botIds: []};
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['stop a (reload)', 'start a@h1', 'stop b (reload)', 'start b@h2']);
});

test('enabled:false stops the bot; enabled:true again starts it', async () => {
  const h = harness({a: 'h1'});
  h.disk.set('a', fp('a', 'h1-off', {enabled: false}));
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['stop a (disabled)']);
  h.disk.set('a', fp('a', 'h1'));
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['stop a (disabled)', 'start a@h1']);
});

test('a directory missing for one tick is tolerated; missing for two stops the bot', async () => {
  const h = harness({a: 'h1'});
  const saved = h.disk.get('a')!;
  h.disk.delete('a');
  await h.reconciler.tick();
  assert.deepEqual(h.calls, []);
  h.disk.set('a', saved);
  await h.reconciler.tick();
  h.disk.delete('a');
  await h.reconciler.tick();
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['stop a (directory removed)']);
});

test('an invalid config keeps the old bot running and is logged once', async () => {
  const h = harness({a: 'h1'});
  h.disk.set('a', {ok: false, botId: 'a', error: 'invalid bot.json'});
  await h.reconciler.tick();
  await h.reconciler.tick();
  await h.reconciler.tick();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(
    h.summaries().filter(s => s.includes('rejected')),
    ['a reload rejected: invalid bot.json'],
  );
});

test('a config that fails to load (e.g. missing secret) keeps the old bot and is logged once', async () => {
  const h = harness({a: 'h1'});
  h.disk.set('a', fp('a', 'h2'));
  h.state.loadErrors.set('a', new Error('No secret found for secretKey "a"'));
  await h.reconciler.tick();
  await h.reconciler.tick();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.outcomes, [['a', 'reload-rejected']]);
  assert.equal(h.summaries().filter(s => s.includes('rejected')).length, 1);
});

test('a reload whose new worker fails to start restores the previous config and is not retried', async () => {
  const h = harness({a: 'h1'});
  h.disk.set('a', fp('a', 'h2'));
  h.state.startFailures.add('h2');
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['stop a (reload)', 'start a@h2', 'start a@h1']);
  assert.deepEqual(h.outcomes, [['a', 'reload-failed-restored']]);
  assert.ok(h.summaries().includes('a reload failed, previous config restored'));
  await h.reconciler.tick();
  assert.equal(h.calls.length, 3); // same failing config is not retried
  h.disk.set('a', fp('a', 'h3'));
  await h.reconciler.tick();
  assert.deepEqual(h.calls.slice(3), ['stop a (reload)', 'start a@h3']);
});

test('a bot that failed at startup is retried only when its config changes or is requested', async () => {
  const h = harness();
  h.disk.set('a', fp('a', 'h1'));
  h.failed.set('a', 'h1');
  await h.reconciler.tick();
  assert.deepEqual(h.calls, []);
  h.state.requests = {all: false, botIds: ['a']};
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['start a@h1']);
});

test('a broken secrets file stops nothing and is logged once', async () => {
  const h = harness({a: 'h1'});
  h.state.secretsError = new Error('Unexpected token');
  h.disk.delete('a');
  await h.reconciler.tick();
  await h.reconciler.tick();
  await h.reconciler.tick();
  assert.deepEqual(h.calls, []);
  assert.equal(h.summaries().filter(s => s.includes('secrets')).length, 1);
});

test('overlapping ticks are skipped, and stop() waits for the tick in flight', async () => {
  const h = harness();
  h.disk.set('a', fp('a', 'h1'));
  let release!: () => void;
  h.state.startGate = new Promise(resolve => (release = resolve));
  const first = h.reconciler.tick();
  await h.reconciler.tick(); // skipped: first is still running
  assert.deepEqual(h.calls, ['start a@h1']);
  let stopped = false;
  const stopping = h.reconciler.stop().then(() => (stopped = true));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(stopped, false);
  release();
  await first;
  await stopping;
  assert.equal(stopped, true);
});

test('log lines never contain config values', async () => {
  const h = harness({a: 'h1'});
  h.disk.set('a', fp('a', 'h2', {fields: {feedUrl: 'https://x.test/?token=SECRETVALUE'}}));
  await h.reconciler.tick();
  assert.ok(h.records.every(r => !r.message.includes('SECRETVALUE')));
});

test('a throwing stopBot for a removed bot does not block other bots, and is not retried', async () => {
  const h = harness({a: 'h1', b: 'h1'});
  h.state.stopFailures.add('a');
  h.disk.delete('a');
  await h.reconciler.tick();
  h.disk.set('b', fp('b', 'h2', {fields: {feedUrl: 'h2'}}));
  await h.reconciler.tick(); // resolves even though stopBot('a') throws
  assert.deepEqual(h.calls, ['stop a (directory removed)', 'stop b (reload)', 'start b@h2']);
  assert.ok(h.summaries().includes('a config change failed; will retry when its config changes'));
  await h.reconciler.tick();
  assert.equal(h.calls.filter(c => c.startsWith('stop a')).length, 1);
  await h.reconciler.stop();
});

test('a throwing stopBot during a restart starts nothing and is not retried with the same hash', async () => {
  const h = harness({a: 'h1'});
  h.state.stopFailures.add('a');
  h.disk.set('a', fp('a', 'h2'));
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['stop a (reload)']);
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['stop a (reload)']);
  assert.equal(h.failed.get('a'), 'h2');
});

test('a throwing recordOutcome does not stop other bots in the same tick', async () => {
  const h = harness();
  h.state.recordFailures.add('a');
  h.disk.set('a', fp('a', 'h1'));
  h.disk.set('b', fp('b', 'h1'));
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['start a@h1', 'start b@h1']);
  assert.ok(h.outcomes.some(([id, o]) => id === 'b' && o === 'started'));
});

test('break, revert, break again with the same error is logged twice', async () => {
  const h = harness({a: 'h1'});
  const broken: BotFingerprint = {ok: false, botId: 'a', error: 'invalid bot.json'};
  h.disk.set('a', broken);
  await h.reconciler.tick();
  h.disk.set('a', fp('a', 'h1'));
  await h.reconciler.tick();
  h.disk.set('a', broken);
  await h.reconciler.tick();
  assert.equal(h.summaries().filter(s => s.includes('rejected')).length, 2);
});

test('a never-running bot whose config cannot be loaded records start-failed', async () => {
  const h = harness();
  h.disk.set('a', fp('a', 'h1'));
  h.state.loadErrors.set('a', new Error('No secret'));
  await h.reconciler.tick();
  assert.deepEqual(h.outcomes, [['a', 'start-failed']]);
});

test('a failed bot whose directory is removed then restored unchanged is started again', async () => {
  const h = harness();
  const saved = fp('a', 'h1');
  h.disk.set('a', saved);
  h.failed.set('a', 'h1');
  h.disk.delete('a');
  await h.reconciler.tick();
  h.disk.set('a', saved);
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['start a@h1']);
});

test('a persistent takeReloadRequests error is logged once', async () => {
  const h = harness();
  h.state.takeError = 'EACCES';
  await h.reconciler.tick();
  await h.reconciler.tick();
  await h.reconciler.tick();
  assert.equal(h.summaries().filter(s => s.includes('reload requests ignored')).length, 1);
});

test('when the new and previous specs both fail to start the bot is removed and start-failed recorded', async () => {
  const h = harness({a: 'h1'});
  h.disk.set('a', fp('a', 'h2'));
  h.state.startFailures.add('h2');
  h.state.startFailures.add('h1');
  await h.reconciler.tick();
  assert.deepEqual(h.calls, ['stop a (reload)', 'start a@h2', 'start a@h1']);
  assert.deepEqual(h.outcomes, [['a', 'start-failed']]);
  assert.ok(h.summaries().includes('a reload failed and previous config failed too; bot stopped'));
  await h.reconciler.tick();
  assert.equal(h.calls.length, 3);
});
