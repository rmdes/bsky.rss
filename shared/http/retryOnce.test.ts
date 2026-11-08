import {test} from 'node:test';
import assert from 'node:assert/strict';
import {retryOnce} from './retryOnce.ts';

test('retryOnce returns the first success without retrying', async () => {
  let calls = 0;
  const result = await retryOnce(async () => {
    calls++;
    return 'ok';
  }, 0);
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('retryOnce retries a failed attempt once and returns its result', async () => {
  let calls = 0;
  const result = await retryOnce(async () => {
    calls++;
    if (calls === 1) throw new Error('flaky 404');
    return 'ok';
  }, 0);
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('retryOnce gives up after the second failure with its error', async () => {
  let calls = 0;
  await assert.rejects(
    retryOnce(async () => {
      calls++;
      throw new Error(`failure ${calls}`);
    }, 0),
    /failure 2/,
  );
  assert.equal(calls, 2);
});

test('retryOnce waits before retrying', async () => {
  const started = Date.now();
  let calls = 0;
  await retryOnce(async () => {
    calls++;
    if (calls === 1) throw new Error('flaky');
  }, 50);
  assert.ok(Date.now() - started >= 45);
});
