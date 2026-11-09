// `yarn fleet:reload <bot-id> | --all`: asks the running fleet to reload one bot (or every bot)
// from its config files. The fleet's config reconciler applies it within ~10 s.
import {basename} from 'node:path';
import {listBotIds} from './botFingerprint.ts';
import {addReloadRequest, reloadRequestsPath} from './reloadRequests.ts';

const usage = (executable: string): string =>
  [`Usage: ${executable} <bot-id>`, `       ${executable} --all`].join('\n');

export function runReloadControl(
  args: string[],
  options: {configRoot: string; dataRoot: string},
): string {
  const path = reloadRequestsPath(options.dataRoot);
  if (args.length === 1 && args[0] === '--all') {
    addReloadRequest(path, '*');
    return 'reload requested for all bots; applied within ~10s';
  }
  if (args.length === 1 && args[0] && !args[0].startsWith('-')) {
    const botId = args[0];
    if (!listBotIds(options.configRoot).includes(botId)) {
      throw new Error(`Unknown bot "${botId}" (no directory in ${options.configRoot}/bots)`);
    }
    addReloadRequest(path, botId);
    return `reload requested for ${botId}; applied within ~10s`;
  }
  throw new Error(usage('fleet:reload'));
}

if (import.meta.main) {
  try {
    console.log(
      runReloadControl(process.argv.slice(2), {
        configRoot: process.env.FLEET_CONFIG_ROOT ?? './config.example',
        dataRoot: process.env.FLEET_DATA_ROOT ?? './data/fleet',
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage(basename(process.argv[1] ?? 'reloadControl.ts')));
    process.exitCode = 1;
  }
}
