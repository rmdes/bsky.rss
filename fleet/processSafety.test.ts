import { test } from "node:test";
import assert from "node:assert/strict";
import { installProcessSafetyNet } from "./processSafety.ts";

test("installProcessSafetyNet does not stack duplicate listeners when called more than once", () => {
  const before = process.listenerCount("unhandledRejection");
  installProcessSafetyNet();
  installProcessSafetyNet();
  const after = process.listenerCount("unhandledRejection");
  assert.equal(after, before + 1, "a second install must not add a second listener");
});

test("installProcessSafetyNet installs an unhandledRejection listener that does not exit the process", () => {
  installProcessSafetyNet();
  const listenersBefore = process.listenerCount("unhandledRejection");
  assert.ok(listenersBefore >= 1);

  let exited = false;
  const originalExit = process.exit;
  (process as any).exit = () => {
    exited = true;
  };

  // Save and remove test framework's listeners to avoid false test failure from synthetic event
  const allListeners = process.listeners("unhandledRejection");
  const testFrameworkListeners = allListeners.filter((l) => {
    const str = l.toString();
    return !str.includes("bsky.rss") && !str.includes("synthetic");
  });

  try {
    // Temporarily remove test framework's listeners
    testFrameworkListeners.forEach((l) => process.removeListener("unhandledRejection", l));

    process.emit("unhandledRejection", new Error("synthetic rejection for test"), Promise.resolve());
  } finally {
    // Restore test framework's listeners
    testFrameworkListeners.forEach((l) => process.on("unhandledRejection", l));
    process.exit = originalExit;
  }
  assert.equal(exited, false, "the handler must not call process.exit()");
});

test("installProcessSafetyNet installs an uncaughtException listener that does not exit the process", () => {
  installProcessSafetyNet();
  const listenersBefore = process.listenerCount("uncaughtException");
  assert.ok(listenersBefore >= 1);

  let exited = false;
  const originalExit = process.exit;
  (process as any).exit = () => {
    exited = true;
  };

  // Save and remove test framework's listeners to avoid false test failure from synthetic event
  const allListeners = process.listeners("uncaughtException");
  const testFrameworkListeners = allListeners.filter((l) => {
    const str = l.toString();
    return !str.includes("bsky.rss") && !str.includes("synthetic");
  });

  try {
    // Temporarily remove test framework's listeners
    testFrameworkListeners.forEach((l) => process.removeListener("uncaughtException", l));

    process.emit("uncaughtException", new Error("synthetic exception for test"));
  } finally {
    // Restore test framework's listeners
    testFrameworkListeners.forEach((l) => process.on("uncaughtException", l));
    process.exit = originalExit;
  }
  assert.equal(exited, false, "the handler must not call process.exit()");
});
