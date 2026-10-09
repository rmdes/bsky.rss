import type {BskyClient} from './bskyClient.ts';
import type {BotStore} from './botStore.ts';
import {Logger, formatDebugError} from '../shared/logging/logger.ts';
import {createTimeoutFetch} from '../shared/http/timeoutFetch.ts';
import type {AppBskyNotificationListNotifications} from '@atproto/api';

// ntfy is a lightweight external service, not our own PDS - 10s is plenty and keeps a
// stalled request from blocking the 5-minute check cycle for long.
const NTFY_TIMEOUT_MS = 10_000;
const NOTIFIED_TABLE = 'notified_items' as const;
const BODY_TRUNCATE_LENGTH = 200;

// A notification older than this is not worth pushing — it's either already handled or long
// past the point where a same-day operator response matters (see design spec's "catch a
// reclamation quickly" framing). Must stay well inside the 96h prune window passed to
// cleanupOldSeenValues() below so a notification can never be pruned from notified_items while
// it's still within this cutoff — that interaction is exactly what caused the old
// repeating-resend bug. The two values aren't derived from one shared constant (96h is a
// fixed, unrelated retention policy this module doesn't own), so a future edit to either one
// must re-check the other stays clear of it.
const MAX_NOTIFICATION_AGE_MS = 24 * 3600 * 1000;

const REASON_TAGS: Record<string, string> = {
  reply: 'speech_balloon',
  mention: 'loudspeaker',
  quote: 'repeat',
};

// An AT-URI's did/collection/rkey segments never legitimately contain a comma or semicolon
// (ntfy's X-Actions header uses both as delimiters - a raw one would break the action
// definition) or CR/LF (which would inject additional HTTP headers). notification.uri and
// notification.reasonSubject ultimately come from the network, not something this process
// controls, so this is checked rather than assumed.
const SAFE_AT_URI = /^at:\/\/[^/,;\r\n]+\/[^/,;\r\n]+\/[^/,;\r\n]+$/;

/**
 * Converts an AT-URI (at://<did>/<collection>/<rkey>) into the bsky.app web URL for that
 * record, or undefined if the URI doesn't look like a real AT-URI (see SAFE_AT_URI - callers
 * must omit the header field rather than embed a malformed one). bsky.app resolves a DID in a
 * profile URL exactly like a handle, so this needs no separate handle lookup for the linked
 * post's author.
 */
export function atUriToBskyUrl(uri: string): string | undefined {
  if (!SAFE_AT_URI.test(uri)) return undefined;
  const [did, , rkey] = uri.replace('at://', '').split('/');
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

export interface NtfyMessage {
  body: string;
  headers: Record<string, string>;
}

export function buildNtfyMessage(
  botHandle: string,
  notification: AppBskyNotificationListNotifications.Notification,
): NtfyMessage {
  const text = typeof notification.record.text === 'string' ? notification.record.text : '';
  const truncated =
    text.length > BODY_TRUNCATE_LENGTH ? `${text.slice(0, BODY_TRUNCATE_LENGTH)}…` : text;

  const headers: Record<string, string> = {
    'X-Title': `New ${notification.reason} on @${botHandle}`,
    'X-Tags': REASON_TAGS[notification.reason] ?? 'bell',
  };
  const clickUrl = atUriToBskyUrl(notification.uri);
  if (clickUrl) headers['X-Click'] = clickUrl;
  if (notification.reasonSubject) {
    const subjectUrl = atUriToBskyUrl(notification.reasonSubject);
    if (subjectUrl) headers['X-Actions'] = `view, Open original post, ${subjectUrl}`;
  }

  return {body: `${notification.author.handle}: "${truncated}"`, headers};
}

export interface CheckBotNotificationsParams {
  botId: string;
  botHandle: string;
  bskyClient: BskyClient;
  store: BotStore;
  ntfyUrl: string;
  /** Bearer token for an auth-protected ntfy topic (ntfy access tokens are prefixed `tk_`).
   * Omit for a topic that allows unauthenticated publishing. */
  ntfyToken?: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export async function checkBotNotifications(params: CheckBotNotificationsParams): Promise<void> {
  const {botId, botHandle, bskyClient, store, ntfyUrl, ntfyToken, logger} = params;
  const fetchImpl = params.fetchImpl ?? createTimeoutFetch(NTFY_TIMEOUT_MS);

  store.cleanupOldSeenValues(96, NOTIFIED_TABLE);

  const result = await bskyClient.listNotifications(['reply', 'mention', 'quote']);
  if (!result.ok) {
    if (result.ratelimit) {
      logger.summary('NOTIFY', 'listNotifications rate limited, skipping this cycle', botId);
    } else {
      logger.debug('NOTIFY', 'listNotifications failed, skipping this cycle', botId);
    }
    return;
  }

  for (const notification of result.notifications ?? []) {
    const indexedAtMs = new Date(notification.indexedAt).getTime();
    // An unparseable timestamp can't be confirmed recent - fail closed (skip) rather than
    // open (NaN > anything is false, which would otherwise fall through and send it).
    if (Number.isNaN(indexedAtMs)) continue;
    const ageMs = Date.now() - indexedAtMs;
    if (ageMs > MAX_NOTIFICATION_AGE_MS) continue;
    if (store.seenValueExists(notification.uri, NOTIFIED_TABLE)) continue;

    const message = buildNtfyMessage(botHandle, notification);

    if (bskyClient.isDryRun) {
      logger.verbose(
        'NOTIFY',
        `[dry-run] would push notification (${notification.reason} from @${notification.author.handle})`,
        botId,
      );
      // Deliberately not recorded as sent - a later real (non-dry-run) run must still push it
      // for real, matching write-after-confirm: nothing was actually confirmed sent here.
      continue;
    }

    try {
      const headers = ntfyToken
        ? {...message.headers, Authorization: `Bearer ${ntfyToken}`}
        : message.headers;
      const response = await fetchImpl(ntfyUrl, {
        method: 'POST',
        body: message.body,
        headers,
      });
      if (!response.ok) {
        logger.summary('NOTIFY', `ntfy POST failed with status ${response.status}`, botId);
        continue;
      }
    } catch (error) {
      logger.summary('NOTIFY', 'ntfy POST failed', botId);
      logger.debug('NOTIFY', formatDebugError(error), botId);
      continue;
    }
    store.writeSeenValue(notification.uri, NOTIFIED_TABLE);
    logger.verbose(
      'NOTIFY',
      `Pushed notification (${notification.reason} from @${notification.author.handle})`,
      botId,
    );
  }
}
