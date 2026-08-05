import FeedSub from 'feedsub';
import jimp from 'jimp';
import axios from 'axios';
import og from 'open-graph-scraper';
import {decode} from 'html-entities';
import {BotStore} from './botStore.ts';
import {computeDedupeKey} from './dedupeKey.ts';
import {SharedLimiters} from './sharedLimiters.ts';
import {BotOperations, classifyFeedFailure} from './botOperations.ts';
import {FleetLogger, formatDebugError} from './logging.ts';

export interface FeedItem {
  title: string;
  link: {href: string} | string;
  description?: string;
  content?: string;
  published?: string;
  pubdate?: string;
  [key: string]: any;
}

export interface FeedReaderConfig {
  string: string;
  publishEmbed?: boolean;
  embedType?: string;
  languages?: string[];
  truncate?: boolean;
  dateField?: string;
  imageField?: string;
  imageAlt?: string;
  ogUserAgent?: string;
  descriptionClearHTML?: boolean;
  forceDescriptionEmbed?: boolean;
  removeDuplicate?: boolean;
  titleClearHTML?: boolean;
}

export interface FeedReaderRuntime {
  operations: BotOperations;
  logger: FleetLogger;
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

// feedme (feedsub's underlying parser) returns a tag as a plain string only when it has
// no attributes. A tag with attributes - e.g. RSS 2.0's <guid isPermaLink="false"> -
// comes back as an object like { ispermalink: "false", text: "urn:uuid:..." }. Pulls the
// actual text out of either shape; also treats an empty string as absent so a blank
// tag (e.g. <link/>) falls through to the next candidate rather than "winning".
export function textOf(v: unknown): string | undefined {
  const text = v && typeof v === 'object' ? (v as any).text : v;
  return text || undefined;
}

export function parseString(
  template: string,
  item: FeedItem,
  truncate: boolean,
  titleClearHTML: boolean,
  descriptionClearHTML: boolean,
): string {
  let result = template;

  if (template.includes('$title')) {
    if (!item.title) throw new Error('No title provided from RSS reader.');
    result = result.replace(
      '$title',
      titleClearHTML ? decodeHTMLTwice(removeHTMLTags(item.title)) : item.title,
    );
  }

  if (template.includes('$link')) {
    if (!item.link) throw new Error('No link provided from RSS reader.');
    const href = typeof item.link === 'object' ? item.link.href : item.link;
    result = result.replace('$link', href);
  }

  if (template.includes('$description')) {
    // Deliberate improvement over app/utils/rssHandler.ts, which leaves
    // `description` undefined here and lets String.replace stringify it to
    // the literal text "undefined" in the post - a real bug in production.
    let description = item.description ?? item.content ?? '';
    if (descriptionClearHTML) description = removeHTMLTags(description);
    result = result.replace('$description', description);
  }

  if (result.length > 300 && truncate) {
    result = result.slice(0, 277) + '...';
  }

  return result;
}

async function resizeImageToBuffer(bufferData: Buffer): Promise<Buffer> {
  const image = await jimp.read(bufferData);
  return image.resize(800, jimp.AUTO).quality(80).getBufferAsync(jimp.MIME_JPEG);
}

export class FeedReader {
  private reader: any;
  private itemHandler: ((parsed: ParsedItem) => void) | null = null;

  constructor(
    private botId: string,
    feedUrl: URL,
    fetchIntervalMinutes: number,
    private config: FeedReaderConfig,
    private store: BotStore,
    private sharedLimiters: SharedLimiters,
    private runtime: FeedReaderRuntime,
  ) {
    this.reader = new FeedSub(String(feedUrl), {
      interval: fetchIntervalMinutes,
      emitOnStart: true,
      lastDate: this.store.readCursor() || null,
      requestOpts: {timeout: sharedLimiters.httpTimeoutMs},
    });
  }

  onItem(handler: (parsed: ParsedItem) => void): void {
    this.itemHandler = handler;
  }

  start(): void {
    // feedsub's FeedSub is a Node EventEmitter; an 'error' event with no
    // listener throws as an uncaught exception by default (a classic
    // EventEmitter gotcha), previously only caught by the process-wide
    // safety net rather than handled per-bot here - a feed-fetch failure
    // (a broken TLS cert chain, DNS failure, timeout, etc.) must not be
    // allowed to fall through to that global handler as the primary defense.
    this.reader.on('items', () => {
      const {recoveredFailures} = this.runtime.operations.recordFeedSuccess();
      if (recoveredFailures > 0) {
        this.runtime.logger.summary(
          'FEED',
          `Feed recovered after ${recoveredFailures} failed poll(s)`,
          this.botId,
        );
      }
    });
    this.reader.on('error', (err: unknown) => {
      const category = classifyFeedFailure(err);
      const {becameFailing} = this.runtime.operations.recordFeedFailure(category);
      if (becameFailing) {
        this.runtime.logger.summary('FEED', `Feed unavailable (${category})`, this.botId);
      }
      this.runtime.logger.debug('FEED', formatDebugError(err), this.botId);
    });
    this.reader.read();
    // handleItem is async; the EventEmitter has no way to await or catch a
    // listener's rejection, so an ordinary bad item (missing title/link)
    // would otherwise become an unhandled rejection and crash the whole
    // process - fatal for every other bot sharing this process.
    this.reader.on('item', (item: FeedItem) => {
      this.handleItem(item).catch(err => {
        this.runtime.logger.summary('FEED', 'Item handling failed', this.botId);
        this.runtime.logger.debug('FEED', formatDebugError(err), this.botId);
      });
    });
    this.reader.start();
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
          });
          return resizeImageToBuffer(response.data);
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

  private async handleItem(item: FeedItem): Promise<void> {
    const itemUrl = typeof item.link === 'object' ? item.link.href : item.link;
    const useDate: string | undefined = this.config.dateField
      ? item[this.config.dateField]
      : (item.pubdate ?? item.published);
    if (!useDate) {
      this.runtime.logger.verbose(
        'FEED',
        `Skipping item without a date: ${item.title ?? '(untitled)'} (${itemUrl ?? 'no URL'})`,
        this.botId,
      );
      return;
    }

    // Fall back to a guid-like field before giving up, so two distinct link-less items
    // from the same bot don't collide on the same dedupe key / AT-Proto rkey (§3.4 step 5
    // calls for "item link/guid"). FeedItem has no typed guid field (feedsub's shape
    // varies by feed), so this reaches for the common RSS/Atom conventions via the
    // index signature. The real risk isn't a feed item missing all of link/guid/id
    // (rare) — it's standard RSS 2.0 `<guid isPermaLink="...">`: feedme (feedsub's
    // parser) returns any tag with attributes as an object like
    // { ispermalink: "false", text: "urn:uuid:..." }, not a plain string. Two different
    // guids both being truthy objects would otherwise both stringify to the identical
    // "[object Object]" and collide, so the actual text has to be pulled out explicitly.
    const dedupeKey = computeDedupeKey(
      this.botId,
      textOf(itemUrl) || textOf(item.guid) || textOf(item.id) || '',
    );

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
        if (new Date(useDate) <= new Date(lastCursor)) {
          this.runtime.logger.verbose(
            'FEED',
            `Skipping stale item: ${item.title} (${url})`,
            this.botId,
          );
          return;
        }
      }

      let imageUrl: string | undefined;
      const imageKey = this.config.imageField;
      if (imageKey && Object.keys(item).includes(imageKey)) {
        const imageField = item[imageKey];
        const hasUrl = imageField && Object.keys(imageField).includes('url');
        const isImageType = !(
          Object.keys(imageField ?? {}).includes('type') && !imageField.type?.startsWith('image')
        );
        if (hasUrl && isImageType) {
          imageUrl = imageField.url;
        }
      }

      let description: string | undefined;
      if (this.config.forceDescriptionEmbed) {
        description = item.description ?? item.content;
        if (description && this.config.descriptionClearHTML)
          description = removeHTMLTags(description);
      }

      let imageAlt: string | undefined;
      if (this.config.embedType === 'image' && this.config.imageAlt) {
        imageAlt = parseString(this.config.imageAlt, item, false, false, false);
      }

      const defaultUserAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      const openGraphFetch = await this.fetchOpenGraph(
        url,
        this.config.ogUserAgent || defaultUserAgent,
      );

      if (openGraphFetch.ok) {
        const openGraphResult: any = openGraphFetch.result;
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
            title: openGraphResult.ogTitle ?? item.title,
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
          title: item.title,
          description,
          imageUrl,
          imageAlt,
          type: this.config.embedType,
        };
      }
    }

    if (new Date(useDate) <= new Date(lastCursor)) {
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

    const content = parseString(
      this.config.string,
      item,
      this.config.truncate === true,
      this.config.titleClearHTML === true,
      this.config.descriptionClearHTML === true,
    );

    this.itemHandler?.({
      title,
      content,
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
          const response: any = await og({
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
      if (result && typeof result === 'object' && 'error' in result && (result as any).error) {
        return {ok: false, error: (result as any).error};
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
