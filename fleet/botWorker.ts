import { FeedReader, ParsedItem, ParsedEmbed } from "./feedReader.ts";
import { Scheduler } from "./scheduler.ts";
import { BskyClient } from "./bskyClient.ts";
import { BotStore } from "./botStore.ts";

interface QueuedItem {
  content: string;
  languages: string[] | undefined;
  itemDate: string;
  embed?: ParsedEmbed;
}

export interface BotWorkerOptions {
  botId: string;
  feedReader: FeedReader;
  scheduler: Scheduler;
  bskyClient: BskyClient;
  store: BotStore;
  runIntervalSeconds: number;
}

function log(botId: string, scope: string, message: string): void {
  console.log(`[${new Date().toUTCString()}] - [bsky.rss ${scope}] [${botId}] ${message}`);
}

export class BotWorker {
  private queue: QueuedItem[] = [];
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
    return this.queue.length;
  }

  private enqueue(item: ParsedItem): void {
    log(this.options.botId, "QUEUE", `Queuing item (${item.title})`);
    this.queue.push({
      content: item.content,
      languages: item.languages,
      itemDate: item.itemDate,
      embed: item.embed,
    });
  }

  async drainOnce(): Promise<void> {
    if (this.queueRunning) return;
    if (this.queue.length === 0) return;
    if (!this.options.scheduler.isEligibleNow(this.queue.length)) return;

    this.queueRunning = true;
    try {
      while (this.queue.length > 0) {
        if (!this.options.scheduler.isEligibleNow(this.queue.length)) break;

        const item = this.queue[0]!;
        let result;
        try {
          result = await this.options.bskyClient.post({
            content: item.content,
            languages: item.languages,
            embed: item.embed,
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
          }
          break;
        }

        this.queue.shift();
        this.options.scheduler.recordPost();
        this.options.store.writeCursor(new Date(item.itemDate));
        log(this.options.botId, "POST", `Posted item (${item.content.slice(0, 40)})`);
      }
    } finally {
      this.queueRunning = false;
    }
  }
}
