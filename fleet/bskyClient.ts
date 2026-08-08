import {createHash} from 'node:crypto';
import {BskyAgent, RichText, AtpSessionEvent, AtpSessionData, AppBskyFeedPost} from '@atproto/api';
import {XRPCError, ResponseType} from '@atproto/xrpc';
import {BotStore} from './botStore.ts';
import {FleetLogger, formatDebugError} from './logging.ts';
import type {MarkdownFacet} from '../shared/feedSource/markdownLinks.ts';

const TID_CHARSET = '234567abcdefghijklmnopqrstuvwxyz';
const TID_FIRST_CHAR_CHARSET = '234567abcdefghij';

/**
 * AT-Proto requires the rkey for an app.bsky.feed.post record to be a valid
 * TID: 13 characters matching ^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$
 * (verified directly against @atproto/syntax's real TID_REGEX and against a live
 * PDS response - a raw string like a sha256 hex digest is rejected with
 * "Invalid record key for app.bsky.feed.post: Invalid TID string"). The
 * validation is purely syntactic (no timestamp-plausibility check), so a
 * deterministic hash-derived TID satisfies it while preserving the same
 * idempotency guarantee as the original dedupeKey - same item always maps to
 * the same rkey. dedupeKey itself is unchanged everywhere else (local SQLite
 * uniqueness has no format constraint); only the value actually sent to the
 * PDS needs this conversion.
 */
export function toAtprotoRkey(dedupeKey: string): string {
  const hash = createHash('sha256').update(dedupeKey).digest();
  let rkey = TID_FIRST_CHAR_CHARSET[hash[0]! % TID_FIRST_CHAR_CHARSET.length]!;
  for (let i = 1; i < 13; i++) {
    rkey += TID_CHARSET[hash[i]! % TID_CHARSET.length]!;
  }
  return rkey;
}

export interface ResolvedEmbed {
  uri: string;
  title: string;
  description?: string;
  image?: Buffer;
  imageAlt?: string;
  type?: string;
}

export interface PostResult {
  ok: boolean;
  uri?: string;
  ratelimit?: boolean;
  deferralReason?: 'upload-failure';
  retryAfterSeconds?: number;
}

const DEFAULT_RETRY_SECONDS = 30;

/**
 * Today's bskyHandler.ts has two bugs here: it checks headers.hasOwnProperty("Retry-After")
 * against headers that Object.fromEntries(response.headers.entries()) always lowercases
 * (Fetch API spec), so that check can never match; and it only recognizes HTTP 504
 * (UpstreamTimeout), never the actual 429 (RateLimitExceeded) status. Both are fixed here.
 *
 * Only a genuinely recognized 429/504 XRPCError is classified as a rate limit. Every
 * other error (a plain Error, a non-XRPCError exception, an XRPCError with some other
 * status) falls through to `ratelimit: false` — a genuinely uncertain outcome, per
 * design spec §4.2: anything that isn't a confirmed success or a confirmed duplicate
 * must be marked skipped, never auto-retried forever.
 */
export function classifyPostError(error: unknown): {
  ratelimit: boolean;
  retryAfterSeconds: number;
} {
  if (
    error &&
    typeof error === 'object' &&
    (error as {constructor?: {name?: string}}).constructor?.name === XRPCError.name
  ) {
    const xrpcError = error as XRPCError;
    const isRateLimitStatus =
      xrpcError.status === ResponseType.RateLimitExceeded ||
      xrpcError.status === ResponseType.UpstreamTimeout;
    if (isRateLimitStatus) {
      const headers = xrpcError.headers as Record<string, string> | undefined;
      const raw = headers ? headers['retry-after'] : undefined;
      const parsed = raw ? Number(raw) : NaN;
      const retryAfterSeconds =
        !Number.isNaN(parsed) && parsed > 0 ? parsed : DEFAULT_RETRY_SECONDS;
      return {ratelimit: true, retryAfterSeconds};
    }
  }
  return {ratelimit: false, retryAfterSeconds: DEFAULT_RETRY_SECONDS};
}

/**
 * Whether a createRecord failure means "a record already exists at this exact rkey" —
 * the one case where automatic retry is safe (design spec §4.2), since the rkey makes
 * it provably idempotent: if it already exists, this exact item was already published.
 *
 * com.atproto.repo.createRecord's lexicon declares no formally-typed error for this
 * case (the only named error is InvalidSwap, for swapCommit mismatches) — so this
 * can't be guessed, it must be verified against a real PDS response. Starts
 * deliberately conservative: returns false unconditionally, matching the design's
 * explicit fail-safe default ("the fail-safe default for any unrecognized createRecord
 * error is to treat it as genuinely uncertain, not as a confirmed duplicate"). This is
 * a complete, intentional implementation of "no signal is trusted yet" — not a stub.
 * See fleet/verifyDuplicateDetection.ts for the empirical verification procedure that
 * should inform updating this function once a real error shape is confirmed.
 */
export function isAlreadyExistsError(_error: unknown): boolean {
  return false;
}

export class BskyClient {
  private agent: BskyAgent;

  constructor(
    private botId: string,
    service: string,
    private store: BotStore,
    private logger: FleetLogger,
    private dryRun: boolean = false,
    private alreadyExistsClassifier: (error: unknown) => boolean = isAlreadyExistsError,
  ) {
    this.agent = new BskyAgent({
      service,
      persistSession: (_evt: AtpSessionEvent, sess?: AtpSessionData) => {
        if (!sess) return;
        this.store.writeSession(sess);
      },
    });
  }

  async login(identifier: string, password: string): Promise<void> {
    const persisted = this.store.readSession<AtpSessionData>();
    if (persisted) {
      const resumeStartedAt = Date.now();
      try {
        const resumed = await this.agent.resumeSession(persisted);
        if (resumed.success) {
          this.logger.summary('LOGIN', 'Session resumed', this.botId);
          this.logger.verbose('LOGIN', `Resumed session for ${resumed.data.handle}`, this.botId);
          return;
        }
      } catch (error) {
        // resumeSession throws on any failure (expired token, network error, etc.)
        // Fall through to password login below
        this.logger.debug('LOGIN', `Session resume failed\n${formatDebugError(error)}`, this.botId);
      } finally {
        this.logDuration('Session resume', resumeStartedAt);
      }
    }
    const loginStartedAt = Date.now();
    let loginResult;
    try {
      loginResult = await this.agent.login({identifier, password});
    } finally {
      this.logDuration('Password login', loginStartedAt);
    }
    if (!loginResult.success) throw new Error('Login failed (identifier/password)');
    this.logger.summary('LOGIN', 'Logged in', this.botId);
    this.logger.verbose('LOGIN', `Logged in as ${loginResult.data.handle}`, this.botId);
  }

  async post(params: {
    content: string;
    languages?: string[];
    date?: Date;
    rkey: string;
    embed?: ResolvedEmbed;
    facets?: MarkdownFacet[];
  }): Promise<PostResult> {
    if (this.dryRun) {
      this.logger.verbose('POST', `[dry-run] would publish: ${params.content}`, this.botId);
      return {ok: true, uri: 'dry-run://noop'};
    }

    const markdownFacets = (params.facets ?? []).map(facet => ({
      index: {byteStart: facet.byteStart, byteEnd: facet.byteEnd},
      features: [{$type: 'app.bsky.richtext.facet#link', uri: facet.uri}],
    }));

    const autoDetect = new RichText({text: params.content});
    const facetStartedAt = Date.now();
    try {
      await autoDetect.detectFacets(this.agent);
    } finally {
      this.logDuration('Facet detection', facetStartedAt);
    }

    const richText = new RichText({
      text: params.content,
      facets: [...markdownFacets, ...(autoDetect.facets ?? [])],
    });

    let uploadedBlob: unknown;
    if (params.embed?.image) {
      const uploadStartedAt = Date.now();
      try {
        const uploadResult = await this.agent.uploadBlob(params.embed.image, {
          encoding: 'image/jpeg',
        });
        uploadedBlob = uploadResult.data.blob;
      } catch (error) {
        // No record has been created yet at this point, so it's always safe to retry.
        this.logger.debug('POST', `Blob upload failed\n${formatDebugError(error)}`, this.botId);
        return {ok: false, deferralReason: 'upload-failure', retryAfterSeconds: 30};
      } finally {
        this.logDuration('Blob upload', uploadStartedAt);
      }
    }

    let embed_data: unknown;
    if (params.embed) {
      if (params.embed.type === 'image') {
        if (uploadedBlob) {
          embed_data = {
            $type: 'app.bsky.embed.images',
            images: [{image: uploadedBlob, alt: params.embed.imageAlt ?? ''}],
          };
        }
      } else {
        embed_data = {
          $type: 'app.bsky.embed.external',
          external: {
            uri: params.embed.uri,
            title: params.embed.title,
            description: params.embed.description ?? '',
            thumb: uploadedBlob,
          },
        };
      }
    }

    const record = {
      $type: 'app.bsky.feed.post',
      text: richText.text,
      facets: richText.facets,
      embed: embed_data,
      langs: params.languages,
      createdAt: (params.date ?? new Date()).toISOString(),
    };

    const createStartedAt = Date.now();
    try {
      const result = await this.agent.app.bsky.feed.post.create(
        {repo: this.agent.accountDid, rkey: toAtprotoRkey(params.rkey)},
        record as unknown as AppBskyFeedPost.Record,
      );
      return {ok: true, uri: result.uri};
    } catch (error) {
      this.logger.debug('POST', `Create record failed\n${formatDebugError(error)}`, this.botId);
      if (this.alreadyExistsClassifier(error)) {
        this.logger.verbose(
          'POST',
          `rkey ${params.rkey} already exists — treating as already published, not a duplicate`,
          this.botId,
        );
        return {ok: true};
      }
      const {ratelimit, retryAfterSeconds} = classifyPostError(error);
      // Design spec §4.2: any outcome that isn't a confirmed success or a confirmed
      // duplicate is uncertain — skip, never auto-retry.
      return {ok: false, ratelimit, retryAfterSeconds};
    } finally {
      this.logDuration('Create record', createStartedAt);
    }
  }

  private logDuration(operation: string, startedAt: number): void {
    const elapsed = Math.max(0, Date.now() - startedAt);
    this.logger.debug('TIMING', `${operation} completed in ${elapsed}ms`, this.botId);
  }
}
