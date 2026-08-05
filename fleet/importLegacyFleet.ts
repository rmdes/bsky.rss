import {importLegacyFleet} from './legacyImport.ts';

function log(message: string): void {
  console.log(`[${new Date().toUTCString()}] - [bsky.rss IMPORT] ${message}`);
}

// Run on the VPS itself, against the real legacy fleet - stop the legacy
// containers first (e.g. via down.sh) so nothing is writing to db.txt/
// last.txt/persist.json while this reads them. Never logs a secret value:
// only bot ids, identifiers, and error messages ever reach the console.
async function main(): Promise<void> {
  const sourceRoot = process.env.LEGACY_SOURCE_ROOT ?? '/home/skyfleet';
  const targetConfigRoot = process.env.FLEET_TARGET_CONFIG_ROOT ?? '/home/skyfleet-next/config';
  const targetDataRoot = process.env.FLEET_TARGET_DATA_ROOT ?? '/home/skyfleet-next/data/fleet';
  const secretsFilePath =
    process.env.FLEET_TARGET_SECRETS_PATH ?? '/home/skyfleet-next/secrets/bsky-fleet.json';
  const only = process.env.LEGACY_ONLY_BOT
    ? process.env.LEGACY_ONLY_BOT.split(',').map(s => s.trim())
    : undefined;

  log(
    `Importing from ${sourceRoot} into ${targetConfigRoot} (state: ${targetDataRoot})` +
      (only ? ` [only: ${only.join(', ')}]` : ''),
  );

  const {imported, errors} = importLegacyFleet(
    sourceRoot,
    targetConfigRoot,
    targetDataRoot,
    secretsFilePath,
    only,
  );

  log(`Imported ${imported.length} bot(s), ${errors.length} error(s)`);
  for (const bot of imported) log(`  OK   ${bot.botId} (${bot.identifier})`);
  for (const e of errors) log(`  FAIL ${e.botId}: ${e.error}`);

  if (imported.length === 0) {
    log('No bots imported - exiting non-zero');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
