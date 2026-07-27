import { test } from "node:test";
import assert from "node:assert/strict";
import { removeHTMLTags, decodeHTMLTwice, fixMalformedUrl, parseString } from "./feedReader.ts";

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
