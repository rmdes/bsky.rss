import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportOneBot, exportLegacyFleet } from "./legacyExport.ts";
import { BotStore } from "./botStore.ts";

const RELATIVE_COMPOSE = `services:
  bsky-rss:
    environment:
      - APP_PASSWORD=pw
      - INSTANCE_URL=https://bsky.social
      - FETCH_URL=https://rss.example.com/feed.xml
      - IDENTIFIER=actudroit.skyfleet.blue
    volumes:
      - ./data:/build/data
`;

function setupLegacyBotDir(legacySourceRoot: string, botId: string): string {
  const botDir = join(legacySourceRoot, botId);
  mkdirSync(join(botDir, "data"), { recursive: true });
  writeFileSync(join(botDir, "docker-compose.yml"), RELATIVE_COMPOSE);
  return join(botDir, "data");
}

test("exportOneBot writes persist.json, last.txt, and db.txt back to the resolved legacy data path", (t) => {
  const legacySourceRoot = mkdtempSync(join(tmpdir(), "legacy-export-source-"));
  t.after(() => rmSync(legacySourceRoot, { recursive: true, force: true }));
  const dataRoot = mkdtempSync(join(tmpdir(), "legacy-export-data-"));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));

  const legacyDataPath = setupLegacyBotDir(legacySourceRoot, "actudroit-fr");

  const store = new BotStore(join(dataRoot, "bots", "actudroit-fr", "state.sqlite"));
  store.writeSession({ accessJwt: "a", refreshJwt: "b", handle: "actudroit.skyfleet.blue" });
  store.writeCursor(new Date("2026-07-29T02:00:00.000Z"));
  store.writeSeenValue("https://example.com/a");
  store.writeSeenValue("https://example.com/b");
  store.close();

  const result = exportOneBot(legacySourceRoot, dataRoot, "actudroit-fr");
  assert.equal(result.botId, "actudroit-fr");

  const session = JSON.parse(readFileSync(join(legacyDataPath, "persist.json"), "utf-8"));
  assert.equal(session.handle, "actudroit.skyfleet.blue");

  const cursor = readFileSync(join(legacyDataPath, "last.txt"), "utf-8");
  assert.equal(cursor, "2026-07-29T02:00:00.000Z");

  const dbTxt = readFileSync(join(legacyDataPath, "db.txt"), "utf-8");
  assert.match(dbTxt, /\|https:\/\/example\.com\/a$/m);
  assert.match(dbTxt, /\|https:\/\/example\.com\/b$/m);
});

test("exportOneBot resolves an absolute shared-volume data path correctly", (t) => {
  const legacySourceRoot = mkdtempSync(join(tmpdir(), "legacy-export-source-"));
  t.after(() => rmSync(legacySourceRoot, { recursive: true, force: true }));
  const dataRoot = mkdtempSync(join(tmpdir(), "legacy-export-data-"));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));

  const sharedDataDir = join(legacySourceRoot, "shared-trump-data");
  mkdirSync(sharedDataDir, { recursive: true });
  const botDir = join(legacySourceRoot, "trumpnews-en");
  mkdirSync(botDir, { recursive: true });
  writeFileSync(
    join(botDir, "docker-compose.yml"),
    RELATIVE_COMPOSE.replace("./data:/build/data", `${sharedDataDir}:/build/data`)
  );

  const store = new BotStore(join(dataRoot, "bots", "trumpnews-en", "state.sqlite"));
  store.writeCursor(new Date("2026-07-29T00:00:00.000Z"));
  store.close();

  exportOneBot(legacySourceRoot, dataRoot, "trumpnews-en");
  assert.ok(existsSync(join(sharedDataDir, "last.txt")));
});

test("exportLegacyFleet isolates one bot's export failure without affecting the rest", (t) => {
  const legacySourceRoot = mkdtempSync(join(tmpdir(), "legacy-export-source-"));
  t.after(() => rmSync(legacySourceRoot, { recursive: true, force: true }));
  const dataRoot = mkdtempSync(join(tmpdir(), "legacy-export-data-"));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));

  setupLegacyBotDir(legacySourceRoot, "bot-good");
  new BotStore(join(dataRoot, "bots", "bot-good", "state.sqlite")).close();
  // bot-bad: no docker-compose.yml at all, so resolving its data path must fail

  const result = exportLegacyFleet(legacySourceRoot, dataRoot, ["bot-good", "bot-bad"]);

  assert.equal(result.exported.length, 1);
  assert.equal(result.exported[0]!.botId, "bot-good");
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.botId, "bot-bad");
});

test("exportOneBot refuses to export a bot with no fleet state, leaving legacy db.txt untouched", (t) => {
  const legacySourceRoot = mkdtempSync(join(tmpdir(), "legacy-export-source-"));
  t.after(() => rmSync(legacySourceRoot, { recursive: true, force: true }));
  const dataRoot = mkdtempSync(join(tmpdir(), "legacy-export-data-"));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));

  const legacyDataPath = setupLegacyBotDir(legacySourceRoot, "no-fleet-state");
  const originalDbTxt = "2026-07-01T00:00:00.000Z|https://example.com/real-history\n";
  writeFileSync(join(legacyDataPath, "db.txt"), originalDbTxt);
  // Deliberately no state.sqlite under dataRoot/bots/no-fleet-state/ - the fleet never ran this bot.

  const result = exportLegacyFleet(legacySourceRoot, dataRoot, ["no-fleet-state"]);

  assert.equal(result.exported.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.botId, "no-fleet-state");

  const dbTxtAfter = readFileSync(join(legacyDataPath, "db.txt"), "utf-8");
  assert.equal(dbTxtAfter, originalDbTxt);
});
