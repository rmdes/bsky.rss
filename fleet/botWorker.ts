import {FeedReader, ParsedItem, ParsedEmbed} from './feedReader.ts';
import {Scheduler} from './scheduler.ts';
import {BskyClient, ResolvedEmbed} from './bskyClient.ts';
import {BotStore} from './botStore.ts';
import {selectEligibleItems, isStillFresh, FreshnessConfig} from './freshnessPolicy.ts';
import type {QueueItemRow} from './botStore.ts';
import {BotOperations, type BotOperationalSnapshot} from './botOperations.ts';
import {FleetLogger, formatDebugError} from './logging.ts';
import type {MarkdownFacet} from '../shared/feedSource/markdownLinks.ts';

export interface BotWorkerOptions {
  botId: string;
  feedReader: FeedReader;
  scheduler: Scheduler;
  bskyClient: BskyClient;
  store: BotStore;
  identityStore: BotStore;
  runIntervalSeconds: number;
  freshnessConfig: FreshnessConfig;
  perBotQueueMaxLength: number;
  operations: BotOperations;
  logger: FleetLogger;
}

export class BotWorker {
  readonly botId: string;
  private queueRunning = false;
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(private options: BotWorkerOptions) {
    this.botId = options.botId;
  }

  async start(): Promise<void> {
    this.options.feedReader.onItem((item: ParsedItem) => this.enqueue(item));
    this.options.feedReader.start();
    this.intervalHandle = setInterval(() => {
      this.drainOnce().catch(err => {
        this.options.logger.summary('QUEUE', 'Unexpected error during drain', this.botId);
        this.options.logger.debug('QUEUE', formatDebugError(err), this.botId);
      });
    }, this.options.runIntervalSeconds * 1000);
  }

  stop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  async shutdown(timeoutMs: number): Promise<void> {
    this.options.feedReader.stop();
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    await this.waitForDrainToFinish(timeoutMs);
    this.options.store.close();
  }

  private waitForDrainToFinish(timeoutMs: number): Promise<void> {
    if (!this.queueRunning) return Promise.resolve();
    return new Promise(resolve => {
      const start = Date.now();
      const check = setInterval(() => {
        if (!this.queueRunning || Date.now() - start >= timeoutMs) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });
  }

  queueLength(): number {
    return this.options.store.countQueued();
  }

  operationalSnapshot(): BotOperationalSnapshot {
    return this.options.operations.snapshot();
  }

  private enqueue(item: ParsedItem): void {
    if (this.options.store.countQueued() >= this.options.perBotQueueMaxLength) {
      this.options.logger.verbose(
        'QUEUE',
        `Queue at capacity (${this.options.perBotQueueMaxLength}), dropping item: ${item.title}`,
        this.botId,
      );
      return;
    }
    const id = this.options.store.enqueue({
      title: item.title,
      content: item.content,
      embedJson: item.embed ? JSON.stringify(item.embed) : null,
      languagesJson: item.languages ? JSON.stringify(item.languages) : null,
      facetsJson: item.facets.length > 0 ? JSON.stringify(item.facets) : null,
      itemDate: item.itemDate,
      dedupeKey: item.dedupeKey,
    });
    if (id === 0) {
      this.options.logger.verbose(
        'QUEUE',
        `Duplicate item ignored (already queued or previously published): ${item.title}`,
        this.botId,
      );
      return;
    }
    this.options.operations.recordQueued();
    this.options.logger.verbose('QUEUE', `Queuing item (${item.title})`, this.botId);
  }

  private async resolveEmbed(row: QueueItemRow): Promise<ResolvedEmbed | undefined> {
    if (!row.embedJson) return undefined;
    const parsed = JSON.parse(row.embedJson) as ParsedEmbed;
    const image = parsed.imageUrl
      ? await this.options.feedReader.resolveEmbedImage(parsed.imageUrl)
      : undefined;
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

    const {toPublish, toSkip} = selectEligibleItems(rows, this.options.freshnessConfig);
    for (const row of toSkip) {
      this.options.store.setQueueItemStatus(row.id, 'skipped');
      this.options.operations.recordPolicySkip();
      this.options.logger.verbose(
        'QUEUE',
        `Skipping stale or over-catchup-limit item (${row.title})`,
        this.botId,
      );
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
          this.options.store.setQueueItemStatus(row.id, 'skipped');
          this.options.operations.recordPolicySkip();
          this.options.logger.verbose(
            'QUEUE',
            `Item went stale mid-pass, skipping (${row.title})`,
            this.botId,
          );
          continue;
        }

        const embed = await this.resolveEmbed(row);
        const facets: MarkdownFacet[] = row.facetsJson ? JSON.parse(row.facetsJson) : [];

        let result;
        try {
          result = await this.options.bskyClient.post({
            content: row.content,
            languages: row.languagesJson ? JSON.parse(row.languagesJson) : undefined,
            rkey: row.dedupeKey,
            embed,
            facets,
          });
        } catch (err) {
          this.options.operations.recordPostException();
          this.options.logger.summary(
            'POST',
            'Unexpected error posting; item remains queued',
            this.botId,
          );
          this.options.logger.debug('POST', formatDebugError(err), this.botId);
          break;
        }

        if (!result.ok) {
          if (result.deferralReason === 'upload-failure') {
            const retryAfterSeconds = result.retryAfterSeconds ?? 30;
            this.options.operations.recordPostDeferred();
            this.options.scheduler.setRateLimitDeadline(retryAfterSeconds);
            this.options.logger.summary(
              'POST',
              `Blob upload failed; posting deferred for ${retryAfterSeconds} seconds`,
              this.botId,
            );
            break;
          }
          if (result.ratelimit) {
            this.options.operations.recordPostDeferred();
            this.options.scheduler.setRateLimitDeadline(result.retryAfterSeconds ?? 30);
            this.options.logger.summary(
              'QUEUE',
              `Post rate limit exceeded - process will resume after ${result.retryAfterSeconds ?? 30} seconds`,
              this.botId,
            );
            break;
          }
          // Uncertain, non-rate-limit outcome: skip this one item, keep draining the rest.
          this.options.operations.recordPostUncertain();
          this.options.store.setQueueItemStatus(row.id, 'skipped');
          this.options.logger.summary(
            'POST',
            'Uncertain result for item; skipped without retry',
            this.botId,
          );
          this.options.logger.verbose(
            'POST',
            `Uncertain result for item, skipping without retry (${row.title})`,
            this.botId,
          );
          continue;
        }

        this.options.operations.recordPostSuccess();
        this.options.store.setQueueItemStatus(row.id, 'published');
        this.options.scheduler.recordPost();
        this.options.store.writeCursor(new Date(row.itemDate));
        this.options.logger.verbose(
          'POST',
          `Posted item (${row.content.slice(0, 40)})`,
          this.botId,
        );
      }
    } finally {
      try {
        // 96-hour retention, matching dbHandler.cleanupOldValues()'s and this same
        // class's own (per-bot) cleanupOldSeenValues() convention. Multiple
        // BotWorkers sharing one identityStore each call this once per drain pass -
        // a full table scan (seen_items has no index on seen_at, only a primary key
        // on value), but the row counts here are small enough that coordinating the
        // call away isn't worth the complexity.
        this.options.identityStore.cleanupOldSeenValues(96);
      } finally {
        this.queueRunning = false;
      }
    }
  }
}
