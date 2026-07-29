// fleet/benchmarkHarness.ts
import { createServer, Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jimp from "jimp";
import { BotStore } from "./botStore.ts";
import { Scheduler } from "./scheduler.ts";
import { BskyClient } from "./bskyClient.ts";
import { FeedReader } from "./feedReader.ts";
import { BotWorker } from "./botWorker.ts";
import { SharedLimiters } from "./sharedLimiters.ts";

export interface BenchmarkOptions {
  botCount: number;
  durationMs: number;
  sampleIntervalMs: number;
  itemsPerPoll: number;
  imageEveryNItems: number;
  fetchIntervalMinutes: number;
}

export interface BenchmarkReport {
  steadyStateRssBytes: number;
  peakRssBytes: number;
  sampleCount: number;
}

let feedSeq = 0;

function buildFeedXml(itemsPerPoll: number, port: number): string {
  feedSeq++;
  const items: string[] = [];
  for (let i = 0; i < itemsPerPoll; i++) {
    const uid = `${feedSeq}-${i}-${Date.now()}`;
    items.push(`
      <item>
        <title>Synthetic item ${uid}</title>
        <link>http://127.0.0.1:${port}/article/${uid}</link>
        <description>Synthetic description ${uid}</description>
        <pubDate>${new Date().toUTCString()}</pubDate>
        <guid>${uid}</guid>
      </item>`);
  }
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Synthetic Feed</title>${items.join(
    ""
  )}</channel></rss>`;
}

function buildArticleHtml(uid: string, withImage: boolean, port: number): string {
  const imageTag = withImage
    ? `<meta property="og:image" content="http://127.0.0.1:${port}/image.jpg" />`
    : "";
  return `<html><head>
    <meta property="og:title" content="Synthetic article ${uid}" />
    <meta property="og:description" content="Synthetic OG description ${uid}" />
    ${imageTag}
  </head><body>Synthetic article body ${uid}</body></html>`;
}

async function createSyntheticImage(): Promise<Buffer> {
  const image = new jimp(400, 300, 0x336699ff);
  return image.getBufferAsync(jimp.MIME_JPEG);
}

export async function createMockFeedServer(
  itemsPerPoll: number,
  imageEveryNItems: number
): Promise<{ server: Server; port: number }> {
  const syntheticImage = await createSyntheticImage();
  let port = 0; // set once listen() resolves, closed over by the handler below - never re-queried

  const server = createServer((req, res) => {
    const url = req.url ?? "";

    if (url === "/feed") {
      res.writeHead(200, { "Content-Type": "application/rss+xml" });
      res.end(buildFeedXml(itemsPerPoll, port));
      return;
    }

    if (url.startsWith("/article/")) {
      const uid = url.slice("/article/".length);
      const itemIndex = Number(uid.split("-")[1] ?? 0);
      const withImage = imageEveryNItems > 0 && itemIndex % imageEveryNItems === 0;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(buildArticleHtml(uid, withImage, port));
      return;
    }

    if (url === "/image.jpg") {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(syntheticImage);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as { port: number }).port;
  return { server, port };
}

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const { server, port } = await createMockFeedServer(options.itemsPerPoll, options.imageEveryNItems);
  const tmpDir = mkdtempSync(join(tmpdir(), "fleet-benchmark-"));

  const sharedLimiters = new SharedLimiters({
    maxConcurrentOpenGraphFetches: 6,
    maxConcurrentImageJobs: 2,
    maxImageDownloadBytes: 10_000_000,
    httpTimeoutMs: 10_000,
  });

  const workers: BotWorker[] = [];
  const stores: BotStore[] = [];
  const feedReaders: FeedReader[] = [];

  for (let i = 0; i < options.botCount; i++) {
    const botId = `bench-bot-${i}`;
    const store = new BotStore(join(tmpDir, `${botId}.sqlite`));
    stores.push(store);
    const bskyClient = new BskyClient(botId, "https://bsky.social", store, true);
    const feedReader = new FeedReader(
      botId,
      new URL(`http://127.0.0.1:${port}/feed`),
      options.fetchIntervalMinutes,
      {
        string: "$title",
        publishEmbed: true,
        embedType: "card",
        languages: ["en"],
        truncate: true,
        removeDuplicate: true,
        titleClearHTML: false,
        descriptionClearHTML: false,
      },
      store,
      sharedLimiters
    );
    feedReaders.push(feedReader);
    const worker = new BotWorker({
      botId,
      feedReader,
      scheduler: new Scheduler({ minSpacing: 0, maxSpacing: 5, spacingWindow: 60, adaptiveSpacing: false }),
      bskyClient,
      store,
      runIntervalSeconds: 1,
      freshnessConfig: { maxCatchupItems: 50, maxItemAgeMinutes: 60 },
      perBotQueueMaxLength: 500,
    });
    await worker.start();
    workers.push(worker);
  }

  const samples: number[] = [];
  const startTime = Date.now();
  await new Promise<void>((resolve) => {
    const sampleHandle = setInterval(() => {
      samples.push(process.memoryUsage().rss);
      if (Date.now() - startTime >= options.durationMs) {
        clearInterval(sampleHandle);
        resolve();
      }
    }, options.sampleIntervalMs);
  });

  for (const worker of workers) worker.stop();
  for (const feedReader of feedReaders) feedReader.stop();
  // Give any drain/handleItem call already in flight when stop() was called (the
  // interval firing async work has no way to be awaited from the outside) a moment
  // to settle before the stores go away underneath it - otherwise it logs a stray
  // "database is not open" instead of completing or being cleanly skipped.
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const store of stores) store.close();
  server.close();
  server.closeAllConnections(); // force-close any still-open sockets rather than waiting on them
  rmSync(tmpDir, { recursive: true, force: true });

  const steadyStateWindow = samples.slice(Math.floor(samples.length / 2));
  const steadyStateRssBytes = Math.round(
    steadyStateWindow.reduce((a, b) => a + b, 0) / steadyStateWindow.length
  );
  const peakRssBytes = samples.reduce((max, sample) => Math.max(max, sample), 0);

  return { steadyStateRssBytes, peakRssBytes, sampleCount: samples.length };
}
