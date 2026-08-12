import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installProcessSafetyNet} from './processSafety.ts';
import {Logger, type LogRecord} from '../shared/logging/logger.ts';

// installed/unhandledRejectionCount in processSafety.ts are module-level state, not
// per-call - installProcessSafetyNet() is a no-op on a second call, so a later test can't
// rediscover the listener via its own before/after diff around installProcessSafetyNet
// (nothing changes, it's already installed). The first test below still reliably identifies
// the real listener with a before/after diff at the moment it's actually added; every other
// test in this file reuses that exact same reference via this module-scope variable rather
// than re-deriving it. (A global before/after diff at module load doesn't work either - the
// test runner itself lazily attaches its own unhandledRejection listener sometime after
// module load, which would get misidentified as ours.)
//
// The handler closes over the Logger it was installed with, so a later test reusing this
// reference also needs that same Logger's records array to see what the handler logs -
// installedLoggerRecords shares it for the same reason.
let installedRejectionHandler: NodeJS.UnhandledRejectionListener | undefined;
let installedLoggerRecords: LogRecord[] | undefined;

test('process safety installs once, keeps running, and routes safe summaries plus debug errors', () => {
  const records: LogRecord[] = [];
  const logger = new Logger({
    defaultLevel: 'debug',
    sink: (_line, record) => records.push(record),
  });
  const rejectionListenersBefore = process.listeners('unhandledRejection');
  const exceptionListenersBefore = process.listeners('uncaughtException');

  installProcessSafetyNet(logger);
  installProcessSafetyNet(
    new Logger({defaultLevel: 'debug', sink: () => assert.fail('second logger used')}),
  );

  const rejectionListenersAfter = process.listeners('unhandledRejection');
  const exceptionListenersAfter = process.listeners('uncaughtException');
  assert.equal(rejectionListenersAfter.length, rejectionListenersBefore.length + 1);
  assert.equal(exceptionListenersAfter.length, exceptionListenersBefore.length + 1);

  const rejectionHandler = rejectionListenersAfter.find(
    listener => !rejectionListenersBefore.includes(listener),
  );
  const exceptionHandler = exceptionListenersAfter.find(
    listener => !exceptionListenersBefore.includes(listener),
  );
  assert.ok(rejectionHandler);
  assert.ok(exceptionHandler);
  installedRejectionHandler = rejectionHandler;
  installedLoggerRecords = records;

  let exited = false;
  const originalExit = process.exit;
  process.exit = (() => {
    exited = true;
  }) as unknown as typeof process.exit;
  try {
    rejectionHandler(new Error('private rejection detail'), Promise.resolve());
    exceptionHandler(new TypeError('private exception detail'), 'uncaughtException');
  } finally {
    process.exit = originalExit;
  }

  assert.equal(exited, false);
  assert.deepEqual(
    records.filter(record => record.level === 'summary').map(record => record.message),
    ['Unhandled rejection detected: Error', 'Uncaught exception (process continues): TypeError'],
  );
  assert.ok(
    records.some(
      record => record.level === 'debug' && record.message.includes('private rejection detail'),
    ),
  );
  assert.ok(
    records.some(
      record => record.level === 'debug' && record.message.includes('private exception detail'),
    ),
  );
  assert.ok(
    records
      .filter(record => record.level === 'summary')
      .every(record => !record.message.includes('private')),
  );
});

test('process safety trips the circuit breaker after crossing the rejection threshold', () => {
  // No-op: the earlier test already installed the real listener and captured it (and its
  // logger's records array) above. This still exercises the "already installed" no-op path.
  installProcessSafetyNet(
    new Logger({defaultLevel: 'debug', sink: () => assert.fail('a fresh logger got wired in')}),
  );

  assert.ok(
    installedRejectionHandler && installedLoggerRecords,
    'expected the earlier test to have already installed and captured the rejection handler',
  );
  const rejectionHandler = installedRejectionHandler;
  const records = installedLoggerRecords;

  let exitCode: number | undefined;
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    exitCode = code;
  }) as unknown as typeof process.exit;

  try {
    // unhandledRejectionCount (REJECTION_THRESHOLD = 3) is module-global and may already
    // carry a count left over from an earlier test in this file - each call schedules a
    // real 60s setTimeout decrement, which won't fire during a test run. Rather than assume
    // a fixed starting count, call the handler until the breaker trips (bounded well above
    // the threshold so this can't loop forever if something regresses).
    for (let i = 0; i < 5 && exitCode === undefined; i++) {
      rejectionHandler!(new Error(`synthetic rejection ${i}`), Promise.resolve());
    }
  } finally {
    process.exit = originalExit;
  }

  assert.equal(exitCode, 1);
  assert.ok(
    records.some(
      record =>
        record.level === 'summary' &&
        record.message.includes('unhandled rejections') &&
        record.message.includes('exiting'),
    ),
  );
});
