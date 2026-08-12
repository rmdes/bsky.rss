import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Logger, formatDebugError, parseLogLevel} from '../shared/logging/logger.ts';

test('parseLogLevel defaults an unset value to summary', () => {
  assert.equal(parseLogLevel(undefined), 'summary');
});

test('parseLogLevel accepts each supported level and rejects other values', () => {
  assert.equal(parseLogLevel('summary'), 'summary');
  assert.equal(parseLogLevel('verbose'), 'verbose');
  assert.equal(parseLogLevel('debug'), 'debug');
  assert.throws(() => parseLogLevel('trace'), /summary, verbose, debug/);
});

test('a summary logger emits only summary records', () => {
  const records: string[] = [];
  const logger = new Logger({
    defaultLevel: 'summary',
    sink: (_line, record) => records.push(record.level),
  });

  logger.summary('worker', 'started');
  logger.verbose('worker', 'details');
  logger.debug('worker', 'diagnostics');

  assert.deepEqual(records, ['summary']);
});

test('a verbose logger emits summary and verbose records', () => {
  const records: string[] = [];
  const logger = new Logger({
    defaultLevel: 'verbose',
    sink: (_line, record) => records.push(record.level),
  });

  logger.summary('worker', 'started');
  logger.verbose('worker', 'details');
  logger.debug('worker', 'diagnostics');

  assert.deepEqual(records, ['summary', 'verbose']);
});

test('a debug logger emits every record level', () => {
  const records: string[] = [];
  const logger = new Logger({
    defaultLevel: 'debug',
    sink: (_line, record) => records.push(record.level),
  });

  logger.summary('worker', 'started');
  logger.verbose('worker', 'details');
  logger.debug('worker', 'diagnostics');

  assert.deepEqual(records, ['summary', 'verbose', 'debug']);
});

test('a temporary debug override affects only its bot', () => {
  const records: Array<{level: string; botId?: string}> = [];
  const logger = new Logger({
    defaultLevel: 'summary',
    now: () => new Date('2026-08-03T12:00:00.000Z'),
    sink: (_line, record) => records.push(record),
  });
  logger.replaceOverrides(
    new Map([['bot-a', {level: 'debug', expiresAt: '2026-08-03T12:05:00.000Z'}]]),
  );

  logger.debug('worker', 'diagnostics', 'bot-a');
  logger.debug('worker', 'diagnostics', 'bot-b');

  assert.deepEqual(records, [
    {
      level: 'debug',
      scope: 'worker',
      botId: 'bot-a',
      message: 'diagnostics',
    },
  ]);
});

test('an expired override is ignored using the injected clock', () => {
  const logger = new Logger({
    defaultLevel: 'summary',
    now: () => new Date('2026-08-03T12:00:00.000Z'),
  });
  logger.replaceOverrides(
    new Map([['bot-a', {level: 'debug', expiresAt: '2026-08-03T11:59:59.999Z'}]]),
  );

  assert.equal(logger.overrideFor('bot-a'), undefined);
  assert.equal(logger.effectiveLevel('bot-a'), 'summary');
});

test('formatDebugError exposes only Error name message and stack', () => {
  const error = new Error('request failed');
  error.name = 'RequestError';
  error.stack = 'RequestError: request failed\n    at test';
  Object.assign(error, {
    config: {secret: 'config-secret'},
    headers: {authorization: 'header-secret'},
    session: 'session-secret',
    password: 'password-secret',
  });

  const formatted = formatDebugError(error);

  assert.match(formatted, /RequestError/);
  assert.match(formatted, /request failed/);
  assert.match(formatted, /at test/);
  assert.doesNotMatch(formatted, /config-secret|header-secret|session-secret|password-secret/);
});

test('formatDebugError redacts embedded credentials from both message and stack', () => {
  const error = new Error(
    'request failed for https://alice:url-password@api.example.test/post?token=query-token ' +
      'Authorization: Bearer auth-token password=message-password ' +
      "appPassword='message-app-password' accessJwt=message-access " +
      'refresh_token=message-refresh session=message-session clientSecret=message-secret',
  );
  error.name = 'CredentialError';
  error.stack = [
    'CredentialError: ECONNRESET while retrying',
    '    at retryRequest (https://bob:stack-password@api.example.test/retry)',
    '    Authorization=Basic stack-authorization',
    '    Bearer stack-bearer token=stack-token access_token=stack-access',
  ].join('\n');

  const formatted = formatDebugError(error);

  for (const secret of [
    'alice',
    'url-password',
    'query-token',
    'auth-token',
    'message-password',
    'message-app-password',
    'message-access',
    'message-refresh',
    'message-session',
    'message-secret',
    'bob',
    'stack-password',
    'stack-authorization',
    'stack-bearer',
    'stack-token',
    'stack-access',
  ]) {
    assert.doesNotMatch(formatted, new RegExp(secret));
  }
  assert.match(formatted, /CredentialError/);
  assert.match(formatted, /request failed/);
  assert.match(formatted, /api\.example\.test/);
  assert.match(formatted, /ECONNRESET/);
  assert.match(formatted, /retryRequest/);
  assert.match(formatted, /\[REDACTED\]/);

  assert.doesNotMatch(
    formatDebugError('Bearer primitive-secret after timeout'),
    /primitive-secret/,
  );
  assert.match(formatDebugError('Bearer primitive-secret after timeout'), /after timeout/);
});

test('formatDebugError redacts secrets embedded in JSON-quoted keys', () => {
  const error = new Error(
    'Failed request body {"identifier":"bot.bsky.social","password":"hunter2-secret"} ' +
      'session {"accessJwt":"eyJSECRETJWT","refreshJwt":"eyJSECRETREFRESH"}',
  );
  error.name = 'RequestError';
  error.stack = 'RequestError: Failed request body';

  const formatted = formatDebugError(error);

  for (const secret of ['hunter2-secret', 'eyJSECRETJWT', 'eyJSECRETREFRESH']) {
    assert.doesNotMatch(formatted, new RegExp(secret));
  }
  assert.match(formatted, /"identifier":"bot\.bsky\.social"/);
  assert.match(formatted, /\[REDACTED\]/);

  // The bearer-token rule that lives beside this one must still work unchanged.
  assert.doesNotMatch(formatDebugError('Authorization: Bearer still-a-secret'), /still-a-secret/);
});
