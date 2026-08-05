import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatBytesAsMegabytes, formatMemoryLogLine} from './memoryLog.ts';

test('formatBytesAsMegabytes reports binary megabytes with one decimal place', () => {
  assert.equal(formatBytesAsMegabytes(241 * 1024 * 1024), '241.0MB');
});

test('formatMemoryLogLine reports RSS in MB with one decimal place', () => {
  const line = formatMemoryLogLine({
    rss: 150 * 1024 * 1024,
    heapTotal: 80 * 1024 * 1024,
    heapUsed: 60 * 1024 * 1024,
    external: 5 * 1024 * 1024,
    arrayBuffers: 1 * 1024 * 1024,
  });
  assert.match(line, /rss=150\.0MB/);
  assert.match(line, /heapUsed=60\.0MB/);
});
