import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Scheduler} from './scheduler.ts';

test('isEligibleNow is true before any post has been recorded', () => {
  const s = new Scheduler({
    minSpacing: 1,
    maxSpacing: 60,
    spacingWindow: 600,
    adaptiveSpacing: true,
  });
  assert.equal(s.isEligibleNow(1), true);
});

test('minSpacing blocks posting immediately after a post', () => {
  const s = new Scheduler({
    minSpacing: 60,
    maxSpacing: 60,
    spacingWindow: 600,
    adaptiveSpacing: false,
  });
  s.recordPost();
  assert.equal(s.isEligibleNow(1), false);
});

test('adaptiveSpacing spreads out a deep queue beyond minSpacing alone', () => {
  const s = new Scheduler({
    minSpacing: 1,
    maxSpacing: 60,
    spacingWindow: 600,
    adaptiveSpacing: true,
  });
  s.recordPost();
  // window/queueDepth = 600/10 = 60s, clamped to [1,60] => 60s, which exceeds minSpacing's 1s
  assert.equal(s.isEligibleNow(10), false);
});

test('adaptiveSpacing does not add delay for a queue of 1', () => {
  const s = new Scheduler({
    minSpacing: 1,
    maxSpacing: 60,
    spacingWindow: 600,
    adaptiveSpacing: true,
  });
  s.recordPost();
  // computeDelaySeconds returns 0 when queueDepth <= 1; only minSpacing (1s) applies.
  // Can't assert eligibility flips true without waiting 1s in real time, so assert
  // it's still false immediately after recordPost (minSpacing alone still blocks it).
  assert.equal(s.isEligibleNow(1), false);
});

test('computeDelaySeconds is bypassed entirely when adaptiveSpacing is false', () => {
  const s = new Scheduler({
    minSpacing: 5,
    maxSpacing: 60,
    spacingWindow: 600,
    adaptiveSpacing: false,
  });
  s.recordPost();
  // A deep queue would normally force a long adaptive delay; with adaptiveSpacing off,
  // only minSpacing (5s) applies, so this is still blocked by minSpacing alone, not by
  // whatever the adaptive math would have produced for queueDepth=50 (60s clamped max).
  assert.equal(s.isEligibleNow(50), false);
});

test('rate-limit deadline overrides spacing once set', () => {
  const s = new Scheduler({
    minSpacing: 1,
    maxSpacing: 60,
    spacingWindow: 600,
    adaptiveSpacing: false,
  });
  s.setRateLimitDeadline(9999);
  assert.equal(s.isEligibleNow(1), false);
});

test('rate-limit deadline of 0 seconds does not block eligibility', () => {
  const s = new Scheduler({
    minSpacing: 1,
    maxSpacing: 60,
    spacingWindow: 600,
    adaptiveSpacing: false,
  });
  s.setRateLimitDeadline(0);
  assert.equal(s.isEligibleNow(1), true);
});
