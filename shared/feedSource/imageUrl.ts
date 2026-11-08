// Helpers that turn what a link page offers into a usable card-image URL. Shared by fleet mode
// (fleet/feedReader.ts) and single-bot mode (app/utils/rssHandler.ts) so the two can't drift.

/**
 * Image URLs can be relative ("/static/x.webp"): open-graph-scraper returns og:image verbatim, and
 * feeds sometimes put relative URLs in enclosure/media:content. Resolve against the page they came
 * from; keep only http(s) results. (Not to be confused with imageResolver.ts's resolveImageUrl,
 * which picks which feed field holds the image.)
 */
export function absolutizeImageUrl(
  raw: string | undefined,
  baseUrl: string | undefined,
): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  // Parse an absolute value on its own first: new URL(value, base) throws on an invalid base
  // even when value needs no base at all.
  const resolved = URL.parse(value) ?? (baseUrl ? URL.parse(value, baseUrl) : null);
  return resolved && (resolved.protocol === 'http:' || resolved.protocol === 'https:')
    ? resolved.href
    : undefined;
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
 * the video thumbnail. Any failure means "no image", like every other image path here; onFailure
 * gets the reason so callers can log it.
 */
export async function youtubeThumbnail(
  url: string,
  options: {
    userAgent: string;
    timeoutMs: number;
    fetchFn?: typeof fetch;
    onFailure?: (reason: string) => void;
  },
): Promise<string | undefined> {
  const fetchFn = options.fetchFn ?? fetch;
  const fail = (reason: string) => {
    options.onFailure?.(reason);
    return undefined;
  };
  try {
    const response = await fetchFn(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
      {headers: {'user-agent': options.userAgent}, signal: AbortSignal.timeout(options.timeoutMs)},
    );
    if (!response.ok) {
      // An unread body keeps its connection busy until garbage collection.
      await response.body?.cancel().catch(() => {});
      return fail(`oEmbed returned HTTP ${response.status}`);
    }
    const data: unknown = await response.json();
    const thumbnail =
      typeof data === 'object' && data !== null
        ? (data as {thumbnail_url?: unknown}).thumbnail_url
        : undefined;
    return typeof thumbnail === 'string' && thumbnail.startsWith('https://')
      ? thumbnail
      : fail('oEmbed response has no https thumbnail_url');
  } catch (error) {
    return fail(`oEmbed request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
