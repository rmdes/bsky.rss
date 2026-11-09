import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reloadRequestsPath, takeReloadRequests} from './reloadRequests.ts';
import {runReloadControl} from './reloadControl.ts';

function roots(t: {after(callback: () => void): void}) {
  const root = mkdtempSync(join(tmpdir(), 'reload-control-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const configRoot = join(root, 'config');
  const dataRoot = join(root, 'data');
  mkdirSync(join(configRoot, 'bots', 'skyfleet-en'), {recursive: true});
  mkdirSync(dataRoot, {recursive: true});
  return {configRoot, dataRoot};
}

test('requests a reload for an existing bot directory', t => {
  const r = roots(t);
  assert.equal(
    runReloadControl(['skyfleet-en'], r),
    'reload requested for skyfleet-en; applied within ~10s',
  );
  const taken = takeReloadRequests(reloadRequestsPath(r.dataRoot));
  assert.ok(taken.ok);
  assert.deepEqual(taken.requests.botIds, ['skyfleet-en']);
});

test('--all requests every bot', t => {
  const r = roots(t);
  assert.equal(
    runReloadControl(['--all'], r),
    'reload requested for all bots; applied within ~10s',
  );
  const taken = takeReloadRequests(reloadRequestsPath(r.dataRoot));
  assert.ok(taken.ok && taken.requests.all);
});

test('an unknown bot or wrong arguments are rejected with usage', t => {
  const r = roots(t);
  assert.throws(() => runReloadControl(['nope'], r), /Unknown bot "nope"/);
  assert.throws(() => runReloadControl([], r), /Usage:/);
});
