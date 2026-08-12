import {Jimp, JimpMime} from 'jimp';
import axios from 'axios';
import http from 'node:http';
import https from 'node:https';
import og from 'open-graph-scraper';
import {decode} from 'html-entities';
import {BotStore} from './botStore.ts';
import {computeDedupeKey} from './dedupeKey.ts';
import {SharedLimiters} from './sharedLimiters.ts';
import {BotOperations, classifyFeedFailure} from './botOperations.ts';
import {Logger, formatDebugError} from '../shared/logging/logger.ts';
import {createFeedSource} from '../shared/feedSource/index.ts';
import type {FeedSource, NormalizedItem} from '../shared/feedSource/index.ts';
import {
  extractMarkdownLinks,
  finalizeMarkdownLinks,
  type MarkdownFacet,
} from '../shared/feedSource/markdownLinks.ts';

// HTTP agent pools to limit concurrent connections
const httpAgent = new http.Agent({
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
});

const httpsAgent = new https.Agent({
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
});

export interface FeedReaderConfig {
  string: string;
  publishEmbed?: boolean;
  embedType?: string;
  languages?: string[];
  truncate?: boolean;
  dateField?: string;
  imageField?: string;
  mappedValues?: Array<{key: string; value: string}>;
  imageAlt?: string;
  ogUserAgent?: string;
  descriptionClearHTML?: boolean;
  forceDescriptionEmbed?: boolean;
  removeDuplicate?: boolean;
  titleClearHTML?: boolean;
}

export interface FeedReaderRuntime {
  operations: BotOperations;
  logger: Logger;
  fetchOpenGraph?: (url: string, userAgent: string, timeoutMs: number) => Promise<unknown>;
}

type OpenGraphFetchOutcome = {ok: true; result: unknown} | {ok: false; error: unknown};

export interface ParsedEmbed {
  uri: string;
  title: string;
  description?: string;
  imageUrl?: string;
  imageAlt?: string;
  type?: string;
}

export interface ParsedItem {
  title: string;
  content: string;
  facets: MarkdownFacet[];
  embed?: ParsedEmbed;
  languages: string[] | undefined;
  itemDate: string;
  dedupeKey: string;
}

export function removeHTMLTags(htmlString: string): string {
  return htmlString
    ?.replace(/<\/?[^>]+(>|$)/g, ' ')
    .replaceAll('&nbsp;', ' ')
    .trim()
    .replace(/ +/g, ' ');
}

export function decodeHTMLTwice(htmlString: string): string {
  return decode(decode(htmlString));
}

export function fixMalformedUrl(urlString: string): string {
  return urlString.replace(/^https\/\//i, 'https://').replace(/^http\/\//i, 'http://');
}

export function isPastCursor(useDate: string, lastCursor: string): boolean {
  return new Date(useDate) <= new Date(lastCursor);
}

export function parseString(
  template: string,
  item: NormalizedItem,
  truncate: boolean,
  titleClearHTML: boolean,
  descriptionClearHTML: boolean,
): {text: string; facets: MarkdownFacet[]} {
  function resolveToken(token: string): string | undefined {
    if (token === '$title') {
      if (!item.title) throw new Error('No title provided from RSS reader.');
      return titleClearHTML ? decodeHTMLTwice(removeHTMLTags(item.title)) : item.title;
    }
    if (token === '$link') {
      if (!item.link) throw new Error('No link provided from RSS reader.');
      return item.link;
    }
    if (token === '$description') {
      let description = item.description ?? item.content ?? '';
      if (descriptionClearHTML) description = removeHTMLTags(description);
      return description;
    }
    if (token === '$georss') {
      // '' rather than undefined, matching the bare-substitution path below: an
      // undefined return leaves the literal "$georss" text behind when this token is used
      // as bracket DISPLAY text (resolve(token) ?? token) instead of vanishing like the
      // ungeotagged bare-$georss case does. An empty string still fails the URL-side
      // http(s):// check, so url-side usage ([Map]($georss)) keeps degrading correctly.
      return item.geo
        ? `https://www.openstreetmap.org/?mlat=${item.geo.lat}&mlon=${item.geo.lng}`
        : '';
    }
    const key = token.slice(1);
    return Object.hasOwn(item.mappedValues, key) ? item.mappedValues[key] : undefined;
  }

  const extracted = extractMarkdownLinks(template, resolveToken);
  let result = extracted.text;
  const templateForPresenceChecks = extracted.text;

  // Guards against templateForPresenceChecks (the marker-bearing carrier text from
  // extractMarkdownLinks), not the original raw template - bracket-consumed placeholders
  // were already replaced with opaque markers, so this text can never contain a literal
  // "$key"-shaped substring from resolved feed content sitting inside a bracket span.
  for (const [key, value] of Object.entries(item.mappedValues).sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    const placeholder = `$${key}`;
    if (templateForPresenceChecks.includes(placeholder)) {
      result = result.replace(placeholder, value);
    }
  }

  if (templateForPresenceChecks.includes('$title')) {
    if (!item.title) throw new Error('No title provided from RSS reader.');
    result = result.replace(
      '$title',
      titleClearHTML ? decodeHTMLTwice(removeHTMLTags(item.title)) : item.title,
    );
  }

  if (templateForPresenceChecks.includes('$link')) {
    if (!item.link) throw new Error('No link provided from RSS reader.');
    result = result.replace('$link', item.link);
  }

  if (templateForPresenceChecks.includes('$description')) {
    // Deliberate improvement over app/utils/rssHandler.ts, which leaves
    // `description` undefined here and lets String.replace stringify it to
    // the literal text "undefined" in the post - a real bug in production.
    let description = item.description ?? item.content ?? '';
    if (descriptionClearHTML) description = removeHTMLTags(description);
    result = result.replace('$description', description);
  }

  if (templateForPresenceChecks.includes('$georss')) {
    const coords = item.geo
      ? `https://www.openstreetmap.org/?mlat=${item.geo.lat}&mlon=${item.geo.lng}`
      : '';
    result = result.replace('$georss', coords);
  }

  const finalized = finalizeMarkdownLinks(result, extracted.pending);
  result = finalized.text;
  let facets = finalized.facets;

  if (result.length > 300 && truncate) {
    // Measure the byte length of the KEPT text only, before '...' is appended - measuring
    // after appending it would let a facet whose byteEnd lands in the ellipsis's own 3
    // bytes survive, covering part of "..." as if it were still clickable link text.
    const kept = result.slice(0, 277);
    const keptByteLength = Buffer.byteLength(kept, 'utf8');
    facets = facets.filter(facet => facet.byteEnd <= keptByteLength);
    result = kept + '...';
  }

  return {text: result, facets};
}

export class FeedReader {
  private reader: FeedSource;
  private itemHandler: ((parsed: ParsedItem) => void) | null = null;

  constructor(
    private botId: string,
    // The Bluesky handle this bot config publishes to - deliberately separate from botId.
    // Multiple bot configs (different feeds) can share one identifier, and dedupeKey must
    // be scoped to that shared publishing identity, not to whichever bot config happened
    // to discover an item first - see dedupeKey.ts.
    private identifier: string,
    feedUrl: URL,
    fetchIntervalMinutes: number,
    private config: FeedReaderConfig,
    private store: BotStore,
    // A second BotStore instance, shared by every FeedReader/BotWorker publishing to the
    // same `identifier` (built once per identity in runFleet.ts, not per bot config) - see
    // documentation/specs/2026-08-09-fleet-identity-dedup-design.md. Distinct from `store`,
    // which is this bot config's own private per-bot state.
    private identityStore: BotStore,
    private sharedLimiters: SharedLimiters,
    private runtime: FeedReaderRuntime,
  ) {
    this.reader = createFeedSource(
      feedUrl,
      fetchIntervalMinutes,
      {imageField: config.imageField, mappedValues: config.mappedValues},
      {fetchTimeoutMs: sharedLimiters.httpTimeoutMs},
    );
  }

  onItem(handler: (parsed: ParsedItem) => void): void {
    this.itemHandler = handler;
  }

  start(): void {
    this.reader.start({
      onItems: () => {
        const {recoveredFailures} = this.runtime.operations.recordFeedSuccess();
        if (recoveredFailures > 0) {
          this.runtime.logger.summary(
            'FEED',
            `Feed recovered after ${recoveredFailures} failed poll(s)`,
            this.botId,
          );
        }
      },
      onItem: (item: NormalizedItem) => this.handleItem(item),
      onError: err => {
        // A single item's onItem handler rejecting is not a feed outage - keep it out
        // of classifyFeedFailure/recordFeedFailure so it can't flip feedState to
        // 'failing' for what's really just one malformed item, matching the
        // pre-migration behavior where item-handler failures were a plain summary log
        // and only real feed-fetch/parse errors affected feed health state.
        if (err.scope === 'item') {
          this.runtime.logger.summary('FEED', 'Item handling failed', this.botId);
          this.runtime.logger.debug('FEED', formatDebugError(err.cause ?? err), this.botId);
          return;
        }
        const category = classifyFeedFailure(err.cause ?? err);
        const {becameFailing} = this.runtime.operations.recordFeedFailure(category);
        if (becameFailing) {
          this.runtime.logger.summary('FEED', `Feed unavailable (${category})`, this.botId);
        }
        this.runtime.logger.debug('FEED', formatDebugError(err.cause ?? err), this.botId);
      },
    });
  }

  stop(): void {
    this.reader.stop();
  }

  async resolveEmbedImage(imageUrl: string): Promise<Buffer | undefined> {
    const startedAt = Date.now();
    try {
      return await this.sharedLimiters.withImageLimit(
        async () => {
          const response = await axios.get(imageUrl, {
            headers: {
              'User-Agent': this.config.ogUserAgent ?? 'bsky.rss/1.0 (Open Graph Scraper)',
            },
            responseType: 'arraybuffer',
            maxContentLength: this.sharedLimiters.maxImageDownloadBytes,
            timeout: this.sharedLimiters.httpTimeoutMs,
            httpAgent,
            httpsAgent,
          });

          // Validate buffer size before processing to prevent OOM
          const buffer = Buffer.from(response.data);
          const MAX_RAW_BUFFER_SIZE = 5_000_000; // 5MB raw limit
          if (buffer.length > MAX_RAW_BUFFER_SIZE) {
            this.runtime.logger.debug(
              'FETCH',
              `Image buffer too large: ${buffer.length} bytes, skipping`,
              this.botId,
            );
            return undefined;
          }

          // Check estimated decompressed size to prevent OOM
          const image = await Jimp.read(buffer);
          const estimatedSize = image.bitmap.width * image.bitmap.height * 4; // RGBA
          const MAX_DECOMPRESSED_SIZE = 100_000_000; // 100MB decompressed limit
          if (estimatedSize > MAX_DECOMPRESSED_SIZE) {
            this.runtime.logger.debug(
              'FETCH',
              `Image too large when decompressed: ${estimatedSize} bytes (${image.bitmap.width}x${image.bitmap.height}), skipping`,
              this.botId,
            );
            return undefined;
          }

          // Resize if valid
          return image.resize({w: 800}).getBuffer(JimpMime.jpeg, {quality: 80});
        },
        {logger: this.runtime.logger, botId: this.botId},
      );
    } catch (error) {
      this.runtime.logger.debug(
        'FETCH',
        `Image download failed\n${formatDebugError(error)}`,
        this.botId,
      );
      return undefined;
    } finally {
      this.runtime.logger.debug(
        'TIMING',
        `Image download completed in ${Math.max(0, Date.now() - startedAt)}ms`,
        this.botId,
      );
    }
  }

  private async handleItem(item: NormalizedItem): Promise<void> {
    const itemUrl = item.link;
    // dateField historically pointed at an arbitrary raw feedme tag name (feedme kept
    // every tag from the source feed as a flat property). NormalizedItem no longer
    // carries arbitrary per-feed fields - only its own fixed shape - so dateField now
    // only resolves against NormalizedItem's own field names. All 59 live bot configs
    // leave dateField empty today, so this has no real-world effect; kept for config
    // compatibility per the migration spec's Non-goals, not redesigned.
    const useDate: string | undefined = this.config.dateField
      ? (item as unknown as Record<string, string | undefined>)[this.config.dateField]
      : item.date;
    if (!useDate) {
      this.runtime.logger.verbose(
        'FEED',
        `Skipping item without a date: ${item.title ?? '(untitled)'} (${itemUrl ?? 'no URL'})`,
        this.botId,
      );
      return;
    }

    // Link first, then NormalizedItem.id (which is guid-first) - this is the
    // pre-migration precedence. dedupe_key is a persisted UNIQUE column in queue_items
    // and the AT-Proto record key, so flipping to guid-first would recompute a new key
    // for every already-queued item on any feed where guid !== link (e.g. WordPress's
    // <guid isPermaLink="false">), letting it enqueue and post a second time at cutover.
    const dedupeKey = computeDedupeKey(this.identifier, item.link || item.id);

    // Identity-scoped duplicate check - runs unconditionally (regardless of this bot's
    // own publishEmbed/removeDuplicate settings), before any OG/image work, so two bot
    // configs sharing one Bluesky identity (different feeds, same account) never both
    // post the same story. See documentation/specs/2026-08-09-fleet-identity-dedup-
    // design.md. The existing per-bot removeDuplicate/staleness logic below is
    // unchanged - this is a second, earlier gate in front of it.
    //
    // This is the FIRST check to see a repeat item now, for every bot - not just bots
    // sharing an identity. For a bot with no shared identity, this fires just as often
    // as the old per-bot check used to (same item reappearing on a normal re-poll), not
    // a new/extra event - it's simply relabeled since this check now wins the race to
    // catch it. The log message stays identity-neutral (doesn't say "cross-bot") since
    // this check has no way to know whether a second bot was actually involved.
    if (this.identityStore.seenValueExists(dedupeKey)) {
      this.runtime.logger.verbose(
        'FEED',
        `Skipping duplicate item (already published to this identity): ${item.title ?? '(untitled)'} (${itemUrl ?? item.id})`,
        this.botId,
      );
      return;
    }
    this.identityStore.writeSeenValue(dedupeKey);

    const lastCursor = this.store.readCursor();
    let embed: ParsedEmbed | undefined;

    if (this.config.publishEmbed) {
      const url = itemUrl;
      if (!url) throw new Error('No link provided from RSS reader to fetch Open Graph data.');

      // Dedup check runs before any network fetch, matching rssHandler.ts's real
      // ordering today — avoids the expensive OG/image fetch for known duplicates.
      if (this.config.removeDuplicate) {
        if (this.store.seenValueExists(url)) {
          this.runtime.logger.verbose(
            'FEED',
            `Skipping duplicate item: ${item.title} (${url})`,
            this.botId,
          );
          return;
        }
        this.store.writeSeenValue(url);
      } else {
        if (isPastCursor(useDate, lastCursor)) {
          this.runtime.logger.verbose(
            'FEED',
            `Skipping stale item: ${item.title} (${url})`,
            this.botId,
          );
          return;
        }
      }

      let imageUrl: string | undefined = item.imageUrl;

      let description: string | undefined;
      if (this.config.forceDescriptionEmbed) {
        description = item.description ?? item.content;
        if (description && this.config.descriptionClearHTML)
          description = removeHTMLTags(description);
      }

      let imageAlt: string | undefined;
      if (this.config.embedType === 'image' && this.config.imageAlt) {
        imageAlt = parseString(this.config.imageAlt, item, false, false, false).text;
      }

      const defaultUserAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      const openGraphFetch = await this.fetchOpenGraph(
        url,
        this.config.ogUserAgent || defaultUserAgent,
      );

      if (openGraphFetch.ok) {
        const openGraphResult = openGraphFetch.result as {
          ogImage?: {url: string}[];
          ogDescription?: string;
          ogUrl?: string;
          ogTitle?: string;
        };
        this.runtime.operations.recordOpenGraphSuccess();
        if (!imageUrl && openGraphResult.ogImage?.[0]?.url) {
          imageUrl = openGraphResult.ogImage[0].url;
        }
        if (!description) {
          description = openGraphResult.ogDescription ?? item.description ?? item.content;
        }
        if (description && this.config.descriptionClearHTML)
          description = removeHTMLTags(description);

        let uri = openGraphResult.ogUrl ? fixMalformedUrl(openGraphResult.ogUrl) : url;
        if (openGraphResult.ogUrl) {
          const validUrl =
            /^(h|H)(t|T)(t|T)(p|P)(s|S)?:\/\/[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/;
          if (!validUrl.test(uri)) uri = url;
        }

        if (uri && (openGraphResult.ogTitle || item.title)) {
          embed = {
            uri,
            title: openGraphResult.ogTitle ?? item.title ?? '',
            description,
            imageUrl,
            imageAlt,
            type: this.config.embedType,
          };
        }
      } else {
        this.runtime.operations.recordOpenGraphFallback();
        this.runtime.logger.verbose(
          'FETCH',
          `Open Graph fallback for ${item.title} (${url})`,
          this.botId,
        );
        this.runtime.logger.debug('FETCH', formatDebugError(openGraphFetch.error), this.botId);
        description = item.description ?? item.content;
        if (description && this.config.descriptionClearHTML)
          description = removeHTMLTags(description);
        embed = {
          uri: url,
          title: item.title ?? '',
          description,
          imageUrl,
          imageAlt,
          type: this.config.embedType,
        };
      }
    }

    if (isPastCursor(useDate, lastCursor)) {
      this.runtime.logger.verbose(
        'FEED',
        `Skipping stale item: ${item.title} (${itemUrl ?? 'no URL'})`,
        this.botId,
      );
      return;
    }

    const title =
      item.title && this.config.titleClearHTML
        ? decodeHTMLTwice(removeHTMLTags(item.title))
        : item.title;

    const parsed = parseString(
      this.config.string,
      item,
      this.config.truncate === true,
      this.config.titleClearHTML === true,
      this.config.descriptionClearHTML === true,
    );

    this.itemHandler?.({
      title,
      content: parsed.text,
      facets: parsed.facets,
      embed: this.config.publishEmbed ? embed : undefined,
      languages: this.config.languages,
      itemDate: useDate,
      dedupeKey,
    } as ParsedItem);
  }

  private async fetchOpenGraph(url: string, userAgent: string): Promise<OpenGraphFetchOutcome> {
    const startedAt = Date.now();
    try {
      const result = await this.sharedLimiters.withOgLimit(
        async () => {
          if (this.runtime.fetchOpenGraph) {
            return this.runtime.fetchOpenGraph(url, userAgent, this.sharedLimiters.httpTimeoutMs);
          }
          const response = await og({
            url,
            timeout: this.sharedLimiters.httpTimeoutMs / 1000,
            fetchOptions: {
              headers: {
                'user-agent': userAgent,
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'accept-language': 'en-US,en;q=0.9',
              },
            },
          });
          return response.error ? {error: response.error} : response.result;
        },
        {logger: this.runtime.logger, botId: this.botId},
      );
      if (result && typeof result === 'object' && 'error' in result && result.error) {
        return {ok: false, error: result.error};
      }
      return {ok: true, result};
    } catch (error) {
      return {ok: false, error};
    } finally {
      this.runtime.logger.debug(
        'TIMING',
        `Open Graph fetch completed in ${Math.max(0, Date.now() - startedAt)}ms`,
        this.botId,
      );
    }
  }
}
