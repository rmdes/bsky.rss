import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTimeoutFetch} from './timeoutFetch.ts';

test('createTimeoutFetch aborts a fetch that never resolves', async () => {
  // Real fetch implementations listen to the passed AbortSignal and reject on abort -
  // a mock that ignores the signal (a bare `new Promise(() => {})`) can't distinguish
  // "timeoutFetch aborts correctly" from "nothing ever resolves this promise" and would
  // hang the test itself regardless of what createTimeoutFetch does.
  const hangingFetch: typeof globalThis.fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    });
  const timeoutFetch = createTimeoutFetch(20, hangingFetch);

  await assert.rejects(() => timeoutFetch('https://example.com'), /timed out/i);
});

test('createTimeoutFetch resolves normally when the underlying fetch is fast', async () => {
  const fastFetch: typeof globalThis.fetch = async () => new Response('ok');
  const timeoutFetch = createTimeoutFetch(1000, fastFetch);

  const response = await timeoutFetch('https://example.com');
  assert.equal(await response.text(), 'ok');
});

test('createTimeoutFetch combines a caller-supplied signal with its own timeout', async () => {
  const hangingFetch: typeof globalThis.fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    });
  const timeoutFetch = createTimeoutFetch(1000, hangingFetch);

  const callerController = new AbortController();
  const pending = timeoutFetch('https://example.com', {signal: callerController.signal});
  callerController.abort(new Error('caller cancelled'));

  await assert.rejects(() => pending, /caller cancelled/);
});
