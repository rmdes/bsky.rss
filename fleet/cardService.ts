// Bluesky's card service (cardyb): what the Bluesky app asks for a link card when a link is pasted.
// Used only as a last resort, when the bot's own page fetch fails or finds no image: some publishers
// (lecho.be, demorgen.be) refuse the bot but serve Bluesky's card fetcher.
const CARD_SERVICE = 'https://cardyb.bsky.app/v1/extract?url=';
const USER_AGENT = 'bsky.rss (+https://github.com/rmdes/bsky.rss)';

export interface ServiceCard {
  title?: string;
  description?: string;
  image?: string; // a cardyb image-proxy URL; always https
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// The service's own `url` field is deliberately ignored: it garbles some links.
export async function fetchServiceCard(
  url: string,
  options: {timeoutMs: number; fetchFn?: typeof fetch},
): Promise<ServiceCard | undefined> {
  const response = await (options.fetchFn ?? fetch)(CARD_SERVICE + encodeURIComponent(url), {
    headers: {'user-agent': USER_AGENT},
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!response.ok) return undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (!body || typeof body !== 'object') return undefined;
  const fields = body as Record<string, unknown>;
  if (fields.error) return undefined;
  const image = text(fields.image);
  const card: ServiceCard = {
    title: text(fields.title),
    description: text(fields.description),
    image: image && image.startsWith('https://') ? image : undefined,
  };
  return card.title || card.description || card.image ? card : undefined;
}
