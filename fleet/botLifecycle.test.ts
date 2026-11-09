// fleet/botLifecycle.test.ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Logger, type LogRecord} from '../shared/logging/logger.ts';
import {AuthCoordinator} from './authCoordinator.ts';
import {BotOperations} from './botOperations.ts';
import {BotStore} from './botStore.ts';
import type {BotWorker} from './botWorker.ts';
import type {BotSpec} from './configLoader.ts';
import {NotifierClaims} from './notifierClaims.ts';
import {createBotLifecycle} from './botLifecycle.ts';

function spec(botId: string, identifier: string, dbPath: string): BotSpec {
  return {
    botId,
    identifier,
    appPassword: 'pw',
    instanceUrl: 'https://bsky.social',
    feedUrl: 'https://example.test/feed.xml',
    fetchIntervalMinutes: 5,
    dbPath,
    feedReaderConfig: {string: '$title'},
    schedulerConfig: {adaptiveSpacing: false, spacingWindow: 600, minSpacing: 1, maxSpacing: 60},
  } as BotSpec;
}

// A worker that, like the real one, owns its BotStore and closes it on shutdown.
function storeWorker(s: BotSpec): BotWorker & {store: BotStore} {
  const store = new BotStore(s.dbPath);
  return {botId: s.botId, store, shutdown: async () => store.close()} as unknown as BotWorker & {
    store: BotStore;
  };
}

function setup(t: {after(callback: () => void): void}) {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const records: LogRecord[] = [];
  const logger = new Logger({defaultLevel: 'debug', sink: (_line, record) => records.push(record)});
  const coordinator = new AuthCoordinator({
    logger,
    bots: [],
    staggerSeconds: 0,
    activateBot: async () => {
      throw new Error('unused');
    },
  });
  const operations = new Map<string, BotOperations>();
  const claims = new NotifierClaims();
  const notified: string[] = [];
  const failing = new Set<string>();
  const workers = new Map<string, BotWorker & {store: BotStore}>();
  const lifecycle = createBotLifecycle({
    coordinator,
    operations,
    claims,
    buildWorker: async (s, notify) => {
      if (failing.has(s.botId)) throw new Error('login rejected');
      if (notify) notified.push(s.botId);
      const worker = storeWorker(s);
      workers.set(s.botId, worker);
      return worker;
    },
    shutdownTimeoutMs: 1000,
    logger,
  });
  return {dir, records, coordinator, operations, claims, notified, failing, workers, lifecycle};
}

test('startBot registers the worker, creates operations, and records config loaded', async t => {
  const s = setup(t);
  await s.lifecycle.startBot(spec('a', 'a.bsky.social', join(s.dir, 'a.sqlite')));
  assert.deepEqual(
    s.coordinator.activeWorkers().map(w => w.botId),
    ['a'],
  );
  assert.ok(s.operations.get('a')?.snapshot().configLoadedAt);
  assert.deepEqual(s.notified, ['a']);
  await s.lifecycle.stopBot('a', 'disabled');
});

test('a failed start records an activation failure and releases the notifier claim', async t => {
  const s = setup(t);
  s.failing.add('a');
  await assert.rejects(
    s.lifecycle.startBot(spec('a', 'shared.bsky.social', join(s.dir, 'a.sqlite'))),
  );
  assert.deepEqual(
    s.coordinator.activationFailures().map(f => f.botId),
    ['a'],
  );
  await s.lifecycle.startBot(spec('b', 'shared.bsky.social', join(s.dir, 'b.sqlite')));
  assert.deepEqual(s.notified, ['b']); // the role was free for the sibling
  await s.lifecycle.stopBot('b', 'disabled');
});

test('stopping a disabled bot drops its operations; a reload keeps them', async t => {
  const s = setup(t);
  await s.lifecycle.startBot(spec('a', 'a.bsky.social', join(s.dir, 'a.sqlite')));
  await s.lifecycle.stopBot('a', 'reload');
  assert.ok(s.operations.has('a'));
  await s.lifecycle.startBot(spec('a', 'a.bsky.social', join(s.dir, 'a.sqlite')));
  await s.lifecycle.stopBot('a', 'disabled');
  assert.equal(s.operations.has('a'), false);
  assert.deepEqual(s.coordinator.activeWorkers(), []);
});

test('stopping the notifier holder logs that the account’s notifications pause', async t => {
  const s = setup(t);
  await s.lifecycle.startBot(spec('a', 'shared.bsky.social', join(s.dir, 'a.sqlite')));
  await s.lifecycle.stopBot('a', 'disabled');
  assert.ok(
    s.records.some(r => r.message.includes('notifications for @shared.bsky.social paused')),
  );
});

test('a reload swaps workers on the same store: queue, cursor, and dedup history survive', async t => {
  const s = setup(t);
  const dbPath = join(s.dir, 'a.sqlite');
  await s.lifecycle.startBot(spec('a', 'a.bsky.social', dbPath));
  const before = s.workers.get('a')!.store;
  before.enqueue({
    title: 't',
    content: 'queued before reload',
    embedJson: null,
    languagesJson: null,
    facetsJson: null,
    itemDate: '2026-11-09T12:00:00.000Z',
    dedupeKey: 'k1',
  });
  before.writeCursor(new Date('2026-11-09T11:00:00.000Z'));
  before.writeSeenValue('https://example.test/seen');
  await s.lifecycle.stopBot('a', 'reload');
  await s.lifecycle.startBot(spec('a', 'a.bsky.social', dbPath));
  const after = s.workers.get('a')!.store;
  assert.notEqual(after, before);
  assert.equal(after.countQueued(), 1);
  assert.equal(after.readCursor(), '2026-11-09T11:00:00.000Z');
  assert.equal(after.seenValueExists('https://example.test/seen'), true);
  await s.lifecycle.stopBot('a', 'disabled');
});

test('a shutdown that throws still unregisters the worker, frees the claim, and rejects', async t => {
  const s = setup(t);
  await s.lifecycle.startBot(spec('a', 'shared.bsky.social', join(s.dir, 'a.sqlite')));
  const worker = s.workers.get('a')!;
  const realShutdown = worker.shutdown;
  worker.shutdown = async () => {
    await realShutdown.call(worker, 1000);
    throw new Error('shutdown boom');
  };
  await assert.rejects(s.lifecycle.stopBot('a', 'disabled'), /shutdown boom/);
  assert.deepEqual(s.coordinator.activeWorkers(), []);
  assert.equal(s.operations.has('a'), false);
  await s.lifecycle.startBot(spec('b', 'shared.bsky.social', join(s.dir, 'b.sqlite')));
  assert.deepEqual(s.notified, ['a', 'b']); // claim was freed for the sibling
  await s.lifecycle.stopBot('b', 'disabled');
});

test('starting a bot that already has a registered worker shuts the old one down first', async t => {
  const s = setup(t);
  const dbPath = join(s.dir, 'a.sqlite');
  await s.lifecycle.startBot(spec('a', 'a.bsky.social', dbPath));
  const old = s.workers.get('a')!;
  const order: string[] = [];
  const realShutdown = old.shutdown;
  old.shutdown = async ms => {
    order.push('old shutdown');
    await realShutdown.call(old, ms);
  };
  const realAdd = s.coordinator.addWorker.bind(s.coordinator);
  s.coordinator.addWorker = worker => {
    order.push('add new');
    realAdd(worker);
  };
  await s.lifecycle.startBot(spec('a', 'a.bsky.social', dbPath));
  assert.deepEqual(order, ['old shutdown', 'add new']);
  assert.deepEqual(s.coordinator.activeWorkers(), [s.workers.get('a')]);
  assert.notEqual(s.workers.get('a'), old);
  assert.ok(s.records.some(r => r.message.includes('replaced a still-running worker')));
  await s.lifecycle.stopBot('a', 'disabled');
});
