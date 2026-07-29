// fleet/exportLegacyFleet.ts
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { exportLegacyFleet } from "./legacyExport.ts";
import { isLockedByLiveProcess } from "./pidLock.ts";

function log(message: string): void {
  console.log(`[${new Date().toUTCString()}] - [bsky.rss EXPORT] ${message}`);
}

async function main(): Promise<void> {
  const legacySourceRoot = process.env.LEGACY_SOURCE_ROOT ?? "/home/skyfleet";
  const dataRoot = process.env.FLEET_TARGET_DATA_ROOT ?? "/home/skyfleet-next/data/fleet";
  const lockFilePath = process.env.FLEET_LOCK_PATH ?? "/home/skyfleet-next/data/fleet/fleet.pid";
  const only = process.env.LEGACY_ONLY_BOT
    ? process.env.LEGACY_ONLY_BOT.split(",").map((s) => s.trim())
    : undefined;

  if (isLockedByLiveProcess(lockFilePath)) {
    log(
      `Refusing to run: fleet daemon lock at ${lockFilePath} is held by a live process. Stop the fleet daemon first (never run both publishers simultaneously).`
    );
    process.exit(1);
  }

  const botIds = only ?? readdirSync(join(dataRoot, "bots"));

  log(`Exporting ${botIds.length} bot(s) from ${dataRoot} back to ${legacySourceRoot}`);
  const { exported, errors } = exportLegacyFleet(legacySourceRoot, dataRoot, botIds);

  log(`Exported ${exported.length} bot(s), ${errors.length} error(s)`);
  for (const bot of exported) log(`  OK   ${bot.botId}`);
  for (const e of errors) log(`  FAIL ${e.botId}: ${e.error}`);

  if (exported.length === 0 && botIds.length > 0) {
    log("No bots exported - exiting non-zero");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
