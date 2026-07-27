import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "./botStore.ts";

function makeStore(): { store: BotStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "botstore-test-"));
  const store = new BotStore(join(dir, "state.sqlite"));
  return { store, dir };
}

function cleanup(store: BotStore, dir: string): void {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

test("readSession returns null before any session is written", () => {
  const { store, dir } = makeStore();
  assert.equal(store.readSession(), null);
  cleanup(store, dir);
});

test("session round-trips through write/read", () => {
  const { store, dir } = makeStore();
  store.writeSession({ accessJwt: "abc", refreshJwt: "def" });
  assert.deepEqual(store.readSession(), { accessJwt: "abc", refreshJwt: "def" });
  cleanup(store, dir);
});

test("writeSession upserts, does not duplicate rows", () => {
  const { store, dir } = makeStore();
  store.writeSession({ a: 1 });
  store.writeSession({ a: 2 });
  assert.deepEqual(store.readSession(), { a: 2 });
  cleanup(store, dir);
});

test("cursor defaults to empty string, then round-trips", () => {
  const { store, dir } = makeStore();
  assert.equal(store.readCursor(), "");
  const date = new Date("2026-01-01T00:00:00.000Z");
  store.writeCursor(date);
  assert.equal(store.readCursor(), date.toISOString());
  cleanup(store, dir);
});

test("writeCursor upserts, does not duplicate rows", () => {
  const { store, dir } = makeStore();
  store.writeCursor(new Date("2026-01-01T00:00:00.000Z"));
  store.writeCursor(new Date("2026-01-02T00:00:00.000Z"));
  assert.equal(store.readCursor(), "2026-01-02T00:00:00.000Z");
  cleanup(store, dir);
});

test("seen_items uses exact match, not substring — a known bug in today's db.txt", () => {
  const { store, dir } = makeStore();
  store.writeSeenValue("https://example.com/a");
  assert.equal(store.seenValueExists("https://example.com/a"), true);
  assert.equal(store.seenValueExists("https://example.com/a-longer"), false);
  assert.equal(store.seenValueExists("example.com/a"), false);
  assert.equal(store.seenValueExists("unrelated"), false);
  cleanup(store, dir);
});

test("writeSeenValue is idempotent — writing the same value twice does not error", () => {
  const { store, dir } = makeStore();
  store.writeSeenValue("dup");
  store.writeSeenValue("dup");
  assert.equal(store.seenValueExists("dup"), true);
  cleanup(store, dir);
});

test("cleanupOldSeenValues removes only entries past the age cutoff", () => {
  const { store, dir } = makeStore();
  store.writeSeenValue("old");
  // Backdate directly — writeSeenValue always stamps "now", so this is the only
  // way to construct an aged row without waiting in real time.
  (store as any).db.prepare(`UPDATE seen_items SET seen_at = ? WHERE value = 'old'`).run(
    new Date(Date.now() - 200 * 3600 * 1000).toISOString()
  );
  store.writeSeenValue("recent");
  store.cleanupOldSeenValues(96);
  assert.equal(store.seenValueExists("old"), false);
  assert.equal(store.seenValueExists("recent"), true);
  cleanup(store, dir);
});
