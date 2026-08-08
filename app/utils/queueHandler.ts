import bsky from './bskyHandler';
import db from './dbHandler';
import health from './healthHandler';

const queue: QueueItems[] = [];
let rateLimited: boolean = false;
let queueRunning: boolean = false;
let queueSnapshot: QueueItems[] = [];
let lastPostTimestamp = 0;

let config: Config = {
  string: '',
  publishEmbed: false,
  embedType: 'card',
  languages: ['en'],
  truncate: true,
  runInterval: 60,
  dateField: '',
  publishDate: false,
  imageField: '',
  ogUserAgent: 'bsky.rss/1.0 (Open Graph Scraper)',
  descriptionClearHTML: true,
  forceDescriptionEmbed: false,
  imageAlt: '',
  removeDuplicate: false,
  titleClearHTML: false,
  adaptiveSpacing: false,
  spacingWindow: 600,
  minSpacing: 1,
  maxSpacing: 60,
};

async function start() {
  config = await db.initConfig();
  console.log(
    `[${new Date().toUTCString()}] - [bsky.rss QUEUE] Starting queue handler. Running every ${
      config.runInterval
    } seconds`,
  );
  setInterval(() => {
    void runQueue();
  }, config.runInterval * 1000);
}

async function createLimitTimer(timeoutSeconds: number = 30) {
  if (rateLimited) return; // Already rate limited, don't create another timer
  rateLimited = true;
  setTimeout(() => {
    rateLimited = false;
    void runQueue();
    console.log(
      `[${new Date().toUTCString()}] - [bsky.rss QUEUE] Post rate limit expired - resuming queue`,
    );
  }, timeoutSeconds * 1000);
  return '';
}

async function runQueue() {
  if (queueRunning) return;
  // Marks activity on every tick, not just ticks that find something to post -
  // an idle bot (no new items, the normal case for most feeds) is still alive
  // and functioning, so it must not go stale and start failing health checks.
  health.updateActivity();
  queueSnapshot = [...queue];
  if (queueSnapshot.length === 0) return queueSnapshot;
  console.log(
    `[${new Date().toUTCString()}] - [bsky.rss QUEUE] Running queue with ${
      queueSnapshot.length
    } items`,
  );
  if (rateLimited) return {ratelimit: true};
  if (queueSnapshot.length > 0) {
    queueRunning = true;
    for (let i = 0; i < queueSnapshot.length; i++) {
      const item = queueSnapshot[i] as QueueItems;
      queue.splice(i, 1);
      queueSnapshot.splice(i, 1);
      i--;
      if (config.minSpacing && lastPostTimestamp) {
        const elapsed = Date.now() - lastPostTimestamp;
        const waitMs = config.minSpacing * 1000 - elapsed;
        if (waitMs > 0) {
          const waitSec = Math.ceil(waitMs / 1000);
          console.log(
            `[${new Date().toUTCString()}] - [bsky.rss QUEUE] Waiting ${waitSec} seconds before next post`,
          );
          await sleep(waitMs);
        }
      }
      const post = await bsky.post({
        content: item.content,
        embed: item.embed,
        languages: item.languages,
        date: config.publishDate ? new Date(item.date) : undefined,
        facets: item.facets,
      });
      if ('ratelimit' in post) {
        queue.unshift(item);
        const timeoutSeconds: number = post.retryAfter ? post.retryAfter : 30;
        await createLimitTimer(timeoutSeconds);
        queueRunning = false;
        console.log(
          `[${new Date().toUTCString()}] - [bsky.rss POST] Post rate limit exceeded - process will resume after ${timeoutSeconds} seconds`,
        );
        break;
      } else {
        console.log(
          `[${new Date().toUTCString()}] - [bsky.rss POST] Posting new item (${item.title})`,
        );
        void db.writeDate(new Date(item.date));
        lastPostTimestamp = Date.now();
        // A large backlog drains inside this same runQueue() call, holding
        // queueRunning true for the whole drain - later setInterval ticks
        // bail out immediately (see the guard above) without ever reaching
        // the top-of-function updateActivity() call, so a long drain must
        // refresh activity here too or it goes stale mid-drain despite
        // actively posting.
        health.updateActivity();
        if (config.adaptiveSpacing && queueSnapshot.length > 0) {
          const remaining = queueSnapshot.length;
          const delaySec = computeDelay(remaining + 1);

          if (delaySec > 0) {
            console.log(
              `[${new Date().toUTCString()}] - [bsky.rss QUEUE] Waiting ${delaySec} seconds before next post`,
            );
            await sleep(delaySec * 1000);
          }
        }
        if (i === queueSnapshot.length - 1) {
          queueRunning = false;
          queueSnapshot = [];
          console.log(
            `[${new Date().toUTCString()}] - [bsky.rss QUEUE] Finished running queue. Next run in ${
              config.runInterval
            } seconds`,
          );
          if (config.removeDuplicate) void db.cleanupOldValues();
        }
      }
    }
    return queue;
  } else {
    return queue;
  }
}

async function writeQueue({content, embed, languages, title, date, facets}: QueueItems) {
  console.log(`[${new Date().toUTCString()}] - [bsky.rss QUEUE] Queuing item (${title})`);
  queue.push({content, embed, languages, title, date, facets});
  return queue;
}

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

function computeDelay(q: number) {
  if (!config.adaptiveSpacing) return 0;
  if (q <= 1) return 0;
  const window = config.spacingWindow || 600;
  const min = config.minSpacing || 1;
  const max = config.maxSpacing || 60;
  return clamp(window / q, min, max);
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default {writeQueue, start, runQueue};
