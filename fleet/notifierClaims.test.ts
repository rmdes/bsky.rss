import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NotifierClaims} from './notifierClaims.ts';

test('the first config for an account claims its notifications; siblings do not', () => {
  const claims = new NotifierClaims();
  assert.equal(claims.claim('euwatch-fr', 'euwatch.live'), true);
  assert.equal(claims.claim('euwatch-en', 'euwatch.live'), false);
  assert.equal(claims.claim('other', 'other.bsky.social'), true);
});

test('a holder re-claiming keeps the role', () => {
  const claims = new NotifierClaims();
  claims.claim('euwatch-fr', 'euwatch.live');
  assert.equal(claims.claim('euwatch-fr', 'euwatch.live'), true);
});

test('release frees the role for the next sibling that starts', () => {
  const claims = new NotifierClaims();
  claims.claim('euwatch-fr', 'euwatch.live');
  assert.equal(claims.release('euwatch-en'), undefined);
  assert.equal(claims.release('euwatch-fr'), 'euwatch.live');
  assert.equal(claims.claim('euwatch-en', 'euwatch.live'), true);
});
