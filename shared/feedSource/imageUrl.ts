// Helpers that turn what a link page offers into a usable card-image URL. Shared by fleet mode
// (fleet/feedReader.ts) and single-bot mode (app/utils/rssHandler.ts) so the two can't drift.

/**
 * open-graph-scraper returns og:image verbatim, so it can be relative ("/static/x.webp").
 * Resolve it against the page it came from; keep only http(s) results.
 */
export function resolveImageUrl(raw: string | undefined, pageUrl: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const resolved = new URL(value, pageUrl);
    return resolved.protocol === 'http:' || resolved.protocol === 'https:'
      ? resolved.href
      : undefined;
  } catch {
    return undefined;
  }
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);

/** A YouTube video link: /watch, /shorts/<id>, /live/<id> on youtube.com, or youtu.be/<id>. */
export function isYouTubeUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname === 'youtu.be') return parsed.pathname.length > 1;
  if (!YOUTUBE_HOSTS.has(parsed.hostname)) return false;
  return parsed.pathname === '/watch' || /^\/(shorts|live)\/[^/]+/.test(parsed.pathname);
}

/**
 * YouTube shows scrapers a consent page with no og:image, but its public oEmbed endpoint returns
 * the video thumbnail. Any failure means "no image", like every other image path here.
 */
export async function youtubeThumbnail(
  url: string,
  options: {userAgent: string; timeoutMs: number; fetchFn?: typeof fetch},
): Promise<string | undefined> {
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const response = await fetchFn(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
      {headers: {'user-agent': options.userAgent}, signal: AbortSignal.timeout(options.timeoutMs)},
    );
    if (!response.ok) return undefined;
    const data: unknown = await response.json();
    const thumbnail =
      typeof data === 'object' && data !== null
        ? (data as {thumbnail_url?: unknown}).thumbnail_url
        : undefined;
    return typeof thumbnail === 'string' && thumbnail.startsWith('https://')
      ? thumbnail
      : undefined;
  } catch {
    return undefined;
  }
}
