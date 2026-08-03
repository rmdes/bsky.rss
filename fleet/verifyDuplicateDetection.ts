import "dotenv/config";
import { BotStore } from "./botStore.ts";
import { BskyClient } from "./bskyClient.ts";
import { FleetLogger } from "./logging.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

async function main(): Promise<void> {
  console.log(
    "=== Duplicate-detection verification ===\n" +
      "This will create ONE real post on the account below, then attempt to create a\n" +
      "second post with the exact same record key, and print the raw error it gets\n" +
      "back. It then deletes the test post. Use a throwaway or clearly-labeled test\n" +
      "account you don't mind posting a visible (briefly) test post to - do NOT run\n" +
      "this against a live production newsbot account.\n"
  );

  const identifier = env("VERIFY_IDENTIFIER");
  const password = env("VERIFY_APP_PASSWORD");
  const instanceUrl = env("VERIFY_INSTANCE_URL");

  const store = new BotStore("./data/verify-duplicate-detection.sqlite");
  const client = new BskyClient("verify-script", instanceUrl, store, new FleetLogger({ defaultLevel: "debug" }), false);
  await client.login(identifier, password);

  const testRkey = `dupe-test-${Date.now()}`;
  console.log(`Using test rkey: ${testRkey}`);

  console.log("\n--- First create (expected to succeed) ---");
  const first = await client.post({
    content: `bsky.rss duplicate-detection test post, safe to ignore/delete (${testRkey})`,
    rkey: testRkey,
  });
  console.log("Result:", first);

  if (!first.ok) {
    console.log("First create failed unexpectedly - aborting, nothing to compare against.");
    store.close();
    return;
  }

  console.log("\n--- Second create with the SAME rkey (expected to fail - this is what we're inspecting) ---");
  // Bypass BskyClient's own error handling here so we can see the RAW error shape,
  // not BskyClient's already-classified result - that's the whole point of this script.
  const agent = (client as any).agent;
  try {
    const result = await agent.app.bsky.feed.post.create(
      { repo: agent.accountDid, rkey: testRkey },
      { $type: "app.bsky.feed.post", text: "duplicate attempt", createdAt: new Date().toISOString() }
    );
    console.log("UNEXPECTED: second create succeeded (overwrote?). Result:", result);
  } catch (error: any) {
    console.log("Raw error caught. Inspect every field below:");
    console.log("  error.constructor.name:", error?.constructor?.name);
    console.log("  error.status:", error?.status);
    console.log("  error.error:", error?.error);
    console.log("  error.message:", error?.message);
    console.log("  error.headers:", error?.headers);
    console.log("  JSON.stringify(error):", JSON.stringify(error, Object.getOwnPropertyNames(error)));
  }

  console.log("\n--- Cleaning up: deleting the test post ---");
  if (first.uri) {
    try {
      await agent.app.bsky.feed.post.delete({ repo: agent.accountDid, rkey: testRkey });
      console.log("Test post deleted.");
    } catch (err) {
      console.log(`Could not auto-delete test post (rkey ${testRkey}) - delete it manually. Error:`, err);
    }
  }

  store.close();
  console.log(
    "\n=== Next step ===\n" +
      "Compare the printed error shape above against fleet/bskyClient.ts's isAlreadyExistsError.\n" +
      "If the shape is reliable (present across multiple runs, not dependent on timing), update\n" +
      "isAlreadyExistsError to match it, add a unit test asserting that exact shape classifies as\n" +
      "true, and get that change reviewed like any other - it changes production duplicate-safety\n" +
      "behavior and deserves the same scrutiny as the rest of this phase."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
