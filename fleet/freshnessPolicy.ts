import type {QueueItemRow} from './botStore.ts';

export interface FreshnessConfig {
  maxCatchupItems: number;
  maxItemAgeMinutes: number;
  // Per bot (config.json): 'firstSeen' ages an item from when the bot queued it, for feeds whose
  // own dates are unusable (midnight-only, or a folder of feeds that lag each other).
  freshnessFrom?: 'itemDate' | 'firstSeen';
}

function freshnessDate(row: QueueItemRow, config: FreshnessConfig): string {
  return config.freshnessFrom === 'firstSeen' ? row.enqueuedAt : row.itemDate;
}

export function isRowFresh(row: QueueItemRow, config: FreshnessConfig, now?: Date): boolean {
  return isStillFresh(freshnessDate(row, config), config.maxItemAgeMinutes, now);
}

export function isStillFresh(
  itemDate: string,
  maxItemAgeMinutes: number,
  now: Date = new Date(),
): boolean {
  const ageMs = now.getTime() - new Date(itemDate).getTime();
  return ageMs <= maxItemAgeMinutes * 60 * 1000;
}

export function selectEligibleItems(
  rows: QueueItemRow[],
  config: FreshnessConfig,
  now: Date = new Date(),
): {toPublish: QueueItemRow[]; toSkip: QueueItemRow[]} {
  const fresh = rows.filter(r => isRowFresh(r, config, now));
  const stale = rows.filter(r => !isRowFresh(r, config, now));

  // Ordering stays by the feed's own date: within one poll, firstSeen times are all equal.
  const newestFirst = [...fresh].sort(
    (a, b) => new Date(b.itemDate).getTime() - new Date(a.itemDate).getTime(),
  );
  const kept = newestFirst.slice(0, config.maxCatchupItems);
  const overflowed = newestFirst.slice(config.maxCatchupItems);

  const toPublish = [...kept].sort(
    (a, b) => new Date(a.itemDate).getTime() - new Date(b.itemDate).getTime(),
  );

  return {toPublish, toSkip: [...stale, ...overflowed]};
}
