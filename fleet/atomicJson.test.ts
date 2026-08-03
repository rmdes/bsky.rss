import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJsonAtomic } from "./atomicJson.ts";

function tempDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "fleet-atomic-json-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("atomically replaces JSON with mode 0600 and leaves no sibling temp file", (t) => {
  const directory = tempDirectory(t);
  const path = join(directory, "nested", "status.json");

  writePrivateJsonAtomic(path, { generation: 1, complete: true });
  chmodSync(path, 0o644);
  writePrivateJsonAtomic(path, { generation: 2, complete: true });

  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    generation: 2,
    complete: true,
  });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(directory, "nested")), ["status.json"]);
});

test("a serialization failure preserves the existing destination", (t) => {
  const directory = tempDirectory(t);
  const path = join(directory, "status.json");
  const original = "{\"generation\":1}\n";
  writeFileSync(path, original);
  const circular: { self?: unknown } = {};
  circular.self = circular;

  assert.throws(() => writePrivateJsonAtomic(path, circular), /circular/i);
  assert.equal(readFileSync(path, "utf8"), original);
  assert.deepEqual(readdirSync(directory), ["status.json"]);
});

test("a failed rename removes its own temp file without damaging the destination", (t) => {
  const directory = tempDirectory(t);
  const path = join(directory, "status.json");
  const markerPath = join(path, "existing-marker");
  // A non-empty directory cannot be replaced by a file, forcing rename to fail
  // after the sibling temp file has been written and chmodded.
  mkdirSync(path);
  writeFileSync(markerPath, "preserve me");

  assert.throws(() => writePrivateJsonAtomic(path, { generation: 2 }));
  assert.equal(readFileSync(markerPath, "utf8"), "preserve me");
  assert.deepEqual(readdirSync(directory), ["status.json"]);
});
