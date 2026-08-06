import jimp from 'jimp';
import axios from 'axios';
import queue from './queueHandler';
import db from './dbHandler';
import og from 'open-graph-scraper';
import {decode} from 'html-entities';
import {createFeedSource} from '../../shared/feedSource/index.ts';
import type {FeedSource, NormalizedItem} from '../../shared/feedSource/index.ts';

let reader: FeedSource | null = null;
let lastDate: string = '';

let config: Config = {
  string: '',
  publishEmbed: false,
  languages: ['en'],
  truncate: true,
  runInterval: 60,
  publishDate: false,
  dateField: '',
  imageField: '',
  ogUserAgent: 'bsky.rss/1.0 (Open Graph Scraper)',
  descriptionClearHTML: true,
  forceDescriptionEmbed: false,
  removeDuplicate: false,
  titleClearHTML: false,
  adaptiveSpacing: false,
  spacingWindow: 600,
  minSpacing: 1,
  maxSpacing: 60,
};

async function start() {
  if (!reader) throw new Error('Reader not initialized.');

  reader.start({
    onItems: () => undefined,
    onItem: handleItem,
    onError: err => {
      console.log(
        `[${new Date().toUTCString()}] - [bsky.rss FETCH] Feed error: ${err.message}${
          err.cause ? ` (${String(err.cause)})` : ''
        }`,
      );
    },
  });
}

async function handleItem(item: NormalizedItem): Promise<void> {
  // dateField historically pointed at an arbitrary raw feedme tag name (feedme kept
  // every tag from the source feed as a flat property). NormalizedItem no longer
  // carries arbitrary per-feed fields - only its own fixed shape - so dateField now
  // only resolves against NormalizedItem's own field names. All 59 live bot configs
  // leave dateField empty today, so this has no real-world effect; kept for config
  // compatibility per the migration spec's Non-goals, not redesigned.
  const useDate = config.dateField
    ? (item as unknown as Record<string, string | undefined>)[config.dateField]
    : item.date;
  if (!useDate) return console.log('No date provided by RSS reader for post.');

  const parsed = parseString(config.string, item, config.truncate === true);
  let embed: Embed | undefined = undefined;
  let title: string | undefined = undefined;

  if (config.publishEmbed) {
    if (!item.link) throw new Error('No link provided from RSS reader to fetch Open Graph data.');
    const url = item.link;

    if (config.removeDuplicate) {
      if (await db.valueExists(url)) return;
      else await db.writeValue(url);
    } else {
      if (new Date(useDate) <= new Date(lastDate)) return;
    }

    let image: Buffer | undefined = item.imageUrl ? await fetchImage(item.imageUrl) : undefined;
    let description: string | undefined = undefined;
    let imageAlt: string | undefined = undefined;

    if (image === undefined && item.imageUrl) {
      console.log(
        `[${new Date().toUTCString()}] - [bsky.rss FETCH] Error fetching image for ${
          item.title
        } (${item.imageUrl})`,
      );
    }

    if (config.forceDescriptionEmbed) {
      description = item.description ? item.description : item.content ? item.content : undefined;

      if (description && config.descriptionClearHTML) {
        description = removeHTMLTags(description);
      }
    }

    if (config.embedType === 'image' && config.imageAlt) {
      imageAlt = parseString(config.imageAlt, item, false).text;
    }

    const defaultUserAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const userAgent = config.ogUserAgent || defaultUserAgent;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openGraphData: any = await og({
      url,
      timeout: 10000,
      fetchOptions: {
        headers: {
          'user-agent': userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
        },
      },
    })
      .then(res => (res.error ? {error: true} : res.result))
      .catch(() => ({
        error: true,
      }));

    if (!openGraphData.error) {
      if (image === undefined && openGraphData.ogImage) {
        const imageUrl: string = openGraphData.ogImage[0].url;

        if (imageUrl !== '' && imageUrl !== undefined) {
          image = await fetchImage(imageUrl);

          if (image === undefined) {
            console.log(
              `[${new Date().toUTCString()}] - [bsky.rss FETCH] Error fetching image for ${
                item.title
              } (${imageUrl})`,
            );
          }
        }

        if (description === undefined) {
          description = openGraphData.ogDescription
            ? openGraphData.ogDescription
            : item.description
              ? item.description
              : item.content
                ? item.content
                : undefined;
        }
      }

      if (description !== undefined && config.descriptionClearHTML) {
        description = removeHTMLTags(description);
      }

      let uri = openGraphData.ogUrl ? fixMalformedUrl(openGraphData.ogUrl) : url;

      if (openGraphData.ogUrl) {
        const regexURL = new RegExp(
          '^(h|H)(t|T)(t|T)(p|P)(s|S)?:\\/\\/[-a-zA-Z0-9@:%._\\+~#=]{1,256}\\.[a-zA-Z0-9()]{1,6}\\b([-a-zA-Z0-9()@:%_\\+.~#?&//=]*)',
        );

        if (!regexURL.test(uri)) uri = url;
      }

      if (!uri || (!openGraphData.ogTitle && !item.title)) {
        embed = undefined;
      } else {
        embed = {
          uri: uri,
          title: openGraphData.ogTitle ? openGraphData.ogTitle : (item.title ?? ''),
          description: description,
          image: image,
          imageAlt: imageAlt,
          type: config.embedType,
        };
      }
    } else {
      console.log(
        `[${new Date().toUTCString()}] - [bsky.rss FETCH] Error fetching Open Graph data for ${
          item.title
        } (${url})`,
      );

      description = item.description || item.content;
      if (description && config.descriptionClearHTML) {
        description = removeHTMLTags(description);
      }

      embed = {
        uri: url,
        title: item.title ?? '',
        description: description,
        image: image,
        imageAlt: imageAlt,
        type: config.embedType,
      };
    }
  }

  if (new Date(useDate) <= new Date(lastDate)) return;

  title = item.title ?? '';

  if (title && config.titleClearHTML) {
    title = decodeHTML(removeHTMLTags(title));
  }

  await queue.writeQueue({
    content: parsed.text,
    title: title,
    embed: config.publishEmbed ? embed : undefined,
    languages: config.languages ? config.languages : undefined,
    date: useDate,
  });

  // Advance the in-memory watermark as soon as an item is *queued*. feedsub used to
  // dedup across polls with its own internal item history; the shared/feedSource poller
  // deliberately re-delivers every parsed item on every poll, so without this the
  // staleness guards above compare against the frozen startup value forever and every
  // item gets re-queued on every poll. This must not be re-read from db.readLast():
  // last.txt only advances on a successful *publish*, so a slow queue drain would let
  // the poller re-queue items that are already waiting in the queue.
  if (!lastDate || new Date(useDate) > new Date(lastDate)) lastDate = useDate;
}

async function init({fetch_interval, fetch_url}: {fetch_interval: number; fetch_url: URL}) {
  config = await db.initConfig();
  if (!config.string) throw new Error('No string provided.');

  lastDate = await db.readLast();
  reader = createFeedSource(fetch_url, fetch_interval, {imageField: config.imageField});
  return reader;
}

async function launch() {
  return reader;
}

export default {
  start,
  init,
  launch,
};

function parseString(string: string, item: NormalizedItem, truncate: boolean) {
  const result: ParseResult = {
    text: '',
  };

  let parsedString = string;
  if (string.includes('$title')) {
    if (!item.title) throw new Error('No title provided from RSS reader.');

    if (config.titleClearHTML) {
      parsedString = parsedString.replace('$title', decodeHTML(removeHTMLTags(item.title)));
    } else {
      parsedString = parsedString.replace('$title', item.title);
    }
  }

  if (string.includes('$link')) {
    if (!item.link) throw new Error('No link provided from RSS reader.');
    parsedString = parsedString.replace('$link', item.link);
  }

  let description = item.description ? item.description : item.content;

  if (string.includes('$description')) {
    if (config.descriptionClearHTML && description) description = removeHTMLTags(description);
    parsedString = parsedString.replace('$description', description ?? '');
  }

  if (parsedString.length > 300 && truncate) {
    parsedString = parsedString.slice(0, 277) + '...';
  }
  result.text = parsedString;
  return result;
}

async function fetchImage(imageUrl: string) {
  let image: Buffer | undefined = undefined;

  try {
    const fetchBuffer = await axios.get(imageUrl, {
      headers: {
        'User-Agent': config.ogUserAgent,
      },
      responseType: 'arraybuffer',
    });
    image = await resizeImageToBuffer(fetchBuffer.data);
  } catch {
    // image fetch/resize failures are non-fatal; caller falls back to no image
  }

  return image;
}

function removeHTMLTags(htmlString: string) {
  return htmlString
    ?.replace(/<\/?[^>]+(>|$)/g, ' ')
    .replaceAll('&nbsp;', ' ')
    .trim()
    .replace(/  +/g, ' ');
}

function decodeHTML(htmlString: string) {
  // From my tests, some HTML strings needs to be double-decoded.
  // Ex.: &amp;#233; -> &#233; -> é
  return decode(decode(htmlString));
}

function fixMalformedUrl(urlString: string): string {
  // Fix malformed protocols like "https//" or "http//" (missing colon)
  // These get treated as relative URLs and cause concatenation bugs
  return urlString.replace(/^https\/\//i, 'https://').replace(/^http\/\//i, 'http://');
}

async function resizeImageToBuffer(bufferData: Buffer) {
  const image = await jimp.read(bufferData);
  return image
    .resize(800, jimp.AUTO) // null equivalent to Jimp.AUTO, Jimp.AUTO maintains aspect ratio
    .quality(80) // Setting JPEG quality
    .getBufferAsync(jimp.MIME_JPEG); // Getting the buffer as JPEG
}
