// mappedValues is a closed list of recognized `value` strings by design (see
// documentation/specs/2026-08-07-mapped-values-support-design.md) - a single if-chain,
// matching imageResolver.ts's resolveImageUrl exactly, not a generic path walker into
// feedsmith's internals. An unrecognized value resolves to empty string, never an error,
// the same "unrecognized degrades gracefully" convention imageField already uses.
interface MappedValuesSource {
  dc?: {
    creators?: string[];
    dates?: string[];
    subjects?: string[];
    publishers?: string[];
  };
  itunes?: {
    duration?: number;
    episode?: number;
    season?: number;
    explicit?: boolean;
    author?: string;
  };
}

function resolveMappedValue(item: MappedValuesSource, value: string): string {
  if (value === 'dc:creator') return item.dc?.creators?.join(', ') ?? '';
  if (value === 'dc:date') return item.dc?.dates?.[0] ?? '';
  if (value === 'dc:subject') return item.dc?.subjects?.join(', ') ?? '';
  if (value === 'dc:publisher') return item.dc?.publishers?.join(', ') ?? '';
  if (value === 'itunes:duration') {
    return typeof item.itunes?.duration === 'number' ? String(item.itunes.duration) : '';
  }
  if (value === 'itunes:episode') {
    return typeof item.itunes?.episode === 'number' ? String(item.itunes.episode) : '';
  }
  if (value === 'itunes:season') {
    return typeof item.itunes?.season === 'number' ? String(item.itunes.season) : '';
  }
  if (value === 'itunes:explicit') {
    return typeof item.itunes?.explicit === 'boolean' ? String(item.itunes.explicit) : '';
  }
  if (value === 'itunes:author') return item.itunes?.author ?? '';
  return '';
}

export function resolveMappedValues(
  item: MappedValuesSource,
  mappedValues: Array<{key: string; value: string}> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of mappedValues ?? []) {
    result[entry.key] = resolveMappedValue(item, entry.value);
  }
  return result;
}
