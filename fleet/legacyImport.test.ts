import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseComposeEnv, resolveDataPath, importOneBot, importLegacyFleet } from "./legacyImport.ts";
import { BotStore } from "./botStore.ts";

const RELATIVE_COMPOSE = `services:
  bsky-rss:
    restart: unless-stopped
    image: bsky.rss:post-interval
    container_name: bsky-rss-actudroit-fr
    environment:
      - APP_PASSWORD=real-password-value
      - INSTANCE_URL=https://bsky.social
      - FETCH_URL=https://rss.example.com/feed.xml
      - IDENTIFIER=actudroit.skyfleet.blue
    volumes:
      - ./data:/build/data
    networks:
      - mediafr_default
networks:
  mediafr_default:
    external: true
`;

const ABSOLUTE_VOLUME_COMPOSE = `services:
  bsky-rss:
    restart: unless-stopped
    image: bsky.rss:post-interval
    container_name: bsky-rss-trumpnews-en
    environment:
      - APP_PASSWORD=shared-password-value
      - INSTANCE_URL=https://bsky.social
      - FETCH_URL=https://rss.example.com/trump.xml
      - IDENTIFIER=trumpwatch.skyfleet.blue
    volumes:
      - /home/skyfleet/shared-trump-data:/build/data
    networks:
      - mediafr_default
`;

function setupSource(): { sourceRoot: string; cleanup: () => void } {
  const sourceRoot = mkdtempSync(join(tmpdir(), "legacy-import-test-"));
  return { sourceRoot, cleanup: () => rmSync(sourceRoot, { recursive: true, force: true }) };
}

function writeLegacyBot(
  sourceRoot: string,
  botId: string,
  composeYaml: string,
  config: Record<string, unknown>,
  opts?: { dbTxt?: string; lastTxt?: string; persistJson?: Record<string, unknown> }
): void {
  const botDir = join(sourceRoot, botId);
  mkdirSync(join(botDir, "data"), { recursive: true });
  writeFileSync(join(botDir, "docker-compose.yml"), composeYaml);
  writeFileSync(join(botDir, "data", "config.json"), JSON.stringify(config));
  if (opts?.dbTxt !== undefined) writeFileSync(join(botDir, "data", "db.txt"), opts.dbTxt);
  if (opts?.lastTxt !== undefined) writeFileSync(join(botDir, "data", "last.txt"), opts.lastTxt);
  if (opts?.persistJson !== undefined) {
    writeFileSync(join(botDir, "data", "persist.json"), JSON.stringify(opts.persistJson));
  }
}

test("parseComposeEnv extracts identifier/appPassword/instanceUrl/feedUrl from the environment list", () => {
  const env = parseComposeEnv(RELATIVE_COMPOSE);
  assert.equal(env.identifier, "actudroit.skyfleet.blue");
  assert.equal(env.appPassword, "real-password-value");
  assert.equal(env.instanceUrl, "https://bsky.social");
  assert.equal(env.feedUrl, "https://rss.example.com/feed.xml");
});

test("parseComposeEnv defaults fetchIntervalMinutes to 5 when FETCH_INTERVAL is absent", () => {
  const env = parseComposeEnv(RELATIVE_COMPOSE);
  assert.equal(env.fetchIntervalMinutes, 5);
});

test("parseComposeEnv respects an explicit FETCH_INTERVAL override", () => {
  const withOverride = RELATIVE_COMPOSE.replace(
    "- IDENTIFIER=actudroit.skyfleet.blue",
    "- IDENTIFIER=actudroit.skyfleet.blue\n      - FETCH_INTERVAL=10"
  );
  const env = parseComposeEnv(withOverride);
  assert.equal(env.fetchIntervalMinutes, 10);
});

test("parseComposeEnv throws when a required env var is missing", () => {
  const broken = RELATIVE_COMPOSE.replace("- APP_PASSWORD=real-password-value\n", "");
  assert.throws(() => parseComposeEnv(broken), /APP_PASSWORD/);
});

test("resolveDataPath resolves a relative ./data mount against the bot's own directory", () => {
  const dataPath = resolveDataPath(RELATIVE_COMPOSE, "/home/skyfleet/actudroit-fr");
  assert.equal(dataPath, join("/home/skyfleet/actudroit-fr", "data"));
});

test("resolveDataPath resolves an absolute external volume mount unchanged", () => {
  const dataPath = resolveDataPath(ABSOLUTE_VOLUME_COMPOSE, "/home/skyfleet/trumpnews-en");
  assert.equal(dataPath, "/home/skyfleet/shared-trump-data");
});

test("importOneBot writes bot.json and config.json, stripping the dead publishDate field", (t) => {
  const { sourceRoot, cleanup } = setupSource();
  t.after(cleanup);
  const targetRoot = mkdtempSync(join(tmpdir(), "legacy-import-target-"));
  t.after(() => rmSync(targetRoot, { recursive: true, force: true }));
  const configRoot = join(targetRoot, "config");
  const dataRoot = join(targetRoot, "data", "fleet");

  writeLegacyBot(sourceRoot, "actudroit-fr", RELATIVE_COMPOSE, {
    string: "$title",
    publishEmbed: true,
    languages: ["fr"],
    publishDate: false,
    runInterval: 60,
  });

  const secrets: Record<string, string> = {};
  const result = importOneBot(sourceRoot, configRoot, dataRoot, "actudroit-fr", secrets);

  assert.equal(result.botId, "actudroit-fr");
  assert.equal(result.identifier, "actudroit.skyfleet.blue");
  assert.equal(secrets["actudroit-fr"], "real-password-value");

  const botJson = JSON.parse(readFileSync(join(configRoot, "bots", "actudroit-fr", "bot.json"), "utf-8"));
  assert.deepEqual(botJson, {
    id: "actudroit-fr",
    enabled: true,
    identifier: "actudroit.skyfleet.blue",
    instanceUrl: "https://bsky.social",
    feedUrl: "https://rss.example.com/feed.xml",
    secretKey: "actudroit-fr",
    fetchIntervalMinutes: 5,
  });

  const configJson = JSON.parse(readFileSync(join(configRoot, "bots", "actudroit-fr", "config.json"), "utf-8"));
  assert.equal(configJson.string, "$title");
  assert.equal(configJson.publishEmbed, true);
  assert.deepEqual(configJson.languages, ["fr"]);
  assert.equal("publishDate" in configJson, false, "publishDate must be stripped, not carried over");
});

test("importOneBot migrates db.txt, last.txt, and persist.json into a fresh state.sqlite", (t) => {
  const { sourceRoot, cleanup } = setupSource();
  t.after(cleanup);
  const targetRoot = mkdtempSync(join(tmpdir(), "legacy-import-target-"));
  t.after(() => rmSync(targetRoot, { recursive: true, force: true }));
  const configRoot = join(targetRoot, "config");
  const dataRoot = join(targetRoot, "data", "fleet");

  writeLegacyBot(
    sourceRoot,
    "actudroit-fr",
    RELATIVE_COMPOSE,
    { string: "$title" },
    {
      dbTxt: [
        "2026-07-25T04:05:40.938Z|https://example.com/a",
        "2026-07-25T04:05:40.939Z|https://example.com/b",
      ].join("\n"),
      lastTxt: "2026-07-29T02:00:00.000Z",
      persistJson: { accessJwt: "fake-access", refreshJwt: "fake-refresh", handle: "actudroit.skyfleet.blue" },
    }
  );

  importOneBot(sourceRoot, configRoot, dataRoot, "actudroit-fr", {});

  const dbPath = join(dataRoot, "bots", "actudroit-fr", "state.sqlite");
  assert.ok(existsSync(dbPath));

  const store = new BotStore(dbPath);
  try {
    assert.equal(store.readCursor(), "2026-07-29T02:00:00.000Z");
    assert.equal(store.seenValueExists("https://example.com/a"), true);
    assert.equal(store.seenValueExists("https://example.com/b"), true);
    assert.equal(store.seenValueExists("https://example.com/never-seen"), false);
    const session = store.readSession<{ handle: string }>();
    assert.equal(session?.handle, "actudroit.skyfleet.blue");
  } finally {
    store.close();
  }
});

test("importOneBot resolves the absolute shared-volume data path correctly", (t) => {
  const { sourceRoot, cleanup } = setupSource();
  t.after(cleanup);
  const targetRoot = mkdtempSync(join(tmpdir(), "legacy-import-target-"));
  t.after(() => rmSync(targetRoot, { recursive: true, force: true }));

  // The shared volume lives outside the bot's own directory - simulate that here.
  const sharedDataDir = join(sourceRoot, "shared-trump-data");
  mkdirSync(sharedDataDir, { recursive: true });
  writeFileSync(join(sharedDataDir, "config.json"), JSON.stringify({ string: "$title" }));

  const composeForThisFixture = ABSOLUTE_VOLUME_COMPOSE.replace(
    "/home/skyfleet/shared-trump-data",
    sharedDataDir
  );
  const botDir = join(sourceRoot, "trumpnews-en");
  mkdirSync(botDir, { recursive: true });
  writeFileSync(join(botDir, "docker-compose.yml"), composeForThisFixture);

  const configRoot = join(targetRoot, "config");
  const dataRoot = join(targetRoot, "data", "fleet");
  const result = importOneBot(sourceRoot, configRoot, dataRoot, "trumpnews-en", {});

  assert.equal(result.identifier, "trumpwatch.skyfleet.blue");
  const configJson = JSON.parse(
    readFileSync(join(configRoot, "bots", "trumpnews-en", "config.json"), "utf-8")
  );
  assert.equal(configJson.string, "$title");
});

test("importOneBot is idempotent: re-running with changed legacy data fully replaces prior output, no stale rows", (t) => {
  const { sourceRoot, cleanup } = setupSource();
  t.after(cleanup);
  const targetRoot = mkdtempSync(join(tmpdir(), "legacy-import-target-"));
  t.after(() => rmSync(targetRoot, { recursive: true, force: true }));
  const configRoot = join(targetRoot, "config");
  const dataRoot = join(targetRoot, "data", "fleet");

  writeLegacyBot(sourceRoot, "actudroit-fr", RELATIVE_COMPOSE, { string: "$title" }, {
    dbTxt: "2026-07-25T04:05:40.938Z|https://example.com/old-only",
    lastTxt: "2026-07-28T00:00:00.000Z",
  });
  importOneBot(sourceRoot, configRoot, dataRoot, "actudroit-fr", {});

  // Simulate a fresh import run after the legacy source has moved on.
  writeLegacyBot(sourceRoot, "actudroit-fr", RELATIVE_COMPOSE, { string: "$title - $link" }, {
    dbTxt: "2026-07-29T04:05:40.938Z|https://example.com/new-only",
    lastTxt: "2026-07-29T02:00:00.000Z",
  });
  importOneBot(sourceRoot, configRoot, dataRoot, "actudroit-fr", {});

  const configJson = JSON.parse(
    readFileSync(join(configRoot, "bots", "actudroit-fr", "config.json"), "utf-8")
  );
  assert.equal(configJson.string, "$title - $link");

  const store = new BotStore(join(dataRoot, "bots", "actudroit-fr", "state.sqlite"));
  try {
    assert.equal(store.readCursor(), "2026-07-29T02:00:00.000Z");
    assert.equal(store.seenValueExists("https://example.com/new-only"), true);
    assert.equal(
      store.seenValueExists("https://example.com/old-only"),
      false,
      "a re-run must not accumulate stale seen_items from the prior run"
    );
  } finally {
    store.close();
  }
});

test("importLegacyFleet skips a directory with no docker-compose.yml (not an independent bot)", (t) => {
  const { sourceRoot, cleanup } = setupSource();
  t.after(cleanup);
  const targetRoot = mkdtempSync(join(tmpdir(), "legacy-import-target-"));
  t.after(() => rmSync(targetRoot, { recursive: true, force: true }));

  writeLegacyBot(sourceRoot, "actudroit-fr", RELATIVE_COMPOSE, { string: "$title" });
  // A directory with no docker-compose.yml - like the bsky.rss checkout or a shared data dir.
  mkdirSync(join(sourceRoot, "shared-trump-data"), { recursive: true });
  writeFileSync(join(sourceRoot, "shared-trump-data", "config.json"), JSON.stringify({ string: "x" }));

  const result = importLegacyFleet(
    sourceRoot,
    join(targetRoot, "config"),
    join(targetRoot, "data", "fleet"),
    join(targetRoot, "secrets", "bsky-fleet.json")
  );

  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0]!.botId, "actudroit-fr");
  assert.equal(result.errors.length, 0);
});

test("importLegacyFleet isolates one malformed bot directory as an error without affecting the rest", (t) => {
  const { sourceRoot, cleanup } = setupSource();
  t.after(cleanup);
  const targetRoot = mkdtempSync(join(tmpdir(), "legacy-import-target-"));
  t.after(() => rmSync(targetRoot, { recursive: true, force: true }));

  writeLegacyBot(sourceRoot, "bot-good", RELATIVE_COMPOSE, { string: "$title" });
  mkdirSync(join(sourceRoot, "bot-bad"), { recursive: true });
  writeFileSync(join(sourceRoot, "bot-bad", "docker-compose.yml"), "not: valid: for: parsing:::");

  const result = importLegacyFleet(
    sourceRoot,
    join(targetRoot, "config"),
    join(targetRoot, "data", "fleet"),
    join(targetRoot, "secrets", "bsky-fleet.json")
  );

  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0]!.botId, "bot-good");
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.botId, "bot-bad");
});

test("importLegacyFleet writes all imported bots' passwords into one secrets file", (t) => {
  const { sourceRoot, cleanup } = setupSource();
  t.after(cleanup);
  const targetRoot = mkdtempSync(join(tmpdir(), "legacy-import-target-"));
  t.after(() => rmSync(targetRoot, { recursive: true, force: true }));

  writeLegacyBot(sourceRoot, "actudroit-fr", RELATIVE_COMPOSE, { string: "$title" });
  const secretsFilePath = join(targetRoot, "secrets", "bsky-fleet.json");

  importLegacyFleet(sourceRoot, join(targetRoot, "config"), join(targetRoot, "data", "fleet"), secretsFilePath);

  const secrets = JSON.parse(readFileSync(secretsFilePath, "utf-8"));
  assert.equal(secrets["actudroit-fr"], "real-password-value");
});

test("importLegacyFleet's --only filter merges into an existing secrets file instead of overwriting it", (t) => {
  const { sourceRoot, cleanup } = setupSource();
  t.after(cleanup);
  const targetRoot = mkdtempSync(join(tmpdir(), "legacy-import-target-"));
  t.after(() => rmSync(targetRoot, { recursive: true, force: true }));

  writeLegacyBot(sourceRoot, "bot-a", RELATIVE_COMPOSE, { string: "$title" });
  const composeForBotB = RELATIVE_COMPOSE.replace("real-password-value", "bot-b-password").replace(
    "actudroit.skyfleet.blue",
    "bot-b.skyfleet.blue"
  );
  writeLegacyBot(sourceRoot, "bot-b", composeForBotB, { string: "$title" });
  const secretsFilePath = join(targetRoot, "secrets", "bsky-fleet.json");

  importLegacyFleet(sourceRoot, join(targetRoot, "config"), join(targetRoot, "data", "fleet"), secretsFilePath);
  // Re-run for just bot-a - bot-b's already-imported secret must survive untouched.
  const result = importLegacyFleet(
    sourceRoot,
    join(targetRoot, "config"),
    join(targetRoot, "data", "fleet"),
    secretsFilePath,
    ["bot-a"]
  );

  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0]!.botId, "bot-a");

  const secrets = JSON.parse(readFileSync(secretsFilePath, "utf-8"));
  assert.equal(secrets["bot-a"], "real-password-value");
  assert.equal(secrets["bot-b"], "bot-b-password", "an --only run must not drop other bots' existing secrets");
});
