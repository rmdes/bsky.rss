import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test, type TestContext} from 'node:test';
import {FleetLogger, type FleetLogRecord} from './logging.ts';

function tempDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'run-fleet-test-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return directory;
}

function runFleet(environment: NodeJS.ProcessEnv) {
  const cli = join(process.cwd(), 'fleet', 'runFleet.ts');
  const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return spawnSync(process.execPath, [tsx, cli], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      TMPDIR: '/tmp',
      ...environment,
    },
    encoding: 'utf8',
  });
}

test('invalid startup log level fails generically without echoing its raw value', t => {
  const directory = tempDirectory(t);
  const result = runFleet({
    FLEET_LOG_LEVEL: 'Bearer invalid-startup-secret',
    FLEET_LOCK_PATH: join(directory, 'fleet.pid'),
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /Fleet startup failed/);
  assert.doesNotMatch(output, /invalid-startup-secret|Invalid fleet log level|\n\s+at /);
});

test('debug startup failure uses a safe summary and sanitized diagnostic detail', t => {
  const directory = tempDirectory(t);
  const privateConfigRoot = join(directory, 'password=bootstrap-secret');
  const result = runFleet({
    FLEET_LOG_LEVEL: 'debug',
    FLEET_CONFIG_ROOT: privateConfigRoot,
    FLEET_SECRETS_PATH: join(directory, 'unused-secrets.json'),
    FLEET_DATA_ROOT: join(directory, 'data'),
    FLEET_LOCK_PATH: join(directory, 'fleet.pid'),
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /Fleet startup failed/);
  assert.match(output, /ENOENT/);
  assert.match(output, /\[REDACTED\]/);
  assert.doesNotMatch(output, /bootstrap-secret/);
});

test('shutdown during activation suppresses the contradictory Fleet started summary', async () => {
  const runFleetModule = (await import('./runFleet.ts')) as Record<string, unknown>;
  const reportFleetStarted = runFleetModule.reportFleetStarted as
    | undefined
    | ((
        logger: FleetLogger,
        counts: {active: number; failed: number},
        shuttingDown: boolean,
      ) => void);
  assert.equal(typeof reportFleetStarted, 'function');
  const records: FleetLogRecord[] = [];
  const logger = new FleetLogger({
    defaultLevel: 'summary',
    sink: (_line, record) => records.push(record),
  });

  reportFleetStarted!(logger, {active: 2, failed: 1}, true);
  assert.equal(records.length, 0);

  reportFleetStarted!(logger, {active: 2, failed: 1}, false);
  assert.deepEqual(
    records.map(record => record.message),
    ['Fleet started: 2 active, 1 failed'],
  );
});
