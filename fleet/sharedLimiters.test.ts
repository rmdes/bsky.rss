import { test } from "node:test";
import assert from "node:assert/strict";
import { ConcurrencyLimiter, SharedLimiters } from "./sharedLimiters.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("ConcurrencyLimiter throws when constructed with a non-positive max", () => {
  assert.throws(() => new ConcurrencyLimiter(0), /max must be >= 1/);
});

test("ConcurrencyLimiter never lets more than `max` callbacks run at once", async () => {
  const limiter = new ConcurrencyLimiter(2);
  let active = 0;
  let peak = 0;

  const task = async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(20);
    active--;
  };

  await Promise.all([
    limiter.run(task),
    limiter.run(task),
    limiter.run(task),
    limiter.run(task),
    limiter.run(task),
  ]);

  assert.equal(peak, 2);
});

test("ConcurrencyLimiter returns each call's own result", async () => {
  const limiter = new ConcurrencyLimiter(1);
  const results = await Promise.all([
    limiter.run(async () => 1),
    limiter.run(async () => 2),
    limiter.run(async () => 3),
  ]);
  assert.deepEqual(results, [1, 2, 3]);
});

test("ConcurrencyLimiter propagates a rejection without blocking later queued calls", async () => {
  const limiter = new ConcurrencyLimiter(1);
  const first = limiter.run(async () => {
    throw new Error("boom");
  });
  const second = limiter.run(async () => "still runs");

  await assert.rejects(first, /boom/);
  assert.equal(await second, "still runs");
});

test("SharedLimiters exposes the configured timeout and image size cap", () => {
  const limiters = new SharedLimiters({
    maxConcurrentOpenGraphFetches: 6,
    maxConcurrentImageJobs: 2,
    maxImageDownloadBytes: 10_000_000,
    httpTimeoutMs: 10_000,
  });
  assert.equal(limiters.httpTimeoutMs, 10_000);
  assert.equal(limiters.maxImageDownloadBytes, 10_000_000);
});

test("SharedLimiters.withOgLimit enforces maxConcurrentOpenGraphFetches independently of withImageLimit", async () => {
  const limiters = new SharedLimiters({
    maxConcurrentOpenGraphFetches: 1,
    maxConcurrentImageJobs: 1,
    maxImageDownloadBytes: 10_000_000,
    httpTimeoutMs: 10_000,
  });
  let ogActive = 0;
  let ogPeak = 0;
  const ogTask = () =>
    limiters.withOgLimit(async () => {
      ogActive++;
      ogPeak = Math.max(ogPeak, ogActive);
      await sleep(20);
      ogActive--;
    });

  await Promise.all([ogTask(), ogTask(), ogTask()]);
  assert.equal(ogPeak, 1);
});
