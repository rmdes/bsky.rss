import {readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process - genuinely dead. Any other error (e.g. EPERM,
    // meaning the process exists but we can't signal it) means it's alive.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function isLockedByLiveProcess(lockFilePath: string): boolean {
  if (!existsSync(lockFilePath)) return false;
  const pid = Number(readFileSync(lockFilePath, 'utf-8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  return isProcessAlive(pid);
}

export function acquireLock(lockFilePath: string): void {
  if (isLockedByLiveProcess(lockFilePath)) {
    throw new Error(`Lock file ${lockFilePath} is held by a live process`);
  }
  mkdirSync(dirname(lockFilePath), {recursive: true});
  writeFileSync(lockFilePath, String(process.pid));
}

export function releaseLock(lockFilePath: string): void {
  if (existsSync(lockFilePath)) unlinkSync(lockFilePath);
}
