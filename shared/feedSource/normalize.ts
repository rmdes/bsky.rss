import type {Atom, Json, Rdf, Rss} from 'feedsmith/types';
import type {DeepPartial} from 'feedsmith/types';
import type {FeedSourceConfig, NormalizedItem, ParsedFeedResult} from './types.ts';
import {resolveImageUrl} from './imageResolver.ts';

function extractGeo(
  point: {lat?: number; lng?: number} | undefined,
): {lat: number; lng: number} | undefined {
  if (typeof point?.lat === 'number' && typeof point?.lng === 'number') {
    return {lat: point.lat, lng: point.lng};
  }
  return undefined;
}

function normalizeRssItem(item: DeepPartial<Rss.Item<string>>): NormalizedItem {
  return {
    id: item.guid?.value || item.link || '',
    title: item.title,
    link: item.link,
    date: item.pubDate,
    description: item.description,
    content: item.content?.encoded,
    imageUrl: undefined,
    geo: extractGeo(item.georss?.point),
  };
}

function normalizeAtomEntry(entry: DeepPartial<Atom.Entry<string>>): NormalizedItem {
  const explicitLink =
    entry.links?.find(l => !l.rel || l.rel === 'alternate')?.href ?? entry.links?.[0]?.href;
  // Some Atom feeds (e.g. Environment and Climate Change Canada's earthquake alerts) omit <link>
  // entirely and use <id> as the permalink instead - a valid Atom pattern. Only trust <id> as a
  // link when it's actually a URL: other feeds (e.g. Flickr's geo feed) use tag: URIs for <id>
  // while still providing a real <link>, so this must never override an existing link or promote
  // a non-URL id.
  const link =
    explicitLink ?? (entry.id && /^https?:\/\//.test(entry.id) ? entry.id : undefined);
  return {
    id: entry.id || link || '',
    title: entry.title,
    link,
    date: entry.published ?? entry.updated,
    description: entry.summary,
    content: entry.content,
    imageUrl: undefined,
    geo: extractGeo(entry.georss?.point),
  };
}

function normalizeJsonItem(
  item: DeepPartial<Json.Item<string>>,
  imageField: string | undefined,
): NormalizedItem {
  return {
    id: item.id || item.url || '',
    title: item.title,
    link: item.url,
    date: item.date_published ?? item.date_modified,
    description: item.summary,
    content: item.content_html ?? item.content_text,
    // JSON Feed has no enclosure/media:content distinction to match imageField
    // against, so any non-empty imageField opts in to its native image field. An
    // unset imageField means "no field-driven image, use Open Graph only" - the same
    // thing it means for RSS/RDF/Atom.
    imageUrl: imageField ? item.image : undefined,
    geo: undefined,
  };
}

function normalizeRdfItem(item: DeepPartial<Rdf.Item<string>>): NormalizedItem {
  return {
    id: item.link || '',
    title: item.title,
    link: item.link,
    date: item.dc?.dates?.[0],
    description: item.description,
    content: item.content?.encoded,
    imageUrl: undefined,
    geo: extractGeo(item.georss?.point),
  };
}

export function normalizeFeed(
  parsed: ParsedFeedResult,
  config: FeedSourceConfig,
): NormalizedItem[] {
  if (parsed.format === 'rss') {
    return (parsed.feed.items ?? []).map(item => ({
      ...normalizeRssItem(item),
      imageUrl: resolveImageUrl(item, config.imageField),
    }));
  }
  if (parsed.format === 'atom') {
    // Atom entries carry the same Media RSS namespace shape as RSS/RDF items, so
    // imageField resolution applies here too.
    return (parsed.feed.entries ?? []).map(entry => ({
      ...normalizeAtomEntry(entry),
      imageUrl: resolveImageUrl(entry, config.imageField),
    }));
  }
  if (parsed.format === 'json') {
    return (parsed.feed.items ?? []).map(item => normalizeJsonItem(item, config.imageField));
  }
  return (parsed.feed.items ?? []).map(item => ({
    ...normalizeRdfItem(item),
    imageUrl: resolveImageUrl(item, config.imageField),
  }));
}
