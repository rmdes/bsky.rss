import {test} from 'node:test';
import assert from 'node:assert/strict';
import {XRPCError, ResponseType} from '@atproto/xrpc';
import {BskyClient, classifyPostError, isAlreadyExistsError, toAtprotoRkey} from './bskyClient.ts';
import type {BotStore} from './botStore.ts';
import {FleetLogger, type FleetLogLevel, type FleetLogRecord} from './logging.ts';

function makeClient(
  level: FleetLogLevel,
  dryRun = false,
  alreadyExistsClassifier?: (error: unknown) => boolean,
) {
  const records: FleetLogRecord[] = [];
  const logger = new FleetLogger({
    defaultLevel: level,
    now: () => new Date('2026-08-03T12:00:00.000Z'),
    sink: (_line, record) => records.push(record),
  });
  const store = {
    readSession: () => undefined,
    writeSession: () => undefined,
  };
  const client = new BskyClient(
    'test-bot',
    'https://bsky.social',
    store as unknown as BotStore,
    logger,
    dryRun,
    alreadyExistsClassifier,
  );
  return {client, records};
}

function makeXRPCError(status: number, headers?: Record<string, string>): XRPCError {
  const err = new XRPCError(status, 'TestError', 'test error');
  err.headers = headers;
  return err;
}

test('classifies a 429 with a lowercase retry-after header (the real-world shape)', () => {
  const err = makeXRPCError(ResponseType.RateLimitExceeded, {'retry-after': '45'});
  const result = classifyPostError(err);
  assert.equal(result.ratelimit, true);
  assert.equal(result.retryAfterSeconds, 45);
});

test('classifies a 504 the same way as a 429', () => {
  const err = makeXRPCError(ResponseType.UpstreamTimeout, {'retry-after': '12'});
  const result = classifyPostError(err);
  assert.equal(result.ratelimit, true);
  assert.equal(result.retryAfterSeconds, 12);
});

test('falls back to 30s when a rate-limit status has no retry-after header', () => {
  const err = makeXRPCError(ResponseType.RateLimitExceeded, {});
  const result = classifyPostError(err);
  assert.equal(result.ratelimit, true);
  assert.equal(result.retryAfterSeconds, 30);
});

test('a non-rate-limit XRPCError is an uncertain outcome, not a rate limit', () => {
  const err = makeXRPCError(ResponseType.InvalidRequest, {'retry-after': '999'});
  const result = classifyPostError(err);
  assert.equal(result.ratelimit, false);
  assert.equal(result.retryAfterSeconds, 30);
});

test('a non-XRPCError exception (network error, etc.) is an uncertain outcome, not a rate limit', () => {
  const result = classifyPostError(new Error('ECONNRESET'));
  assert.equal(result.ratelimit, false);
  assert.equal(result.retryAfterSeconds, 30);
});

test('ignores a non-numeric retry-after value and falls back to 30s', () => {
  const err = makeXRPCError(ResponseType.RateLimitExceeded, {'retry-after': 'not-a-number'});
  const result = classifyPostError(err);
  assert.equal(result.retryAfterSeconds, 30);
});

test('isAlreadyExistsError is deliberately conservative — returns false for any input today', () => {
  // No real PDS response shape has been empirically verified yet (see Task 6 in the
  // Phase 2 plan). This test documents and locks in the intentional fail-safe default:
  // until a real "already exists" error shape is confirmed, every createRecord failure
  // is treated as genuinely uncertain, never as a confirmed duplicate.
  assert.equal(isAlreadyExistsError(new Error('anything')), false);
  assert.equal(isAlreadyExistsError(makeXRPCError(ResponseType.InvalidRequest)), false);
  assert.equal(isAlreadyExistsError(undefined), false);
  assert.equal(isAlreadyExistsError({status: 400, error: 'AlreadyExists'}), false);
});

// The real AT-Proto TID regex, copied verbatim from @atproto/syntax's tid.ts
// (TID_REGEX) rather than imported, so this test doesn't depend on an
// unlisted transitive package - this is the actual server-side validation
// rule that rejected a raw dedupeKey in production with "Invalid TID string".
const REAL_ATPROTO_TID_REGEX = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

test("toAtprotoRkey produces a string matching AT-Proto's real TID format", () => {
  const rkey = toAtprotoRkey('any-dedupe-key-value');
  assert.equal(rkey.length, 13);
  assert.match(rkey, REAL_ATPROTO_TID_REGEX);
});

test('toAtprotoRkey is deterministic - same input always produces the same rkey', () => {
  const a = toAtprotoRkey('bot-1|https://example.com/article');
  const b = toAtprotoRkey('bot-1|https://example.com/article');
  assert.equal(a, b);
});

test('toAtprotoRkey produces different rkeys for different inputs', () => {
  const a = toAtprotoRkey('item-a');
  const b = toAtprotoRkey('item-b');
  assert.notEqual(a, b);
});

test('toAtprotoRkey matches the real TID format across many varied inputs, not just one lucky case', () => {
  for (let i = 0; i < 200; i++) {
    const rkey = toAtprotoRkey(`dedupe-key-${i}-${'x'.repeat(i % 50)}`);
    assert.match(rkey, REAL_ATPROTO_TID_REGEX, `failed for input index ${i}: got "${rkey}"`);
  }
});

test('summary login records omit the account handle while verbose records may include it', async () => {
  const summary = makeClient('summary');
  (summary.client as unknown as {agent: unknown}).agent = {
    login: async () => ({success: true, data: {handle: 'private-handle.bsky.social'}}),
  };
  await summary.client.login('identifier', 'password');
  assert.equal(summary.records.length, 1);
  assert.equal(summary.records[0]!.level, 'summary');
  assert.doesNotMatch(summary.records[0]!.message, /private-handle|identifier|password/);

  const verbose = makeClient('verbose');
  (verbose.client as unknown as {agent: unknown}).agent = {
    login: async () => ({success: true, data: {handle: 'private-handle.bsky.social'}}),
  };
  await verbose.client.login('identifier', 'password');
  assert.ok(
    verbose.records.some(
      record => record.level === 'verbose' && record.message.includes('private-handle.bsky.social'),
    ),
  );
});

test('resumed-session summary omits the handle and retains the successful short-circuit', async () => {
  const records: FleetLogRecord[] = [];
  const logger = new FleetLogger({
    defaultLevel: 'summary',
    sink: (_line, record) => records.push(record),
  });
  const store = {
    readSession: () => ({accessJwt: 'secret'}),
    writeSession: () => undefined,
  };
  const client = new BskyClient(
    'test-bot',
    'https://bsky.social',
    store as unknown as BotStore,
    logger,
  );
  let passwordLoginCalled = false;
  (client as unknown as {agent: unknown}).agent = {
    resumeSession: async () => ({success: true, data: {handle: 'resumed-private.bsky.social'}}),
    login: async () => {
      passwordLoginCalled = true;
      return {success: true, data: {handle: 'unused'}};
    },
  };

  await client.login('identifier', 'password');

  assert.equal(passwordLoginCalled, false);
  assert.equal(records.length, 1);
  assert.doesNotMatch(records[0]!.message, /resumed-private|secret|identifier|password/);
});

test('caught session-resume errors and login durations are debug-only for the selected bot', async () => {
  const records: FleetLogRecord[] = [];
  const logger = new FleetLogger({
    defaultLevel: 'summary',
    sink: (_line, record) => records.push(record),
  });
  logger.replaceOverrides(
    new Map([['debug-bot', {level: 'debug', expiresAt: '2099-01-01T00:00:00.000Z'}]]),
  );
  const makeSessionClient = (botId: string, secret: string) => {
    const store = {
      readSession: () => ({accessJwt: secret}),
      writeSession: () => undefined,
    };
    const client = new BskyClient(
      botId,
      'https://bsky.social',
      store as unknown as BotStore,
      logger,
    );
    (client as unknown as {agent: unknown}).agent = {
      resumeSession: async () => {
        throw new Error(`resume rejected token=${secret}`);
      },
      login: async () => ({success: true, data: {handle: `${botId}.example`}}),
    };
    return client;
  };

  await makeSessionClient('debug-bot', 'debug-session-secret').login('id', 'password');
  await makeSessionClient('quiet-bot', 'quiet-session-secret').login('id', 'password');

  const debug = records.filter(record => record.level === 'debug');
  assert.ok(debug.length >= 3);
  assert.ok(debug.every(record => record.botId === 'debug-bot'));
  assert.ok(debug.some(record => /session resume failed/i.test(record.message)));
  assert.ok(debug.some(record => /session resume completed in \d+ms/i.test(record.message)));
  assert.ok(debug.some(record => /password login completed in \d+ms/i.test(record.message)));
  assert.ok(
    debug.every(record => !/debug-session-secret|quiet-session-secret/.test(record.message)),
  );
});

test('dry-run post content is verbose and absent at summary', async () => {
  const summary = makeClient('summary', true);
  assert.deepEqual(await summary.client.post({content: 'private dry-run content', rkey: 'key'}), {
    ok: true,
    uri: 'dry-run://noop',
  });
  assert.equal(summary.records.length, 0);

  const verbose = makeClient('verbose', true);
  assert.deepEqual(await verbose.client.post({content: 'private dry-run content', rkey: 'key'}), {
    ok: true,
    uri: 'dry-run://noop',
  });
  assert.equal(verbose.records.length, 1);
  assert.equal(verbose.records[0]!.level, 'verbose');
  assert.match(verbose.records[0]!.message, /private dry-run content/);
});

test('a blob upload failure returns a distinct pre-record deferral with debug detail', async () => {
  const runtime = makeClient('debug');
  (runtime.client as unknown as {agent: unknown}).agent = {
    uploadBlob: async () => {
      throw new Error('image transport failed');
    },
  };

  const result = await runtime.client.post({
    content: 'plain content',
    rkey: 'upload-failure',
    embed: {
      uri: 'https://example.test/article',
      title: 'Example',
      image: Buffer.from('image'),
      type: 'image',
    },
  });

  assert.deepEqual(result, {
    ok: false,
    deferralReason: 'upload-failure',
    retryAfterSeconds: 30,
  });
  assert.ok(
    runtime.records.some(
      record =>
        record.level === 'debug' &&
        /blob upload failed/i.test(record.message) &&
        record.message.includes('image transport failed'),
    ),
  );
  assert.ok(
    runtime.records.some(
      record => record.level === 'debug' && /blob upload completed in \d+ms/i.test(record.message),
    ),
  );
});

test('a classified create-record failure emits sanitized debug detail and duration', async () => {
  const runtime = makeClient('debug');
  (runtime.client as unknown as {agent: unknown}).agent = {
    accountDid: 'did:plc:test',
    app: {
      bsky: {
        feed: {
          post: {
            create: async () => {
              throw new Error('create failed token=create-record-secret');
            },
          },
        },
      },
    },
  };

  assert.deepEqual(await runtime.client.post({content: 'plain content', rkey: 'create-failure'}), {
    ok: false,
    ratelimit: false,
    retryAfterSeconds: 30,
  });
  assert.ok(
    runtime.records.some(
      record =>
        record.level === 'debug' &&
        /create record failed/i.test(record.message) &&
        !record.message.includes('create-record-secret'),
    ),
  );
  assert.ok(
    runtime.records.some(
      record =>
        record.level === 'debug' && /create record completed in \d+ms/i.test(record.message),
    ),
  );
});

test('an existing-rkey post message is verbose and cannot leak the rkey at summary', async () => {
  for (const level of ['summary', 'verbose'] as const) {
    const runtime = makeClient(level, false, () => true);
    (runtime.client as unknown as {agent: unknown}).agent = {
      accountDid: 'did:plc:test',
      app: {
        bsky: {
          feed: {
            post: {
              create: async () => {
                throw new Error('record already exists');
              },
            },
          },
        },
      },
    };

    const result = await runtime.client.post({content: 'plain content', rkey: 'private-rkey'});

    assert.deepEqual(result, {ok: true});
    if (level === 'summary') {
      assert.equal(runtime.records.length, 0);
    } else {
      assert.equal(runtime.records.length, 1);
      assert.equal(runtime.records[0]!.level, 'verbose');
      assert.match(runtime.records[0]!.message, /private-rkey/);
    }
  }
});
