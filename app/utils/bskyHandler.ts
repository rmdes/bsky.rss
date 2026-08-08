import {
  BskyAgent,
  RichText,
  AtpSessionEvent,
  AtpSessionData,
  ComAtprotoRepoUploadBlob,
  AppBskyFeedPost,
} from '@atproto/api';
let bskyAgent: BskyAgent | null;
import {XRPCError, ResponseType} from '@atproto/xrpc';
import db from './dbHandler';
import type {MarkdownFacet} from '../../shared/feedSource/markdownLinks.ts';

async function init(service: string) {
  if (bskyAgent) throw new Error('Bluesky agent already initialized.');

  bskyAgent = new BskyAgent({
    service,
    persistSession: (_evt: AtpSessionEvent, sess?: AtpSessionData) => {
      if (!sess) return;
      void db.writePersistDate(sess);
    },
  });
  return bskyAgent;
}

async function login({identifier, password}: {identifier: string; password: string}) {
  if (!bskyAgent) throw new Error('Bluesky agent not initialized.');
  const persistedSessionData: Partial<AtpSessionData> = await db.readPersistData();

  try {
    if (!persistedSessionData.accessJwt)
      throw new Error('No persisted session data found. Using login/password.');
    const sessionData = persistedSessionData as AtpSessionData;
    const session = await bskyAgent.resumeSession(sessionData);
    if (session.success) {
      console.log(
        `[${new Date().toUTCString()}] - [bsky.rss LOGIN] Resumed session for ${
          session.data.handle
        }`,
      );
      return session;
    } else {
      throw new Error('Login failed (auth via persisted session)');
    }
  } catch {
    const loginData = await bskyAgent.login({identifier, password});
    if (!loginData.success) throw new Error('Login failed (auth via login/password)');
    return loginData;
  }
}

async function post({
  content,
  embed,
  languages,
  date,
  facets,
}: {
  content: string;
  embed?: Embed;
  languages?: string[];
  date?: Date;
  facets?: MarkdownFacet[];
}): Promise<{uri: string; cid: string} | {ratelimit: true; retryAfter?: number}> {
  if (!bskyAgent) throw new Error('Bluesky agent not initialized.');

  const markdownFacets = (facets ?? []).map(facet => ({
    index: {byteStart: facet.byteStart, byteEnd: facet.byteEnd},
    features: [{$type: 'app.bsky.richtext.facet#link', uri: facet.uri}],
  }));

  const autoDetect = new RichText({text: content});
  await autoDetect.detectFacets(bskyAgent);

  const bskyText = new RichText({
    text: content,
    // RichText's constructor sorts and filters these on assignment (rich-text.ts:159-161) -
    // no manual sort needed here.
    facets: [...markdownFacets, ...(autoDetect.facets ?? [])],
  });

  let embedImage: ComAtprotoRepoUploadBlob.Response | {ratelimit: true} | null = null;
  if (embed && embed.image) {
    try {
      embedImage = await bskyAgent.uploadBlob(embed.image, {
        encoding: 'image/jpeg',
      });
    } catch {
      embedImage = {ratelimit: true};
    }
  }
  if (embedImage && 'ratelimit' in embedImage) return {ratelimit: true};

  let embed_data = undefined;

  if (embed) {
    if (embed.type === 'image') {
      if (embed.image) {
        embed_data = {
          $type: 'app.bsky.embed.images',
          images: [
            {
              image: embed.image ? embedImage!.data.blob : undefined,
              alt: embed.imageAlt ? embed.imageAlt : '',
            },
          ],
        };
      }
    } else {
      embed_data = {
        $type: 'app.bsky.embed.external',
        external: {
          uri: embed.uri,
          title: embed.title,
          description: embed.description ? embed.description : '',
          thumb: embed.image ? embedImage!.data.blob : undefined,
        },
      };
    }
  }

  const record = {
    $type: 'app.bsky.feed.post',
    text: bskyText.text,
    facets: bskyText.facets,
    embed: embed_data,
    langs: languages,
    createdAt: date ? date.toISOString() : new Date().toISOString(),
  };

  let post: {uri: string; cid: string} | {ratelimit: true; retryAfter?: number} | undefined;
  try {
    post = await bskyAgent.post(record as unknown as AppBskyFeedPost.Record);
  } catch (error) {
    // if (error instanceof XRPCError) {
    if (error instanceof Object && error.constructor.name === XRPCError.name) {
      const xrpc_error = error as XRPCError;

      if (xrpc_error.status === ResponseType.UpstreamTimeout) {
        const headers = xrpc_error.headers;

        if (headers && Object.hasOwn(headers, 'Retry-After') && headers['Retry-After']) {
          const retryAfter: number = +headers['Retry-After'];
          post = {ratelimit: true, retryAfter: retryAfter};
        }
      }
    }

    if (!post) post = {ratelimit: true, retryAfter: 30};
  }
  return post!;
}

export default {
  init,
  login,
  post,
};
