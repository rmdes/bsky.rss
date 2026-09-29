import {createHash} from 'node:crypto';
import type {BotSpec} from './configLoader.ts';
import type {ParsedEmbed} from './feedReader.ts';
import {BotStore} from './botStore.ts';

/**
 * Deterministic per-message dedupe key: same message+link always hashes to the same key, so
 * re-running the script with unchanged text is a safe no-op per bot (BotStore.enqueue's
 * existing UNIQUE(dedupe_key) constraint already makes this idempotent) — editing the text
 * produces a genuinely new item. Prefixed to namespace it away from RSS-derived dedupe keys
 * (which are URL/date-derived, not hash-derived).
 */
export function broadcastDedupeKey(message: string, link: string): string {
  const hash = createHash('sha256').update(`${message}\n${link}`).digest('hex');
  return `broadcast:${hash}`;
}

/** Every loaded bot's spec, minus any explicitly excluded botId. */
export function targetBots(
  allBots: readonly BotSpec[],
  excludeBotIds: readonly string[],
): BotSpec[] {
  const excluded = new Set(excludeBotIds);
  return allBots.filter(bot => !excluded.has(bot.botId));
}

/**
 * Minimal shape of open-graph-scraper's real OgObject result (verified against
 * node_modules/open-graph-scraper/types/lib/types.d.ts) — only the fields this module reads.
 */
export interface OpenGraphResult {
  ogImage?: {url: string}[];
  ogDescription?: string;
  ogUrl?: string;
  ogTitle?: string;
}

/**
 * Builds the embed for the broadcast, or undefined if there's nothing usable — matching
 * fleet/feedReader.ts's own real-world condition (an embed needs a title to be worth showing).
 * undefined here means the message still posts fine as plain text, with the link auto-detected
 * into a clickable facet by RichText.detectFacets() at post time (existing BskyClient.post()
 * behavior, unchanged) — a failed/missing Open Graph scrape never blocks the broadcast.
 */
export function buildBroadcastEmbed(
  ogResult: OpenGraphResult | undefined,
  link: string,
): ParsedEmbed | undefined {
  if (!ogResult?.ogTitle) return undefined;
  return {
    uri: ogResult.ogUrl ?? link,
    title: ogResult.ogTitle,
    description: ogResult.ogDescription,
    imageUrl: ogResult.ogImage?.[0]?.url,
    imageAlt: undefined,
  };
}

export type EnqueueBroadcastOutcome = 'enqueued' | 'duplicate';

/**
 * Writes one broadcast row into a single bot's existing queue_items table — the exact same
 * BotStore.enqueue() method and table regular RSS items use. That bot's already-running
 * BotWorker drains it on its own next tick and posts it through its own already-tuned
 * Scheduler pacing; this function has no timing/throttling logic of its own.
 */
export function enqueueBroadcast(
  store: BotStore,
  params: {title: string; message: string; embed: ParsedEmbed | undefined; dedupeKey: string},
): EnqueueBroadcastOutcome {
  const id = store.enqueue({
    title: params.title,
    content: params.message,
    embedJson: params.embed ? JSON.stringify(params.embed) : null,
    languagesJson: null,
    facetsJson: null,
    itemDate: new Date().toISOString(),
    dedupeKey: params.dedupeKey,
  });
  return id === 0 ? 'duplicate' : 'enqueued';
}
