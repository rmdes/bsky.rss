import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BotStore } from "./botStore.ts";
import { parseComposeEnv, resolveDataPath } from "./legacyImport.ts";

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

export function exportOneBot(legacySourceRoot: string, dataRoot: string, botId: string): ExportedBot {
  const botDir = join(legacySourceRoot, botId);
  const composeYaml = readFileSync(join(botDir, "docker-compose.yml"), "utf-8");
  parseComposeEnv(composeYaml); // validates the compose file parses; not otherwise needed here
  const dataPath = resolveDataPath(composeYaml, botDir);
  mkdirSync(dataPath, { recursive: true });

  const dbPath = join(dataRoot, "bots", botId, "state.sqlite");
  const store = new BotStore(dbPath);
  try {
    const session = store.readSession();
    if (session !== null) {
      writeFileSync(join(dataPath, "persist.json"), JSON.stringify(session));
    }

    const cursor = store.readCursor();
    if (cursor) {
      writeFileSync(join(dataPath, "last.txt"), cursor);
    }

    const seenValues = store.listSeenValues();
    const lines = seenValues.map((row) => `${row.seenAt}|${row.value}`);
    writeFileSync(join(dataPath, "db.txt"), lines.length > 0 ? lines.join("\n") + "\n" : "");
  } finally {
    store.close();
  }

  return { botId };
}

export function exportLegacyFleet(legacySourceRoot: string, dataRoot: string, botIds: string[]): ExportResult {
  const exported: ExportedBot[] = [];
  const errors: ExportError[] = [];

  for (const botId of botIds) {
    try {
      exported.push(exportOneBot(legacySourceRoot, dataRoot, botId));
    } catch (err) {
      errors.push({ botId, error: String(err) });
    }
  }

  return { exported, errors };
}
