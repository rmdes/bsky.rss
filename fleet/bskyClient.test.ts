import { test } from "node:test";
import assert from "node:assert/strict";
import { XRPCError, ResponseType } from "@atproto/xrpc";
import { classifyPostError, isAlreadyExistsError } from "./bskyClient.ts";

function makeXRPCError(status: number, headers?: Record<string, string>): XRPCError {
  const err = new XRPCError(status, "TestError", "test error");
  (err as any).headers = headers;
  return err;
}

test("classifies a 429 with a lowercase retry-after header (the real-world shape)", () => {
  const err = makeXRPCError(ResponseType.RateLimitExceeded, { "retry-after": "45" });
  const result = classifyPostError(err);
  assert.equal(result.ratelimit, true);
  assert.equal(result.retryAfterSeconds, 45);
});

test("classifies a 504 the same way as a 429", () => {
  const err = makeXRPCError(ResponseType.UpstreamTimeout, { "retry-after": "12" });
  const result = classifyPostError(err);
  assert.equal(result.ratelimit, true);
  assert.equal(result.retryAfterSeconds, 12);
});

test("falls back to 30s when a rate-limit status has no retry-after header", () => {
  const err = makeXRPCError(ResponseType.RateLimitExceeded, {});
  const result = classifyPostError(err);
  assert.equal(result.ratelimit, true);
  assert.equal(result.retryAfterSeconds, 30);
});

test("a non-rate-limit XRPCError is an uncertain outcome, not a rate limit", () => {
  const err = makeXRPCError(ResponseType.InvalidRequest, { "retry-after": "999" });
  const result = classifyPostError(err);
  assert.equal(result.ratelimit, false);
  assert.equal(result.retryAfterSeconds, 30);
});

test("a non-XRPCError exception (network error, etc.) is an uncertain outcome, not a rate limit", () => {
  const result = classifyPostError(new Error("ECONNRESET"));
  assert.equal(result.ratelimit, false);
  assert.equal(result.retryAfterSeconds, 30);
});

test("ignores a non-numeric retry-after value and falls back to 30s", () => {
  const err = makeXRPCError(ResponseType.RateLimitExceeded, { "retry-after": "not-a-number" });
  const result = classifyPostError(err);
  assert.equal(result.retryAfterSeconds, 30);
});

test("isAlreadyExistsError is deliberately conservative — returns false for any input today", () => {
  // No real PDS response shape has been empirically verified yet (see Task 6 in the
  // Phase 2 plan). This test documents and locks in the intentional fail-safe default:
  // until a real "already exists" error shape is confirmed, every createRecord failure
  // is treated as genuinely uncertain, never as a confirmed duplicate.
  assert.equal(isAlreadyExistsError(new Error("anything")), false);
  assert.equal(isAlreadyExistsError(makeXRPCError(ResponseType.InvalidRequest)), false);
  assert.equal(isAlreadyExistsError(undefined), false);
  assert.equal(isAlreadyExistsError({ status: 400, error: "AlreadyExists" }), false);
});
