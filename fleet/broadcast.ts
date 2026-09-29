import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {createInterface} from 'node:readline/promises';
import {RichText} from '@atproto/api';
import og from 'open-graph-scraper';
import type {BotSpec} from './configLoader.ts';
import {loadFleet} from './configLoader.ts';
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

/**
 * The actual text to post: the message plus the link, always - never relying on the embed
 * card alone to carry the link, since the embed can be (and often is) absent when the Open
 * Graph scrape fails or the page has no title. RichText.detectFacets() auto-links the URL
 * from this text at post time (existing BskyClient.post() behavior, unchanged).
 */
export function buildBroadcastContent(message: string, link: string): string {
  return `${message}\n\n${link}`;
}

/**
 * Whether content fits Bluesky's 300-grapheme post limit (the same constraint
 * fleet/feedReader.ts's own 300-char truncation exists for) - checked here so an over-length
 * broadcast is caught before confirmation/writes, not discovered as 60 silent per-bot
 * "skipped" outcomes after the fact.
 */
export function isWithinPostLimit(content: string): boolean {
  return new RichText({text: content}).graphemeLength <= 300;
}

/**
 * Whether a bot's dbPath already exists on disk. Refusing to enqueue when it doesn't prevents
 * BotStore's constructor from silently creating a fresh, empty database at a wrong path (e.g. a
 * FLEET_DATA_ROOT that doesn't match the real deployment's) instead of writing into the real,
 * already-running fleet's database - observed live: a mismatched FLEET_DATA_ROOT one segment
 * off from the real deployment's path created 60 orphaned databases nothing ever drained,
 * while the script reported "Enqueued: 60" as if it had worked. A bot that's part of an
 * actively-running fleet always has this file already, since its own BotWorker created it on
 * first activation - only a misconfigured path hits this.
 */
export function hasExistingDatabase(dbPath: string): boolean {
  return existsSync(dbPath);
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

// Operator edits these three before running `yarn fleet:broadcast`. MESSAGE and LINK are
// hashed together into this run's dedupeKey (see broadcastDedupeKey) - editing either one
// after a previous run means every bot treats it as a new broadcast, not a duplicate.
const MESSAGE = 'Edit this message before running.';
const LINK = 'https://example.com/announcement';
const EXCLUDE_BOT_IDS: string[] = [];

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function scrapeOpenGraph(link: string): Promise<OpenGraphResult | undefined> {
  try {
    const response = await og({
      url: link,
      timeout: 10,
      fetchOptions: {headers: {'user-agent': DEFAULT_USER_AGENT}},
    });
    return response.error ? undefined : (response.result as OpenGraphResult);
  } catch {
    // og() can throw directly (e.g. a malformed URL) in addition to returning error:true -
    // either way, no embed; the broadcast still posts as plain text with an auto-detected link.
    return undefined;
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const skipConfirm = process.argv.includes('--yes');

  const configRoot = process.env.FLEET_CONFIG_ROOT ?? './config.example';
  const secretsFilePath =
    process.env.FLEET_SECRETS_PATH ?? './config.example/secrets/bsky-fleet.json';
  const dataRoot = process.env.FLEET_DATA_ROOT ?? './data/fleet';

  const {bots, errors} = loadFleet(configRoot, secretsFilePath, dataRoot);
  if (errors.length > 0) {
    console.log(`Warning: ${errors.length} bot config(s) failed to load and will be skipped.`);
  }

  const targets = targetBots(bots, EXCLUDE_BOT_IDS);
  if (targets.length === 0) {
    console.log('No target bots (empty fleet, or all excluded). Nothing to do.');
    return;
  }

  const dedupeKey = broadcastDedupeKey(MESSAGE, LINK);
  const title = `Broadcast: ${MESSAGE.slice(0, 40)}`;
  const content = buildBroadcastContent(MESSAGE, LINK);
  if (!isWithinPostLimit(content)) {
    console.error(
      `Message + link is over Bluesky's 300-grapheme limit (${new RichText({text: content}).graphemeLength} graphemes) - shorten MESSAGE before running.`,
    );
    process.exitCode = 1;
    return;
  }

  // Checked before the Open Graph scrape - an over-length message shouldn't cost a real
  // network request before the script tells the operator to fix it.
  const ogResult = await scrapeOpenGraph(LINK);
  const embed = buildBroadcastEmbed(ogResult, LINK);

  console.log(`Message: ${MESSAGE}`);
  console.log(`Link: ${LINK}`);
  console.log(
    embed
      ? `Embed: "${embed.title}"${embed.imageUrl ? ' (with image)' : ' (no image)'} -> ${embed.uri}`
      : 'No embed (Open Graph scrape failed or produced no title) - link is still included in the message text.',
  );
  console.log(`Targets (${targets.length}): ${targets.map(b => b.botId).join(', ')}`);

  if (dryRun) {
    console.log('\n--dry-run: stopping before any writes.');
    return;
  }

  if (!skipConfirm) {
    const rl = createInterface({input: process.stdin, output: process.stdout});
    const answer = await rl.question('\nType BROADCAST to continue: ');
    rl.close();
    if (answer.trim() !== 'BROADCAST') {
      console.log('Aborted - no changes made.');
      return;
    }
  }

  const enqueued: string[] = [];
  const duplicate: string[] = [];
  const failed: string[] = [];
  for (const bot of targets) {
    let store: BotStore | undefined;
    try {
      if (!hasExistingDatabase(bot.dbPath)) {
        failed.push(bot.botId);
        console.error(
          `${bot.botId}: ${bot.dbPath} does not exist - refusing to create a fresh database. ` +
            'Check FLEET_DATA_ROOT matches the real deployment (the same value its running ' +
            "compose file's FLEET_DATA_ROOT resolves to on the host, not just the container).",
        );
        continue;
      }
      store = new BotStore(bot.dbPath);
      const outcome = enqueueBroadcast(store, {title, message: content, embed, dedupeKey});
      (outcome === 'enqueued' ? enqueued : duplicate).push(bot.botId);
    } catch (error) {
      failed.push(bot.botId);
      console.error(`${bot.botId}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      store?.close();
    }
  }

  console.log(
    `\nEnqueued: ${enqueued.length}${enqueued.length ? ` (${enqueued.join(', ')})` : ''}`,
  );
  console.log(
    `\nAlready present (queued, published, or skipped previously): ${duplicate.length}${duplicate.length ? ` (${duplicate.join(', ')})` : ''}`,
  );
  console.log(`Failed: ${failed.length}${failed.length ? ` (${failed.join(', ')})` : ''}`);
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
