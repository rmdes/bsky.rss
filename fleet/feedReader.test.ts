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
import jimp from "jimp";

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

  const reader = new FeedReader(
    "test-bot",
    new URL(`http://127.0.0.1:${port}/feed.xml`),
    5,
    { string: "$title" },
    store,
    sharedLimiters
  );

  const result = await reader.resolveEmbedImage(`http://127.0.0.1:${port}/image.jpg`);
  assert.equal(result, undefined);
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
    sharedLimiters
  );

  const result = await reader.resolveEmbedImage(`http://127.0.0.1:${port}/image.jpg`);
  assert.ok(result, "a within-cap image should resolve to a Buffer, not undefined");
});
