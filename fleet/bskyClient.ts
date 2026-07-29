import { BskyAgent, RichText, AtpSessionEvent, AtpSessionData } from "@atproto/api";
import { XRPCError, ResponseType } from "@atproto/xrpc";
import { BotStore } from "./botStore.ts";

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
export function classifyPostError(error: unknown): { ratelimit: boolean; retryAfterSeconds: number } {
  if (error && typeof error === "object" && (error as any).constructor?.name === XRPCError.name) {
    const xrpcError = error as XRPCError;
    const isRateLimitStatus =
      xrpcError.status === ResponseType.RateLimitExceeded ||
      xrpcError.status === ResponseType.UpstreamTimeout;
    if (isRateLimitStatus) {
      const headers = (xrpcError as any).headers as Record<string, string> | undefined;
      const raw = headers ? headers["retry-after"] : undefined;
      const parsed = raw ? Number(raw) : NaN;
      const retryAfterSeconds = !Number.isNaN(parsed) && parsed > 0 ? parsed : DEFAULT_RETRY_SECONDS;
      return { ratelimit: true, retryAfterSeconds };
    }
  }
  return { ratelimit: false, retryAfterSeconds: DEFAULT_RETRY_SECONDS };
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
    private dryRun: boolean = false
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
      try {
        const resumed = await this.agent.resumeSession(persisted);
        if (resumed.success) {
          console.log(
            `[${new Date().toUTCString()}] - [bsky.rss LOGIN] [${this.botId}] Resumed session for ${resumed.data.handle}`
          );
          return;
        }
      } catch (e) {
        // resumeSession throws on any failure (expired token, network error, etc.)
        // Fall through to password login below
      }
    }
    const loginResult = await this.agent.login({ identifier, password });
    if (!loginResult.success) throw new Error("Login failed (identifier/password)");
    console.log(
      `[${new Date().toUTCString()}] - [bsky.rss LOGIN] [${this.botId}] Logged in as ${loginResult.data.handle}`
    );
  }

  async post(params: {
    content: string;
    languages?: string[];
    date?: Date;
    rkey: string;
    embed?: ResolvedEmbed;
  }): Promise<PostResult> {
    if (this.dryRun) {
      console.log(
        `[${new Date().toUTCString()}] - [bsky.rss POST] [${this.botId}] [dry-run] would publish: ${params.content}`
      );
      return { ok: true, uri: "dry-run://noop" };
    }

    const richText = new RichText({ text: params.content });
    await richText.detectFacets(this.agent);

    let uploadedBlob: unknown;
    if (params.embed?.image) {
      try {
        const uploadResult = await this.agent.uploadBlob(params.embed.image, { encoding: "image/jpeg" });
        uploadedBlob = uploadResult.data.blob;
      } catch {
        // No record has been created yet at this point, so it's always safe to retry.
        return { ok: false, ratelimit: true, retryAfterSeconds: 30 };
      }
    }

    let embed_data: unknown;
    if (params.embed) {
      if (params.embed.type === "image") {
        if (uploadedBlob) {
          embed_data = {
            $type: "app.bsky.embed.images",
            images: [{ image: uploadedBlob, alt: params.embed.imageAlt ?? "" }],
          };
        }
      } else {
        embed_data = {
          $type: "app.bsky.embed.external",
          external: {
            uri: params.embed.uri,
            title: params.embed.title,
            description: params.embed.description ?? "",
            thumb: uploadedBlob,
          },
        };
      }
    }

    const record = {
      $type: "app.bsky.feed.post",
      text: richText.text,
      facets: richText.facets,
      embed: embed_data,
      langs: params.languages,
      createdAt: (params.date ?? new Date()).toISOString(),
    };

    try {
      const result = await this.agent.app.bsky.feed.post.create(
        { repo: this.agent.accountDid, rkey: params.rkey },
        record as any
      );
      return { ok: true, uri: result.uri };
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        console.log(
          `[${new Date().toUTCString()}] - [bsky.rss POST] [${this.botId}] rkey ${params.rkey} already exists — treating as already published, not a duplicate`
        );
        return { ok: true };
      }
      const { ratelimit, retryAfterSeconds } = classifyPostError(error);
      if (!ratelimit) {
        // Design spec §4.2: any outcome that isn't a confirmed success or a confirmed
        // duplicate is uncertain — skip, never auto-retry.
        return { ok: false, ratelimit: false };
      }
      return { ok: false, ratelimit, retryAfterSeconds };
    }
  }
}
