// The control channel behind `yarn fleet:reload`: the CLI adds requests, the config reconciler
// takes them. Mirrors fleet/logOverrides.ts.
import {existsSync, readFileSync, renameSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {writePrivateJsonAtomic} from './atomicJson.ts';

export interface ReloadRequests {
  all: boolean;
  botIds: string[];
}

export const NO_RELOAD_REQUESTS: ReloadRequests = {all: false, botIds: []};

export function reloadRequestsPath(dataRoot: string): string {
  return join(dataRoot, 'reload-requests.json');
}

function parseRequests(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  const requests = (parsed as {requests?: unknown} | null)?.requests;
  if (!Array.isArray(requests) || !requests.every(request => typeof request === 'string')) {
    throw new Error('reload-requests.json must be {"requests": [string, ...]}');
  }
  return requests as string[];
}

export function addReloadRequest(path: string, target: string): void {
  let existing: string[] = [];
  if (existsSync(path)) {
    try {
      existing = parseRequests(readFileSync(path, 'utf-8'));
    } catch {
      existing = []; // a malformed file is replaced
    }
  }
  writePrivateJsonAtomic(path, {requests: [...new Set([...existing, target])]});
}

export function takeReloadRequests(
  path: string,
): {ok: true; requests: ReloadRequests} | {ok: false; error: string} {
  const takenPath = `${path}.taking`;
  try {
    renameSync(path, takenPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {ok: true, requests: NO_RELOAD_REQUESTS};
    }
    return {
      ok: false,
      error: `cannot read reload requests (${(error as NodeJS.ErrnoException).code})`,
    };
  }
  try {
    const requests = parseRequests(readFileSync(takenPath, 'utf-8'));
    return {
      ok: true,
      requests: {
        all: requests.includes('*'),
        botIds: [...new Set(requests.filter(request => request !== '*'))],
      },
    };
  } catch {
    return {ok: false, error: 'invalid reload-requests.json'};
  } finally {
    try {
      unlinkSync(takenPath);
    } catch {
      // Already gone; nothing to consume.
    }
  }
}
