import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {changedFields, fingerprintBot, listBotIds} from './botFingerprint.ts';

function configTree(t: {after(callback: () => void): void}): string {
  const root = mkdtempSync(join(tmpdir(), 'fingerprint-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}

function writeBot(
  root: string,
  botId: string,
  bot: object,
  config: object | string = {string: '$title'},
): void {
  const dir = join(root, 'bots', botId);
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'bot.json'), JSON.stringify(bot));
  writeFileSync(
    join(dir, 'config.json'),
    typeof config === 'string' ? config : JSON.stringify(config),
  );
}

const bot = (overrides: object = {}) => ({
  id: 'a',
  enabled: true,
  identifier: 'a.bsky.social',
  instanceUrl: 'https://bsky.social',
  feedUrl: 'https://example.test/feed.xml?token=FEEDTOKEN',
  secretKey: 'a',
  fetchIntervalMinutes: 5,
  ...overrides,
});

test('listBotIds returns sorted bot directory names', t => {
  const root = configTree(t);
  writeBot(root, 'b', bot({id: 'b'}));
  writeBot(root, 'a', bot());
  writeFileSync(join(root, 'bots', 'not-a-dir.txt'), 'x');
  assert.deepEqual(listBotIds(root), ['a', 'b']);
});

test('identical files and secret give the identical hash', t => {
  const root = configTree(t);
  writeBot(root, 'a', bot());
  const first = fingerprintBot(root, {a: 'pw'}, 'a');
  const second = fingerprintBot(root, {a: 'pw'}, 'a');
  assert.ok(first.ok && second.ok);
  assert.equal(first.hash, second.hash);
  assert.equal(first.enabled, true);
});

test('bot.json, config.json, and this bot’s own secret each change the hash', t => {
  const root = configTree(t);
  writeBot(root, 'a', bot());
  const base = fingerprintBot(root, {a: 'pw', other: 'x'}, 'a');
  writeBot(root, 'a', bot({feedUrl: 'https://example.test/new.xml'}));
  const botChanged = fingerprintBot(root, {a: 'pw', other: 'x'}, 'a');
  writeBot(root, 'a', bot(), {string: '$title $link'});
  const configChanged = fingerprintBot(root, {a: 'pw', other: 'x'}, 'a');
  writeBot(root, 'a', bot());
  const secretChanged = fingerprintBot(root, {a: 'new-pw', other: 'x'}, 'a');
  const otherSecretChanged = fingerprintBot(root, {a: 'pw', other: 'y'}, 'a');
  assert.ok(
    base.ok && botChanged.ok && configChanged.ok && secretChanged.ok && otherSecretChanged.ok,
  );
  assert.notEqual(botChanged.hash, base.hash);
  assert.notEqual(configChanged.hash, base.hash);
  assert.notEqual(secretChanged.hash, base.hash);
  assert.equal(otherSecretChanged.hash, base.hash);
});

test('changedFields names fields, never values, and reports a secret change as "secret"', t => {
  const root = configTree(t);
  writeBot(root, 'a', bot());
  const before = fingerprintBot(root, {a: 'pw'}, 'a');
  writeBot(root, 'a', bot({feedUrl: 'https://example.test/feed.xml?token=NEWTOKEN'}), {
    string: '$link',
  });
  const after = fingerprintBot(root, {a: 'new-pw'}, 'a');
  assert.ok(before.ok && after.ok);
  const changed = changedFields(before.fields, after.fields);
  assert.deepEqual(changed, ['feedUrl', 'secret', 'string']);
  assert.ok(!JSON.stringify(after.fields).includes('new-pw'));
});

test('a disabled bot fingerprints with enabled false', t => {
  const root = configTree(t);
  writeBot(root, 'a', bot({enabled: false}));
  const fingerprint = fingerprintBot(root, {a: 'pw'}, 'a');
  assert.ok(fingerprint.ok);
  assert.equal(fingerprint.enabled, false);
});

test('invalid or unreadable JSON is an error result naming the file, without parser text', t => {
  const root = configTree(t);
  writeBot(root, 'a', bot(), '{"string": "token=SECRETVALUE",');
  const invalid = fingerprintBot(root, {a: 'pw'}, 'a');
  assert.deepEqual(invalid, {ok: false, botId: 'a', error: 'invalid config.json'});
  const missing = fingerprintBot(root, {}, 'nope');
  assert.deepEqual(missing, {ok: false, botId: 'nope', error: 'cannot read bot.json'});
});
