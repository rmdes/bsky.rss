import {test} from 'node:test';
import assert from 'node:assert/strict';
import {computeDedupeKey} from './dedupeKey.ts';

test('computeDedupeKey is deterministic for the same inputs', () => {
  const a = computeDedupeKey('bot-1', 'https://example.com/post/1');
  const b = computeDedupeKey('bot-1', 'https://example.com/post/1');
  assert.equal(a, b);
});

test('computeDedupeKey differs when the bot id differs', () => {
  const a = computeDedupeKey('bot-1', 'https://example.com/post/1');
  const b = computeDedupeKey('bot-2', 'https://example.com/post/1');
  assert.notEqual(a, b);
});

test('computeDedupeKey differs when the item URL differs', () => {
  const a = computeDedupeKey('bot-1', 'https://example.com/post/1');
  const b = computeDedupeKey('bot-1', 'https://example.com/post/2');
  assert.notEqual(a, b);
});

test('computeDedupeKey output is a fixed-length hex string safe for use as an AT-URI record key', () => {
  const key = computeDedupeKey('bot-1', 'https://example.com/post/1');
  assert.equal(key.length, 64); // SHA-256 hex digest
  assert.match(key, /^[a-zA-Z0-9_~.-]+$/); // AT-URI record key charset
});
