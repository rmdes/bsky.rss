import { FeedReader, ParsedItem, ParsedEmbed } from "./feedReader.ts";
import { Scheduler } from "./scheduler.ts";
import { BskyClient, ResolvedEmbed } from "./bskyClient.ts";
import { BotStore } from "./botStore.ts";
import { selectEligibleItems, isStillFresh, FreshnessConfig } from "./freshnessPolicy.ts";
import type { QueueItemRow } from "./botStore.ts";

export interface BotWorkerOptions {
  botId: string;
  feedReader: FeedReader;
  scheduler: Scheduler;
  bskyClient: BskyClient;
  store: BotStore;
  runIntervalSeconds: number;
  freshnessConfig: FreshnessConfig;
}

function log(botId: string, scope: string, message: string): void {
  console.log(`[${new Date().toUTCString()}] - [bsky.rss ${scope}] [${botId}] ${message}`);
}

export class BotWorker {
  private queueRunning = false;
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(private options: BotWorkerOptions) {}

  async start(): Promise<void> {
    this.options.feedReader.onItem((item: ParsedItem) => this.enqueue(item));
    this.options.feedReader.start();
    this.intervalHandle = setInterval(() => {
      this.drainOnce().catch((err) => {
        log(this.options.botId, "QUEUE", `Unexpected error during drain: ${err}`);
      });
    }, this.options.runIntervalSeconds * 1000);
  }

  stop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  queueLength(): number {
    return this.options.store.countQueued();
  }

  private enqueue(item: ParsedItem): void {
    const id = this.options.store.enqueue({
      title: item.title,
      content: item.content,
      embedJson: item.embed ? JSON.stringify(item.embed) : null,
      languagesJson: item.languages ? JSON.stringify(item.languages) : null,
      itemDate: item.itemDate,
      dedupeKey: item.dedupeKey,
    });
    if (id === 0) {
      log(this.options.botId, "QUEUE", `Duplicate item ignored (already queued or previously published): ${item.title}`);
      return;
    }
    log(this.options.botId, "QUEUE", `Queuing item (${item.title})`);
  }

  private async resolveEmbed(row: QueueItemRow): Promise<ResolvedEmbed | undefined> {
    if (!row.embedJson) return undefined;
    const parsed = JSON.parse(row.embedJson) as ParsedEmbed;
    const image = parsed.imageUrl ? await this.options.feedReader.resolveEmbedImage(parsed.imageUrl) : undefined;
    return {
      uri: parsed.uri,
      title: parsed.title,
      description: parsed.description,
      image,
      imageAlt: parsed.imageAlt,
      type: parsed.type,
    };
  }

  async drainOnce(): Promise<void> {
    if (this.queueRunning) return;

    const rows = this.options.store.listQueued();
    if (rows.length === 0) return;

    const { toPublish, toSkip } = selectEligibleItems(rows, this.options.freshnessConfig);
    for (const row of toSkip) {
      this.options.store.setQueueItemStatus(row.id, "skipped");
      log(this.options.botId, "QUEUE", `Skipping stale or over-catchup-limit item (${row.title})`);
    }
    if (toPublish.length === 0) return;
    if (!this.options.scheduler.isEligibleNow(toPublish.length)) return;

    this.queueRunning = true;
    try {
      for (const row of toPublish) {
        if (!this.options.scheduler.isEligibleNow(this.options.store.countQueued())) break;

        // Re-check freshness immediately before posting - a long adaptive-spacing pass
        // can let an item go stale after it was selected (design spec §6).
        if (!isStillFresh(row.itemDate, this.options.freshnessConfig.maxItemAgeMinutes)) {
          this.options.store.setQueueItemStatus(row.id, "skipped");
          log(this.options.botId, "QUEUE", `Item went stale mid-pass, skipping (${row.title})`);
          continue;
        }

        const embed = await this.resolveEmbed(row);

        let result;
        try {
          result = await this.options.bskyClient.post({
            content: row.content,
            languages: row.languagesJson ? JSON.parse(row.languagesJson) : undefined,
            rkey: row.dedupeKey,
            embed,
          });
        } catch (err) {
          log(this.options.botId, "POST", `Unexpected error posting: ${err}`);
          break;
        }

        if (!result.ok) {
          if (result.ratelimit) {
            this.options.scheduler.setRateLimitDeadline(result.retryAfterSeconds ?? 30);
            log(
              this.options.botId,
              "QUEUE",
              `Post rate limit exceeded - process will resume after ${result.retryAfterSeconds ?? 30} seconds`
            );
            break;
          }
          // Uncertain, non-rate-limit outcome: skip this one item, keep draining the rest.
          this.options.store.setQueueItemStatus(row.id, "skipped");
          log(this.options.botId, "POST", `Uncertain result for item, skipping without retry (${row.title})`);
          continue;
        }

        this.options.store.setQueueItemStatus(row.id, "published");
        this.options.scheduler.recordPost();
        this.options.store.writeCursor(new Date(row.itemDate));
        log(this.options.botId, "POST", `Posted item (${row.content.slice(0, 40)})`);
      }
    } finally {
      this.queueRunning = false;
    }
  }
}
