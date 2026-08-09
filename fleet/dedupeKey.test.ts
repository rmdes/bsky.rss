import {test} from 'node:test';
import assert from 'node:assert/strict';
import {computeDedupeKey} from './dedupeKey.ts';

test('computeDedupeKey is deterministic for the same inputs', () => {
  const a = computeDedupeKey('account-1.example', 'https://example.com/post/1');
  const b = computeDedupeKey('account-1.example', 'https://example.com/post/1');
  assert.equal(a, b);
});

test('computeDedupeKey differs when the identifier differs', () => {
  // Keyed by identifier (the Bluesky account being published to), not by botId - two
  // bot configs with different identifiers must never collide on the same item.
  const a = computeDedupeKey('account-1.example', 'https://example.com/post/1');
  const b = computeDedupeKey('account-2.example', 'https://example.com/post/1');
  assert.notEqual(a, b);
});

test('computeDedupeKey differs when the item URL differs', () => {
  const a = computeDedupeKey('account-1.example', 'https://example.com/post/1');
  const b = computeDedupeKey('account-1.example', 'https://example.com/post/2');
  assert.notEqual(a, b);
});

test('computeDedupeKey output is a fixed-length hex string safe for use as an AT-URI record key', () => {
  const key = computeDedupeKey('account-1.example', 'https://example.com/post/1');
  assert.equal(key.length, 64); // SHA-256 hex digest
  assert.match(key, /^[a-zA-Z0-9_~.-]+$/); // AT-URI record key charset
});
