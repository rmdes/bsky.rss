import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import http from 'node:http';
import {test, type TestContext} from 'node:test';
import {Logger, type LogRecord} from '../shared/logging/logger.ts';

function fetchHealth(port: number): Promise<{status: number; ready: boolean}> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {host: '127.0.0.1', port, path: '/health', agent: false, timeout: 1000},
      res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              ready: (JSON.parse(body) as {ready: boolean}).ready,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
  });
}

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
  assert.doesNotMatch(output, /invalid-startup-secret|Invalid log level|\n\s+at /);
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

test('a running fleet exposes /health, reporting ready once startup completes', async t => {
  const directory = tempDirectory(t);
  const configRoot = join(directory, 'config');
  mkdirSync(join(configRoot, 'bots'), {recursive: true});
  writeFileSync(
    join(configRoot, 'fleet.json'),
    JSON.stringify({
      staggerSeconds: 1,
      runIntervalSeconds: 60,
      freshness: {maxCatchupItems: 5, maxItemAgeMinutes: 120},
      sharedLimiters: {
        maxConcurrentOpenGraphFetches: 1,
        maxConcurrentImageJobs: 1,
        maxImageDownloadBytes: 1000000,
        httpTimeoutMs: 5000,
      },
      perBotQueueMaxLength: 500,
    }),
  );
  const secretsFilePath = join(directory, 'secrets.json');
  writeFileSync(secretsFilePath, JSON.stringify({}));
  const healthPort = 20000 + Math.floor(Math.random() * 10000);

  const cli = join(process.cwd(), 'fleet', 'runFleet.ts');
  const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsx, cli], {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      TMPDIR: '/tmp',
      FLEET_CONFIG_ROOT: configRoot,
      FLEET_SECRETS_PATH: secretsFilePath,
      FLEET_DATA_ROOT: join(directory, 'data'),
      FLEET_LOCK_PATH: join(directory, 'fleet.pid'),
      HEALTH_CHECK_PORT: String(healthPort),
    },
  });
  const exited = new Promise<void>(resolve => child.on('exit', () => resolve()));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });

  let lastFetchError: unknown;
  let response: {status: number; ready: boolean} | undefined;
  for (let attempt = 0; attempt < 50 && !response; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      response = await fetchHealth(healthPort);
    } catch (error) {
      lastFetchError = error;
    }
  }

  assert.ok(response, `health endpoint never responded; last error: ${String(lastFetchError)}`);
  assert.equal(response!.status, 200);
  assert.equal(response!.ready, true);

  child.kill('SIGKILL');
  await exited;
});

test('shutdown during activation suppresses the contradictory Fleet started summary', async () => {
  const runFleetModule = (await import('./runFleet.ts')) as Record<string, unknown>;
  const reportFleetStarted = runFleetModule.reportFleetStarted as
    | undefined
    | ((logger: Logger, counts: {active: number; failed: number}, shuttingDown: boolean) => void);
  assert.equal(typeof reportFleetStarted, 'function');
  const records: LogRecord[] = [];
  const logger = new Logger({
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
