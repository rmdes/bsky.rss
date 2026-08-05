import type {QueueItemRow} from './botStore.ts';

export interface FreshnessConfig {
  maxCatchupItems: number;
  maxItemAgeMinutes: number;
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
  const fresh = rows.filter(r => isStillFresh(r.itemDate, config.maxItemAgeMinutes, now));
  const stale = rows.filter(r => !isStillFresh(r.itemDate, config.maxItemAgeMinutes, now));

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
