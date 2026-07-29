import FeedSub from "feedsub";
import jimp from "jimp";
import axios from "axios";
import og from "open-graph-scraper";
import { decode } from "html-entities";
import { BotStore } from "./botStore.ts";
import { computeDedupeKey } from "./dedupeKey.ts";

export interface FeedItem {
  title: string;
  link: { href: string } | string;
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
    ?.replace(/<\/?[^>]+(>|$)/g, " ")
    .replaceAll("&nbsp;", " ")
    .trim()
    .replace(/ +/g, " ");
}

export function decodeHTMLTwice(htmlString: string): string {
  return decode(decode(htmlString));
}

export function fixMalformedUrl(urlString: string): string {
  return urlString.replace(/^https\/\//i, "https://").replace(/^http\/\//i, "http://");
}

export function parseString(
  template: string,
  item: FeedItem,
  truncate: boolean,
  titleClearHTML: boolean,
  descriptionClearHTML: boolean
): string {
  let result = template;

  if (template.includes("$title")) {
    if (!item.title) throw new Error("No title provided from RSS reader.");
    result = result.replace(
      "$title",
      titleClearHTML ? decodeHTMLTwice(removeHTMLTags(item.title)) : item.title
    );
  }

  if (template.includes("$link")) {
    if (!item.link) throw new Error("No link provided from RSS reader.");
    const href = typeof item.link === "object" ? item.link.href : item.link;
    result = result.replace("$link", href);
  }

  if (template.includes("$description")) {
    // Deliberate improvement over app/utils/rssHandler.ts, which leaves
    // `description` undefined here and lets String.replace stringify it to
    // the literal text "undefined" in the post - a real bug in production.
    let description = item.description ?? item.content ?? "";
    if (descriptionClearHTML) description = removeHTMLTags(description);
    result = result.replace("$description", description);
  }

  if (result.length > 300 && truncate) {
    result = result.slice(0, 277) + "...";
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
    private store: BotStore
  ) {
    this.reader = new FeedSub(String(feedUrl), {
      interval: fetchIntervalMinutes,
      emitOnStart: true,
      lastDate: this.store.readCursor() || null,
    });
  }

  onItem(handler: (parsed: ParsedItem) => void): void {
    this.itemHandler = handler;
  }

  start(): void {
    this.reader.read();
    // handleItem is async; the EventEmitter has no way to await or catch a
    // listener's rejection, so an ordinary bad item (missing title/link)
    // would otherwise become an unhandled rejection and crash the whole
    // process - fatal for every other bot sharing this process.
    this.reader.on("item", (item: FeedItem) => {
      this.handleItem(item).catch((err) => {
        console.log(
          `[${new Date().toUTCString()}] - [bsky.rss FEED] [${this.botId}] Error handling item: ${err}`
        );
      });
    });
    this.reader.start();
  }

  async resolveEmbedImage(imageUrl: string): Promise<Buffer | undefined> {
    try {
      const response = await axios.get(imageUrl, {
        headers: { "User-Agent": this.config.ogUserAgent ?? "bsky.rss/1.0 (Open Graph Scraper)" },
        responseType: "arraybuffer",
      });
      return await resizeImageToBuffer(response.data);
    } catch {
      return undefined;
    }
  }

  private async handleItem(item: FeedItem): Promise<void> {
    const useDate: string | undefined = this.config.dateField
      ? item[this.config.dateField]
      : (item.pubdate ?? item.published);
    if (!useDate) {
      console.log(
        `[${new Date().toUTCString()}] - [bsky.rss FEED] [${this.botId}] No date provided by RSS reader for post.`
      );
      return;
    }

    const itemUrl = typeof item.link === "object" ? item.link.href : item.link;
    // Fall back to a guid-like field before giving up, so two distinct link-less items
    // from the same bot don't collide on the same dedupe key / AT-Proto rkey (§3.4 step 5
    // calls for "item link/guid"). FeedItem has no typed guid field (feedsub's shape
    // varies by feed), so this reaches for the common RSS/Atom conventions via the
    // index signature. A feed item with none of link/guid/id is expected to be rare.
    const dedupeKey = computeDedupeKey(this.botId, itemUrl ?? item.guid ?? item.id ?? "");

    const lastCursor = this.store.readCursor();
    let embed: ParsedEmbed | undefined;

    if (this.config.publishEmbed) {
      const url = itemUrl;
      if (!url) throw new Error("No link provided from RSS reader to fetch Open Graph data.");

      // Dedup check runs before any network fetch, matching rssHandler.ts's real
      // ordering today — avoids the expensive OG/image fetch for known duplicates.
      if (this.config.removeDuplicate) {
        if (this.store.seenValueExists(url)) return;
        this.store.writeSeenValue(url);
      } else {
        if (new Date(useDate) <= new Date(lastCursor)) return;
      }

      let imageUrl: string | undefined;
      const imageKey = this.config.imageField;
      if (imageKey && Object.keys(item).includes(imageKey)) {
        const imageField = item[imageKey];
        const hasUrl = imageField && Object.keys(imageField).includes("url");
        const isImageType = !(
          Object.keys(imageField ?? {}).includes("type") && !imageField.type?.startsWith("image")
        );
        if (hasUrl && isImageType) {
          imageUrl = imageField.url;
        }
      }

      let description: string | undefined;
      if (this.config.forceDescriptionEmbed) {
        description = item.description ?? item.content;
        if (description && this.config.descriptionClearHTML) description = removeHTMLTags(description);
      }

      let imageAlt: string | undefined;
      if (this.config.embedType === "image" && this.config.imageAlt) {
        imageAlt = parseString(this.config.imageAlt, item, false, false, false);
      }

      const defaultUserAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
      const openGraphResult: any = await og({
        url,
        timeout: 10000,
        fetchOptions: {
          headers: {
            "user-agent": this.config.ogUserAgent || defaultUserAgent,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
          },
        },
      })
        .then((res: any) => (res.error ? { error: true } : res.result))
        .catch(() => ({ error: true }));

      if (!openGraphResult.error) {
        if (!imageUrl && openGraphResult.ogImage?.[0]?.url) {
          imageUrl = openGraphResult.ogImage[0].url;
        }
        if (!description) {
          description = openGraphResult.ogDescription ?? item.description ?? item.content;
        }
        if (description && this.config.descriptionClearHTML) description = removeHTMLTags(description);

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
        console.log(
          `[${new Date().toUTCString()}] - [bsky.rss FETCH] [${this.botId}] Error fetching Open Graph data for ${item.title} (${url})`
        );
        description = item.description ?? item.content;
        if (description && this.config.descriptionClearHTML) description = removeHTMLTags(description);
        embed = { uri: url, title: item.title, description, imageUrl, imageAlt, type: this.config.embedType };
      }
    }

    if (new Date(useDate) <= new Date(lastCursor)) return;

    const title =
      item.title && this.config.titleClearHTML ? decodeHTMLTwice(removeHTMLTags(item.title)) : item.title;

    const content = parseString(
      this.config.string,
      item,
      this.config.truncate === true,
      this.config.titleClearHTML === true,
      this.config.descriptionClearHTML === true
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
}
