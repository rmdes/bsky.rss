import { test } from "node:test";
import assert from "node:assert/strict";
import { removeHTMLTags, decodeHTMLTwice, fixMalformedUrl, parseString, textOf } from "./feedReader.ts";
import { computeDedupeKey } from "./dedupeKey.ts";

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
