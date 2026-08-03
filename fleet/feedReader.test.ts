import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeHTMLTags, decodeHTMLTwice, fixMalformedUrl, parseString, textOf, FeedReader } from "./feedReader.ts";
import { computeDedupeKey } from "./dedupeKey.ts";
import { BotStore } from "./botStore.ts";
import { SharedLimiters } from "./sharedLimiters.ts";
import { BotOperations } from "./botOperations.ts";
import { FleetLogger, type FleetLogRecord } from "./logging.ts";
import jimp from "jimp";

const fixedNow = new Date("2026-08-03T12:00:00.000Z");

function createRuntime(
  botId = "test-bot",
  fetchOpenGraph?: (url: string, userAgent: string, timeoutMs: number) => Promise<unknown>
): { operations: BotOperations; logger: FleetLogger; records: FleetLogRecord[]; fetchOpenGraph?: typeof fetchOpenGraph } {
  const records: FleetLogRecord[] = [];
  return {
    operations: new BotOperations(botId, () => fixedNow),
    logger: new FleetLogger({
      defaultLevel: "debug",
      now: () => fixedNow,
      sink: (_line, record) => records.push(record),
    }),
    records,
    fetchOpenGraph,
  };
}

function createInstrumentedReader(
  t: { after(callback: () => void): void },
  options: {
    config?: Record<string, unknown>;
    fetchOpenGraph?: (url: string, userAgent: string, timeoutMs: number) => Promise<unknown>;
  } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), "feedreader-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new BotStore(join(dir, "state.sqlite"));
  t.after(() => store.close());
  const runtime = createRuntime("test-bot", options.fetchOpenGraph);
  const reader = new FeedReader(
    "test-bot",
    new URL("http://127.0.0.1:1/feed.xml"),
    5,
    { string: "$title", ...options.config },
    store,
    new SharedLimiters({
      maxConcurrentOpenGraphFetches: 1,
      maxConcurrentImageJobs: 1,
      maxImageDownloadBytes: 10_000_000,
      httpTimeoutMs: 5000,
    }),
    runtime
  );
  const underlying = (reader as any).reader;
  underlying.read = () => undefined;
  underlying.start = () => undefined;
  underlying.stop = () => undefined;
  return { reader, runtime };
}

test("removeHTMLTags strips tags and collapses whitespace", () => {
  assert.equal(removeHTMLTags("<p>Hello <b>world</b></p>"), "Hello world");
});

test("removeHTMLTags converts &nbsp; to a plain space", () => {
  assert.equal(removeHTMLTags("Hello&nbsp;world"), "Hello world");
});

test("removeHTMLTags collapses multiple spaces into one", () => {
  assert.equal(removeHTMLTags("Hello   world"), "Hello world");
});

test("decodeHTMLTwice handles double-encoded entities", () => {
  // &amp;#233; -> &#233; -> é, matching today's rssHandler.ts comment/behavior exactly
  assert.equal(decodeHTMLTwice("&amp;#233;"), "é");
});

test("fixMalformedUrl fixes a missing colon after https", () => {
  assert.equal(fixMalformedUrl("https//example.com/a"), "https://example.com/a");
});

test("fixMalformedUrl fixes a missing colon after http", () => {
  assert.equal(fixMalformedUrl("http//example.com/a"), "http://example.com/a");
});

test("fixMalformedUrl leaves a well-formed URL unchanged", () => {
  assert.equal(fixMalformedUrl("https://example.com/a"), "https://example.com/a");
});

test("parseString substitutes $title, $link, $description", () => {
  const item = {
    title: "My Title",
    link: { href: "https://example.com/post" },
    description: "My description",
  };
  const result = parseString("$title - $link ($description)", item, false, false, false);
  assert.equal(result, "My Title - https://example.com/post (My description)");
});

test("parseString truncates past 300 chars to 280 chars when truncate is true", () => {
  const longTitle = "x".repeat(400);
  const item = { title: longTitle, link: { href: "https://example.com" }, description: "" };
  const result = parseString("$title", item, true, false, false);
  assert.equal(result.length, 280);
  assert.ok(result.endsWith("..."));
});

test("parseString does not truncate when truncate is false", () => {
  const longTitle = "x".repeat(400);
  const item = { title: longTitle, link: { href: "https://example.com" }, description: "" };
  const result = parseString("$title", item, false, false, false);
  assert.equal(result.length, 400);
});

test("parseString cleans HTML from the title when titleClearHTML is true", () => {
  const item = { title: "<b>Bold</b> Title", link: { href: "https://example.com" }, description: "" };
  const result = parseString("$title", item, false, true, false);
  assert.equal(result, "Bold Title");
});

test("computeDedupeKey matches what a FeedReader-computed dedupeKey should look like for a known URL", () => {
  // Guards the FeedReader <-> dedupeKey.ts integration contract: FeedReader must call
  // computeDedupeKey(botId, itemUrl) with the item's link, not some other string.
  const key = computeDedupeKey("bot-1", "https://example.com/a");
  assert.equal(typeof key, "string");
  assert.equal(key.length, 64);
});

test("textOf returns a plain string unchanged", () => {
  assert.equal(textOf("urn:uuid:AAA"), "urn:uuid:AAA");
});

test("textOf pulls .text out of the object shape feedme returns for an attributed tag", () => {
  // feedme (feedsub's underlying parser) returns e.g. <guid isPermaLink="false">urn:uuid:AAA</guid>
  // as { ispermalink: "false", text: "urn:uuid:AAA" }, not a plain string.
  assert.equal(textOf({ ispermalink: "false", text: "urn:uuid:AAA" }), "urn:uuid:AAA");
});

test("textOf treats an empty string as absent so callers fall through to the next candidate", () => {
  assert.equal(textOf(""), undefined);
  assert.equal(textOf(undefined), undefined);
});

test("two feedme-style attributed guid objects with different text no longer collide on the same dedupeKey", () => {
  // This is the actual bug this round fixes: item.guid ends up as an OBJECT
  // ({ ispermalink, text }) whenever the <guid> tag carries an attribute (the
  // standard RSS 2.0 shape). Before textOf(), both objects coerced to the identical
  // string "[object Object]" in the dedupeKey template literal and collided.
  const guidA = { ispermalink: "false", text: "urn:uuid:AAA" };
  const guidB = { ispermalink: "false", text: "urn:uuid:BBB" };

  const keyA = computeDedupeKey("bot-1", textOf(undefined) || textOf(guidA) || textOf(undefined) || "");
  const keyB = computeDedupeKey("bot-1", textOf(undefined) || textOf(guidB) || textOf(undefined) || "");

  assert.notEqual(keyA, keyB);
});

test("an items batch with entries records a successful feed poll", (t) => {
  // Break caught: removing the FeedSub `items` success listener leaves successful
  // polls invisible even though feedsub delivered a complete batch.
  const { reader, runtime } = createInstrumentedReader(t);
  reader.start();

  (reader as any).reader.emit("items", [{ title: "one" }]);

  const snapshot = runtime.operations.snapshot();
  assert.equal(snapshot.feedState, "ok");
  assert.equal(snapshot.counters.feedPollSucceeded, 1);
  assert.equal(snapshot.lastFeedSuccessAt, fixedNow.toISOString());
});

test("an empty items batch still records a successful feed poll", (t) => {
  // Break caught: treating an empty but successfully fetched feed as a failed or
  // unrecorded poll hides the health of feeds that simply have no new entries.
  const { reader, runtime } = createInstrumentedReader(t);
  reader.start();

  (reader as any).reader.emit("items", []);

  const snapshot = runtime.operations.snapshot();
  assert.equal(snapshot.feedState, "ok");
  assert.equal(snapshot.counters.feedPollSucceeded, 1);
});

test("feed failures are summarized once and a later items batch records the exact recovery count", (t) => {
  // Break caught: logging every failed poll creates an incident flood, while losing
  // the prior count makes a recovery impossible to assess from the summary line.
  const { reader, runtime } = createInstrumentedReader(t);
  reader.start();

  (reader as any).reader.emit("error", new Error("unable to verify the first certificate"));
  (reader as any).reader.emit("error", new Error("unable to verify the first certificate"));

  const duringFailure = runtime.operations.snapshot();
  assert.equal(duringFailure.feedState, "failing");
  assert.equal(duringFailure.counters.feedPollFailed, 2);
  assert.equal(duringFailure.consecutiveFeedFailures, 2);
  assert.equal(duringFailure.lastFeedFailureCategory, "tls");
  assert.deepEqual(
    runtime.records.filter((record) => record.level === "summary").map((record) => record.message),
    ["Feed unavailable (tls)"]
  );

  (reader as any).reader.emit("items", []);

  const recovered = runtime.operations.snapshot();
  assert.equal(recovered.feedState, "ok");
  assert.equal(recovered.counters.feedPollSucceeded, 1);
  assert.equal(recovered.consecutiveFeedFailures, 0);
  assert.deepEqual(
    runtime.records.filter((record) => record.level === "summary").map((record) => record.message),
    ["Feed unavailable (tls)", "Feed recovered after 2 failed poll(s)"]
  );
});

test("a successful Open Graph fetch records success", async (t) => {
  // Break caught: accepting the fetched Open Graph result without recording its
  // outcome makes the operations snapshot undercount successful enrichment.
  const { reader, runtime } = createInstrumentedReader(t, {
    config: { publishEmbed: true, embedType: "card" },
    fetchOpenGraph: async () => ({
      ogTitle: "Open Graph title",
      ogDescription: "Open Graph description",
      ogUrl: "https://example.test/canonical",
    }),
  });
  const emitted: unknown[] = [];
  reader.onItem((item) => emitted.push(item));

  await (reader as any).handleItem({
    title: "RSS title",
    link: "https://example.test/article",
    description: "RSS description",
    pubdate: "2026-08-03T12:01:00.000Z",
  });

  assert.equal(runtime.operations.snapshot().counters.openGraphSucceeded, 1);
  assert.equal(runtime.operations.snapshot().counters.openGraphFallback, 0);
  assert.ok(runtime.records.some(
    (record) => record.level === "debug" && /Open Graph fetch completed in \d+ms/.test(record.message)
  ));
  assert.deepEqual(emitted, [
    {
      title: "RSS title",
      content: "RSS title",
      embed: {
        uri: "https://example.test/canonical",
        title: "Open Graph title",
        description: "Open Graph description",
        imageUrl: undefined,
        imageAlt: undefined,
        type: "card",
      },
      languages: undefined,
      itemDate: "2026-08-03T12:01:00.000Z",
      dedupeKey: computeDedupeKey("test-bot", "https://example.test/article"),
    },
  ]);
});

test("a rejected Open Graph fetch records fallback without leaking item details to summary logs", async (t) => {
  // Break caught: a rejected enrichment request must retain today's RSS-derived
  // embed fallback, but leaking its URL/title/error to summary logs exposes noisy
  // operational detail and makes a harmless fallback look like a feed outage.
  const itemUrl = "https://private.example.test/article";
  const itemTitle = "Sensitive RSS title";
  const rawError = "upstream token should stay debug-only";
  const { reader, runtime } = createInstrumentedReader(t, {
    config: { publishEmbed: true, embedType: "card" },
    fetchOpenGraph: async () => {
      throw new Error(rawError);
    },
  });
  const emitted: any[] = [];
  reader.onItem((item) => emitted.push(item));

  await (reader as any).handleItem({
    title: itemTitle,
    link: itemUrl,
    description: "RSS fallback description",
    pubdate: "2026-08-03T12:01:00.000Z",
  });

  assert.deepEqual(emitted[0].embed, {
    uri: itemUrl,
    title: itemTitle,
    description: "RSS fallback description",
    imageUrl: undefined,
    imageAlt: undefined,
    type: "card",
  });
  assert.equal(runtime.operations.snapshot().counters.openGraphSucceeded, 0);
  assert.equal(runtime.operations.snapshot().counters.openGraphFallback, 1);

  const summaries = runtime.records.filter((record) => record.level === "summary");
  assert.equal(summaries.length, 0);
  assert.equal(
    summaries.some((record) =>
      [itemUrl, itemTitle, rawError].some((sensitiveDetail) => record.message.includes(sensitiveDetail))
    ),
    false
  );
  assert.ok(
    runtime.records.some(
      (record) => record.level === "verbose" && record.message.includes(itemUrl) && record.message.includes(itemTitle)
    )
  );
  assert.ok(
    runtime.records.some((record) => record.level === "debug" && record.message.includes(rawError))
  );
});

test("an Open Graph rejection with undefined still records fallback and returns the RSS embed", async (t) => {
  // Break caught: using an optional error field as the result discriminant turns
  // Promise.reject(undefined) into a false success, so fallback data is lost.
  const itemUrl = "https://example.test/undefined-rejection";
  const { reader, runtime } = createInstrumentedReader(t, {
    config: { publishEmbed: true, embedType: "card" },
    fetchOpenGraph: async () => Promise.reject(undefined),
  });
  const emitted: any[] = [];
  reader.onItem((item) => emitted.push(item));

  await (reader as any).handleItem({
    title: "RSS fallback title",
    link: itemUrl,
    description: "RSS fallback description",
    pubdate: "2026-08-03T12:01:00.000Z",
  });

  assert.deepEqual(emitted[0].embed, {
    uri: itemUrl,
    title: "RSS fallback title",
    description: "RSS fallback description",
    imageUrl: undefined,
    imageAlt: undefined,
    type: "card",
  });
  const counters = runtime.operations.snapshot().counters;
  assert.equal(counters.openGraphSucceeded, 0);
  assert.equal(counters.openGraphFallback, 1);
});

test("start() attaches an error listener so a feed-fetch failure is logged per-bot, not an uncaught exception", (t) => {
  // Found live in production: FeedSub (a Node EventEmitter) throws an
  // 'error' event as an uncaught exception by default when nothing is
  // listening for it - only caught, previously, by the process-wide safety
  // net rather than handled here. Reproduces by emitting 'error' directly
  // on the real underlying FeedSub instance after start().
  const dir = mkdtempSync(join(tmpdir(), "feedreader-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new BotStore(join(dir, "state.sqlite"));
  t.after(() => store.close());

  const sharedLimiters = new SharedLimiters({
    maxConcurrentOpenGraphFetches: 1,
    maxConcurrentImageJobs: 1,
    maxImageDownloadBytes: 10_000_000,
    httpTimeoutMs: 5000,
  });

  const reader = new FeedReader(
    "test-bot",
    new URL("http://127.0.0.1:1/feed.xml"), // unroutable port, never actually fetched in this test
    5,
    { string: "$title" },
    store,
    sharedLimiters,
    createRuntime()
  );
  t.after(() => reader.stop());
  reader.start();

  assert.doesNotThrow(() => {
    (reader as any).reader.emit("error", new Error("unable to verify the first certificate"));
  });
});

function startFixedResponseServer(body: Buffer): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(body);
    });
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port });
    });
  });
}

test("resolveEmbedImage returns undefined when the response exceeds maxImageDownloadBytes", async (t) => {
  const { server, port } = await startFixedResponseServer(Buffer.alloc(2000));
  t.after(() => server.close());

  const dir = mkdtempSync(join(tmpdir(), "feedreader-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new BotStore(join(dir, "state.sqlite"));
  t.after(() => store.close());

  const sharedLimiters = new SharedLimiters({
    maxConcurrentOpenGraphFetches: 1,
    maxConcurrentImageJobs: 1,
    maxImageDownloadBytes: 1000,
    httpTimeoutMs: 5000,
  });

  const runtime = createRuntime();
  const reader = new FeedReader(
    "test-bot",
    new URL(`http://127.0.0.1:${port}/feed.xml`),
    5,
    { string: "$title" },
    store,
    sharedLimiters,
    runtime
  );

  const result = await reader.resolveEmbedImage(`http://127.0.0.1:${port}/image.jpg`);
  assert.equal(result, undefined);
  assert.ok(runtime.records.some(
    (record) => record.level === "debug" && /image download failed/i.test(record.message)
  ));
  assert.ok(runtime.records.some(
    (record) => record.level === "debug" && /image download completed in \d+ms/i.test(record.message)
  ));
});

test("resolveEmbedImage succeeds when the response is within maxImageDownloadBytes", async (t) => {
  // Must be real, decodable JPEG bytes: resolveEmbedImage feeds the response body
  // through jimp to resize it, and jimp rejects arbitrary/zero-filled bytes as
  // "Could not find MIME for Buffer" regardless of whether the size cap passed.
  const image = await jimp.create(2, 2, 0xff0000ff);
  const imageBuffer = await image.getBufferAsync(jimp.MIME_JPEG);

  const { server, port } = await startFixedResponseServer(imageBuffer);
  t.after(() => server.close());

  const dir = mkdtempSync(join(tmpdir(), "feedreader-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new BotStore(join(dir, "state.sqlite"));
  t.after(() => store.close());

  const sharedLimiters = new SharedLimiters({
    maxConcurrentOpenGraphFetches: 1,
    maxConcurrentImageJobs: 1,
    maxImageDownloadBytes: 10_000_000,
    httpTimeoutMs: 5000,
  });

  const reader = new FeedReader(
    "test-bot",
    new URL(`http://127.0.0.1:${port}/feed.xml`),
    5,
    { string: "$title" },
    store,
    sharedLimiters,
    createRuntime()
  );

  const result = await reader.resolveEmbedImage(`http://127.0.0.1:${port}/image.jpg`);
  assert.ok(result, "a within-cap image should resolve to a Buffer, not undefined");
});
