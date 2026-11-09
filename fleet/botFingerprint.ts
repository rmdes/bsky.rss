// Fingerprints what defines one fleet bot, so the config reconciler can tell exactly which bots
// changed on disk. See documentation/specs/2026-11-09-fleet-config-reload-design.md.
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

export type BotFingerprint =
  | {ok: true; botId: string; enabled: boolean; hash: string; fields: Record<string, string>}
  | {ok: false; botId: string; error: string};

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function listBotIds(configRoot: string): string[] {
  return readdirSync(join(configRoot, 'bots'), {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

// Parser messages are not passed on: some engines quote a snippet of the file, which can hold a
// feed token.
function readJsonObject(path: string, name: string): {raw: string; value: Record<string, unknown>} {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    throw new Error(`cannot read ${name}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`invalid ${name}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${name}`);
  }
  return {raw, value: value as Record<string, unknown>};
}

export function fingerprintBot(
  configRoot: string,
  secrets: Readonly<Record<string, string>>,
  botId: string,
): BotFingerprint {
  const botDir = join(configRoot, 'bots', botId);
  let bot: {raw: string; value: Record<string, unknown>};
  let config: {raw: string; value: Record<string, unknown>} = {raw: '', value: {}};
  try {
    bot = readJsonObject(join(botDir, 'bot.json'), 'bot.json');
    const configPath = join(botDir, 'config.json');
    if (existsSync(configPath)) config = readJsonObject(configPath, 'config.json');
  } catch (error) {
    return {ok: false, botId, error: (error as Error).message};
  }

  const secretKey = typeof bot.value.secretKey === 'string' ? bot.value.secretKey : '';
  const secret = secrets[secretKey] ?? '';

  // Values are digested, never kept, so changed-field comparisons can't leak them.
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.value))
    fields[key] = sha256(JSON.stringify(value));
  for (const [key, value] of Object.entries(bot.value)) fields[key] = sha256(JSON.stringify(value));
  fields.secret = sha256(secret);

  return {
    ok: true,
    botId,
    enabled: Boolean(bot.value.enabled),
    hash: sha256([bot.raw, config.raw, secret].join('\u0000')),
    fields,
  };
}

export function changedFields(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(key => before[key] !== after[key]).sort();
}
