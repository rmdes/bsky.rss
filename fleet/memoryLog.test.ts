import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatBytesAsMegabytes} from './memoryLog.ts';

test('formatBytesAsMegabytes reports binary megabytes with one decimal place', () => {
  assert.equal(formatBytesAsMegabytes(241 * 1024 * 1024), '241.0MB');
});
