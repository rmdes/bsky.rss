interface ImageCandidate {
  url?: string;
  type?: string;
}

export interface ImageResolvableItem {
  enclosures?: ImageCandidate[];
  media?: {
    contents?: ImageCandidate[];
    groups?: Array<{contents?: ImageCandidate[]}>;
  };
}

// A feed's enclosure/media:content can carry non-image payloads (podcast
// <enclosure type="audio/mpeg">, <media:content type="video/mp4">). The pre-migration
// code only accepted a resolved URL when the field had no type or an image/* type;
// without this a podcast enclosure would be handed to the image downloader as a
// post image.
function isImage(candidate: ImageCandidate): boolean {
  return Boolean(candidate.url) && (!candidate.type || candidate.type.startsWith('image'));
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
  if (imageField === 'enclosure') return item.enclosures?.find(isImage)?.url;
  if (imageField === 'media:content') {
    return (
      item.media?.contents?.find(isImage)?.url ??
      item.media?.groups?.flatMap(group => group.contents ?? []).find(isImage)?.url
    );
  }
  return undefined;
}
