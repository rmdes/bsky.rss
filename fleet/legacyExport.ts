import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {BotStore} from './botStore.ts';
import {parseComposeEnv, resolveDataPath} from './legacyImport.ts';

export interface ExportedBot {
  botId: string;
}

export interface ExportError {
  botId: string;
  error: string;
}

export interface ExportResult {
  exported: ExportedBot[];
  errors: ExportError[];
}

export function exportOneBot(
  legacySourceRoot: string,
  dataRoot: string,
  botId: string,
): ExportedBot {
  const botDir = join(legacySourceRoot, botId);
  const composeYaml = readFileSync(join(botDir, 'docker-compose.yml'), 'utf-8');
  parseComposeEnv(composeYaml); // validates the compose file parses; not otherwise needed here
  const dataPath = resolveDataPath(composeYaml, botDir);
  mkdirSync(dataPath, {recursive: true});

  const dbPath = join(dataRoot, 'bots', botId, 'state.sqlite');
  if (!existsSync(dbPath)) {
    throw new Error(
      `no fleet state found at ${dbPath} - refusing to export (would fabricate an empty store)`,
    );
  }

  const store = new BotStore(dbPath);
  try {
    const session = store.readSession();
    if (session !== null) {
      writeFileSync(join(dataPath, 'persist.json'), JSON.stringify(session));
    }

    const cursor = store.readCursor();
    if (cursor) {
      writeFileSync(join(dataPath, 'last.txt'), cursor);
    }

    const seenValues = store.listSeenValues();
    if (seenValues.length > 0) {
      const lines = seenValues.map(row => `${row.seenAt}|${row.value}`);
      writeFileSync(join(dataPath, 'db.txt'), lines.join('\n') + '\n');
    }
  } finally {
    store.close();
  }

  return {botId};
}

export function exportLegacyFleet(
  legacySourceRoot: string,
  dataRoot: string,
  botIds: string[],
): ExportResult {
  const exported: ExportedBot[] = [];
  const errors: ExportError[] = [];

  for (const botId of botIds) {
    try {
      exported.push(exportOneBot(legacySourceRoot, dataRoot, botId));
    } catch (err) {
      errors.push({botId, error: String(err)});
    }
  }

  return {exported, errors};
}
