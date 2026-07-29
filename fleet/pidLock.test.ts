import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock, isLockedByLiveProcess } from "./pidLock.ts";

function tempLockPath(t: any): string {
  const dir = mkdtempSync(join(tmpdir(), "pidlock-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "fleet.pid");
}

test("isLockedByLiveProcess is false when no lock file exists", (t) => {
  assert.equal(isLockedByLiveProcess(tempLockPath(t)), false);
});

test("acquireLock writes this process's own PID and does not throw", (t) => {
  const lockPath = tempLockPath(t);
  acquireLock(lockPath);
  assert.equal(readFileSync(lockPath, "utf-8").trim(), String(process.pid));
});

test("acquireLock throws when the lock file holds a live process's PID", (t) => {
  const lockPath = tempLockPath(t);
  writeFileSync(lockPath, String(process.pid)); // this test process is definitely alive
  assert.throws(() => acquireLock(lockPath), /live process/);
});

test("acquireLock succeeds and overwrites a stale lock from a dead PID", (t) => {
  const lockPath = tempLockPath(t);
  // ponytail: no real PID is guaranteed dead in a test process; an offset far
  // outside this process's own PID is the standard, practically-safe convention
  // for "almost certainly not a real running process" in a lock-file test.
  const staleDeadPid = process.pid + 999_000;
  writeFileSync(lockPath, String(staleDeadPid));
  acquireLock(lockPath);
  assert.equal(readFileSync(lockPath, "utf-8").trim(), String(process.pid));
});

test("isLockedByLiveProcess reflects a live lock and releaseLock clears it", (t) => {
  const lockPath = tempLockPath(t);
  acquireLock(lockPath);
  assert.equal(isLockedByLiveProcess(lockPath), true);
  releaseLock(lockPath);
  assert.equal(existsSync(lockPath), false);
  assert.equal(isLockedByLiveProcess(lockPath), false);
});

test("releaseLock is a no-op when no lock file exists", (t) => {
  const lockPath = tempLockPath(t);
  assert.doesNotThrow(() => releaseLock(lockPath));
});
