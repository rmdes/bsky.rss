import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isStillFresh, selectEligibleItems} from './freshnessPolicy.ts';
import type {QueueItemRow} from './botStore.ts';

function row(overrides: Partial<QueueItemRow>): QueueItemRow {
  return {
    id: 1,
    title: 't',
    content: 'c',
    embedJson: null,
    languagesJson: null,
    facetsJson: null,
    itemDate: '2026-01-01T00:00:00.000Z',
    dedupeKey: 'k',
    status: 'queued',
    enqueuedAt: '2026-01-01T00:00:00.000Z',
    publishedAt: null,
    ...overrides,
  };
}

test('isStillFresh is true for an item within the age window', () => {
  const now = new Date('2026-01-01T01:00:00.000Z'); // 60 min after itemDate
  assert.equal(isStillFresh('2026-01-01T00:00:00.000Z', 120, now), true);
});

test('isStillFresh is false for an item past the age window', () => {
  const now = new Date('2026-01-01T03:00:00.000Z'); // 180 min after itemDate
  assert.equal(isStillFresh('2026-01-01T00:00:00.000Z', 120, now), false);
});

test('isStillFresh is inclusive at exactly the cutoff', () => {
  const now = new Date('2026-01-01T02:00:00.000Z'); // exactly 120 min after itemDate
  assert.equal(isStillFresh('2026-01-01T00:00:00.000Z', 120, now), true);
});

test('selectEligibleItems returns everything as toPublish when under the catchup limit and all fresh', () => {
  const now = new Date('2026-01-01T00:10:00.000Z');
  const rows = [
    row({id: 1, itemDate: '2026-01-01T00:00:00.000Z'}),
    row({id: 2, itemDate: '2026-01-01T00:05:00.000Z'}),
  ];
  const {toPublish, toSkip} = selectEligibleItems(
    rows,
    {maxCatchupItems: 5, maxItemAgeMinutes: 120},
    now,
  );
  assert.equal(toPublish.length, 2);
  assert.equal(toSkip.length, 0);
});

test('selectEligibleItems publishes oldest-first even if input order is newest-first', () => {
  const now = new Date('2026-01-01T00:10:00.000Z');
  const rows = [
    row({id: 2, itemDate: '2026-01-01T00:05:00.000Z'}),
    row({id: 1, itemDate: '2026-01-01T00:00:00.000Z'}),
  ];
  const {toPublish} = selectEligibleItems(rows, {maxCatchupItems: 5, maxItemAgeMinutes: 120}, now);
  assert.deepEqual(
    toPublish.map(r => r.id),
    [1, 2],
  );
});

test('selectEligibleItems marks items past maxItemAgeMinutes as toSkip, not toPublish', () => {
  const now = new Date('2026-01-01T03:00:00.000Z'); // 180 min after itemDate, limit is 120
  const rows = [row({id: 1, itemDate: '2026-01-01T00:00:00.000Z'})];
  const {toPublish, toSkip} = selectEligibleItems(
    rows,
    {maxCatchupItems: 5, maxItemAgeMinutes: 120},
    now,
  );
  assert.equal(toPublish.length, 0);
  assert.equal(toSkip.length, 1);
  assert.equal(toSkip[0]!.id, 1);
});

test('selectEligibleItems keeps only the newest maxCatchupItems among fresh items, skips the rest', () => {
  const now = new Date('2026-01-01T00:10:00.000Z');
  const rows = [
    row({id: 1, itemDate: '2026-01-01T00:00:00.000Z'}),
    row({id: 2, itemDate: '2026-01-01T00:01:00.000Z'}),
    row({id: 3, itemDate: '2026-01-01T00:02:00.000Z'}),
  ];
  const {toPublish, toSkip} = selectEligibleItems(
    rows,
    {maxCatchupItems: 2, maxItemAgeMinutes: 120},
    now,
  );
  // newest 2 by item_date are id 2 and 3; published oldest-first among those kept
  assert.deepEqual(
    toPublish.map(r => r.id),
    [2, 3],
  );
  assert.deepEqual(
    toSkip.map(r => r.id),
    [1],
  );
});

test('selectEligibleItems combines staleness and catchup-limit skipping correctly', () => {
  const now = new Date('2026-01-01T03:00:00.000Z');
  const rows = [
    row({id: 1, itemDate: '2025-12-31T00:00:00.000Z'}), // ancient, stale
    row({id: 2, itemDate: '2026-01-01T01:59:00.000Z'}), // fresh, 61 min old
    row({id: 3, itemDate: '2026-01-01T02:00:00.000Z'}), // fresh, 60 min old
    row({id: 4, itemDate: '2026-01-01T02:30:00.000Z'}), // fresh, 30 min old
  ];
  const {toPublish, toSkip} = selectEligibleItems(
    rows,
    {maxCatchupItems: 2, maxItemAgeMinutes: 120},
    now,
  );
  // fresh set: 2, 3, 4 (all within 120 min). Newest 2 of those: 3, 4. Oldest-first: [3, 4].
  assert.deepEqual(
    toPublish.map(r => r.id),
    [3, 4],
  );
  // skipped: id 1 (stale) + id 2 (over catchup limit)
  assert.deepEqual(toSkip.map(r => r.id).sort(), [1, 2]);
});

test('selectEligibleItems handles an empty input', () => {
  const {toPublish, toSkip} = selectEligibleItems([], {
    maxCatchupItems: 5,
    maxItemAgeMinutes: 120,
  });
  assert.deepEqual(toPublish, []);
  assert.deepEqual(toSkip, []);
});
