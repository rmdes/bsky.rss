import { BskyAgent, RichText, AtpSessionEvent, AtpSessionData } from "@atproto/api";
import { XRPCError, ResponseType } from "@atproto/xrpc";
import { BotStore } from "./botStore.ts";

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
  return { ratelimit: true, retryAfterSeconds: DEFAULT_RETRY_SECONDS };
}

export class BskyClient {
  private agent: BskyAgent;

  constructor(
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
          console.log(`[${new Date().toUTCString()}] - [bsky.rss LOGIN] Resumed session for ${resumed.data.handle}`);
          return;
        }
      } catch (e) {
        // resumeSession throws on any failure (expired token, network error, etc.)
        // Fall through to password login below
      }
    }
    const loginResult = await this.agent.login({ identifier, password });
    if (!loginResult.success) throw new Error("Login failed (identifier/password)");
    console.log(`[${new Date().toUTCString()}] - [bsky.rss LOGIN] Logged in as ${loginResult.data.handle}`);
  }

  async post(params: { content: string; languages?: string[]; date?: Date }): Promise<PostResult> {
    if (this.dryRun) {
      console.log(`[dry-run] would publish: ${params.content}`);
      return { ok: true, uri: "dry-run://noop" };
    }

    const richText = new RichText({ text: params.content });
    await richText.detectFacets(this.agent);

    const record = {
      $type: "app.bsky.feed.post",
      text: richText.text,
      facets: richText.facets,
      langs: params.languages,
      createdAt: (params.date ?? new Date()).toISOString(),
    };

    try {
      const result = await this.agent.post(record as any);
      return { ok: true, uri: result.uri };
    } catch (error) {
      const { ratelimit, retryAfterSeconds } = classifyPostError(error);
      return { ok: false, ratelimit, retryAfterSeconds };
    }
  }
}
