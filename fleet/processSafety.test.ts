import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installProcessSafetyNet} from './processSafety.ts';
import {FleetLogger, type FleetLogRecord} from './logging.ts';

test('process safety installs once, keeps running, and routes safe summaries plus debug errors', () => {
  const records: FleetLogRecord[] = [];
  const logger = new FleetLogger({
    defaultLevel: 'debug',
    sink: (_line, record) => records.push(record),
  });
  const rejectionListenersBefore = process.listeners('unhandledRejection');
  const exceptionListenersBefore = process.listeners('uncaughtException');

  installProcessSafetyNet(logger);
  installProcessSafetyNet(
    new FleetLogger({defaultLevel: 'debug', sink: () => assert.fail('second logger used')}),
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
    [
      'Unhandled rejection (process continues): Error',
      'Uncaught exception (process continues): TypeError',
    ],
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
