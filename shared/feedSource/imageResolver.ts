export interface ImageResolvableItem {
  enclosures?: Array<{url?: string}>;
  media?: {
    contents?: Array<{url?: string}>;
    groups?: Array<{contents?: Array<{url?: string}>}>;
  };
}

// imageField is not a closed enum - some bots' feeds pass through FreshRSS's "User
// Query" folder-merge feature (which always emits media:content regardless of the
// original source), others point at a single source feed where the value was set by
// hand after inspecting that feed's own image convention. An unrecognized value falls
// back to undefined (caller falls back to Open Graph) rather than erroring, so a bot
// with a not-yet-mapped value degrades gracefully instead of breaking. Adding a new
// recognized value is a new `if` branch here, isolated from every other value.
export function resolveImageUrl(
  item: ImageResolvableItem,
  imageField: string | undefined,
): string | undefined {
  if (!imageField) return undefined;
  if (imageField === 'enclosure') return item.enclosures?.[0]?.url;
  if (imageField === 'media:content') {
    return item.media?.contents?.[0]?.url ?? item.media?.groups?.[0]?.contents?.[0]?.url;
  }
  return undefined;
}
