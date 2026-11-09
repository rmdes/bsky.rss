// fleet/reloadRequests.test.ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  NO_RELOAD_REQUESTS,
  addReloadRequest,
  reloadRequestsPath,
  takeReloadRequests,
} from './reloadRequests.ts';

function dataRoot(t: {after(callback: () => void): void}): string {
  const root = mkdtempSync(join(tmpdir(), 'reload-requests-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}

test('no file means no requests', t => {
  const path = reloadRequestsPath(dataRoot(t));
  assert.deepEqual(takeReloadRequests(path), {ok: true, requests: NO_RELOAD_REQUESTS});
});

test('requests accumulate, are written 0600, and are consumed exactly once', t => {
  const path = reloadRequestsPath(dataRoot(t));
  addReloadRequest(path, 'skyfleet-en');
  addReloadRequest(path, 'euwatch-fr');
  addReloadRequest(path, 'skyfleet-en');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(takeReloadRequests(path), {
    ok: true,
    requests: {all: false, botIds: ['skyfleet-en', 'euwatch-fr']},
  });
  assert.equal(existsSync(path), false);
  assert.deepEqual(takeReloadRequests(path), {ok: true, requests: NO_RELOAD_REQUESTS});
});

test('"*" means all bots', t => {
  const path = reloadRequestsPath(dataRoot(t));
  addReloadRequest(path, '*');
  const taken = takeReloadRequests(path);
  assert.ok(taken.ok);
  assert.equal(taken.requests.all, true);
});

test('a malformed file is reported, not thrown, and is consumed', t => {
  const path = reloadRequestsPath(dataRoot(t));
  writeFileSync(path, '{"requests": "skyfleet-en"}');
  const taken = takeReloadRequests(path);
  assert.equal(taken.ok, false);
  assert.equal(existsSync(path), false);
});

test('adding to a malformed file replaces it', t => {
  const path = reloadRequestsPath(dataRoot(t));
  writeFileSync(path, 'not json');
  addReloadRequest(path, 'skyfleet-en');
  assert.deepEqual(takeReloadRequests(path), {
    ok: true,
    requests: {all: false, botIds: ['skyfleet-en']},
  });
});
