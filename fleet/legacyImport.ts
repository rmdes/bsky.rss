import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import {join, dirname, isAbsolute} from 'node:path';
import {BotStore} from './botStore.ts';

export interface ParsedComposeEnv {
  identifier: string;
  appPassword: string;
  instanceUrl: string;
  feedUrl: string;
  fetchIntervalMinutes: number;
}

export interface ImportedBot {
  botId: string;
  identifier: string;
}

export interface ImportError {
  botId: string;
  error: string;
}

export interface ImportResult {
  imported: ImportedBot[];
  errors: ImportError[];
}

const DEFAULT_FETCH_INTERVAL_MINUTES = 5;

// docker-compose.yml's environment/volumes lists are simple, consistent
// `- KEY: value` / `- KEY=value` sequences in this fleet - a full YAML parser
// is unnecessary machinery for a shape this constrained.
function extractListSection(yaml: string, key: string): string[] {
  const lines = yaml.split('\n');
  const startIndex = lines.findIndex(line => line.trim() === `${key}:`);
  if (startIndex === -1) return [];
  const sectionIndent = lines[startIndex]!.match(/^(\s*)/)![1]!.length;
  const items: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const indent = line.match(/^(\s*)/)![1]!.length;
    if (indent <= sectionIndent) break;
    items.push(line.trim());
  }
  return items;
}

export function parseComposeEnv(composeYaml: string): ParsedComposeEnv {
  const envLines = extractListSection(composeYaml, 'environment');
  const env: Record<string, string> = {};
  for (const line of envLines) {
    const match = line.match(/^-\s*([A-Z_]+)=(.*)$/);
    if (match) env[match[1]!] = match[2]!;
  }

  const identifier = env.IDENTIFIER;
  const appPassword = env.APP_PASSWORD;
  const instanceUrl = env.INSTANCE_URL;
  const feedUrl = env.FETCH_URL;
  if (!identifier || !appPassword || !instanceUrl || !feedUrl) {
    throw new Error(
      'docker-compose.yml is missing one of IDENTIFIER/APP_PASSWORD/INSTANCE_URL/FETCH_URL',
    );
  }

  const fetchIntervalMinutes = env.FETCH_INTERVAL
    ? Number(env.FETCH_INTERVAL)
    : DEFAULT_FETCH_INTERVAL_MINUTES;

  return {identifier, appPassword, instanceUrl, feedUrl, fetchIntervalMinutes};
}

// Most bots mount `./data` (relative to their own directory); a few mount an
// absolute external path shared with another bot (e.g. shared-trump-data).
// Reading the real declared mapping handles both without special-casing.
export function resolveDataPath(composeYaml: string, botDir: string): string {
  const volumeLines = extractListSection(composeYaml, 'volumes');
  const dataLine = volumeLines.find(line => line.includes(':/build/data'));
  if (!dataLine) throw new Error('docker-compose.yml has no volume mapped to /build/data');

  const match = dataLine.match(/^-\s*(.+):\/build\/data\s*$/);
  if (!match) throw new Error(`could not parse volume line: ${dataLine}`);
  const hostPath = match[1]!.trim();

  return isAbsolute(hostPath) ? hostPath : join(botDir, hostPath);
}

// Migrates one bot's legacy data + docker-compose.yml into the new fleet's
// config/bots/<botId>/{bot.json,config.json} plus a fresh state.sqlite.
// `secrets` is mutated in place with this bot's app password rather than
// returned, so it never transits through a value a future caller might log.
export function importOneBot(
  sourceRoot: string,
  targetConfigRoot: string,
  dataRoot: string,
  botId: string,
  secrets: Record<string, string>,
): ImportedBot {
  const botDir = join(sourceRoot, botId);
  const composeYaml = readFileSync(join(botDir, 'docker-compose.yml'), 'utf-8');
  const env = parseComposeEnv(composeYaml);
  const dataPath = resolveDataPath(composeYaml, botDir);

  const legacyConfig = JSON.parse(readFileSync(join(dataPath, 'config.json'), 'utf-8')) as Record<
    string,
    unknown
  >;
  // publishDate is assigned a default in the legacy app's rssHandler.ts but never
  // read anywhere else - confirmed dead in the legacy code itself, not carried over.
  const {publishDate: _publishDate, ...config} = legacyConfig;

  const targetBotDir = join(targetConfigRoot, 'bots', botId);
  mkdirSync(targetBotDir, {recursive: true});
  writeFileSync(
    join(targetBotDir, 'bot.json'),
    JSON.stringify(
      {
        id: botId,
        enabled: true,
        identifier: env.identifier,
        instanceUrl: env.instanceUrl,
        feedUrl: env.feedUrl,
        secretKey: botId,
        fetchIntervalMinutes: env.fetchIntervalMinutes,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(targetBotDir, 'config.json'), JSON.stringify(config, null, 2));

  secrets[botId] = env.appPassword;

  const dbPath = join(dataRoot, 'bots', botId, 'state.sqlite');
  // Idempotent: fully recompute this bot's state from the current legacy
  // source on every run, rather than merging into whatever's already there.
  rmSync(dbPath, {force: true});
  const store = new BotStore(dbPath);
  try {
    const lastPath = join(dataPath, 'last.txt');
    if (existsSync(lastPath)) {
      const lastDate = readFileSync(lastPath, 'utf-8').trim();
      if (lastDate) store.writeCursor(new Date(lastDate));
    }

    const dbTxtPath = join(dataPath, 'db.txt');
    if (existsSync(dbTxtPath)) {
      const lines = readFileSync(dbTxtPath, 'utf-8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      for (const line of lines) {
        const sepIndex = line.indexOf('|');
        if (sepIndex === -1) continue;
        store.writeSeenValue(line.slice(sepIndex + 1));
      }
    }

    const persistPath = join(dataPath, 'persist.json');
    if (existsSync(persistPath)) {
      const session = JSON.parse(readFileSync(persistPath, 'utf-8'));
      store.writeSession(session);
    }
  } finally {
    store.close();
  }

  return {botId, identifier: env.identifier};
}

export function importLegacyFleet(
  sourceRoot: string,
  targetConfigRoot: string,
  dataRoot: string,
  secretsFilePath: string,
  only?: string[],
): ImportResult {
  const entries = readdirSync(sourceRoot, {withFileTypes: true}).filter(e => e.isDirectory());

  const existingSecrets: Record<string, string> = existsSync(secretsFilePath)
    ? JSON.parse(readFileSync(secretsFilePath, 'utf-8'))
    : {};
  const secrets = {...existingSecrets};

  const imported: ImportedBot[] = [];
  const errors: ImportError[] = [];

  for (const entry of entries) {
    const botId = entry.name;
    if (only && !only.includes(botId)) continue;
    // A directory with no docker-compose.yml isn't an independent bot (e.g. the
    // bsky.rss git checkout itself, or a data directory shared by other bots).
    if (!existsSync(join(sourceRoot, botId, 'docker-compose.yml'))) continue;

    try {
      imported.push(importOneBot(sourceRoot, targetConfigRoot, dataRoot, botId, secrets));
    } catch (err) {
      errors.push({botId, error: String(err)});
    }
  }

  mkdirSync(dirname(secretsFilePath), {recursive: true});
  // Real app passwords - design spec §9 calls for mode 0600, not the
  // world-readable default writeFileSync would otherwise leave behind.
  writeFileSync(secretsFilePath, JSON.stringify(secrets, null, 2), {mode: 0o600});
  chmodSync(secretsFilePath, 0o600);

  return {imported, errors};
}
