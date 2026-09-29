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

/**
 * Converts an AT-URI (at://<did>/<collection>/<rkey>) into the bsky.app web URL for that
 * record. bsky.app resolves a DID in a profile URL exactly like a handle, so this needs no
 * separate handle lookup for the linked post's author.
 */
export function atUriToBskyUrl(uri: string): string {
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
    'X-Click': atUriToBskyUrl(notification.uri),
    'X-Tags': REASON_TAGS[notification.reason] ?? 'bell',
  };
  if (notification.reasonSubject) {
    headers['X-Actions'] =
      `view, Open original post, ${atUriToBskyUrl(notification.reasonSubject)}`;
  }

  return {body: `${notification.author.handle}: "${truncated}"`, headers};
}

export interface CheckBotNotificationsParams {
  botId: string;
  botHandle: string;
  bskyClient: BskyClient;
  store: BotStore;
  ntfyUrl: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export async function checkBotNotifications(params: CheckBotNotificationsParams): Promise<void> {
  const {botId, botHandle, bskyClient, store, ntfyUrl, logger} = params;
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
    const ageMs = Date.now() - new Date(notification.indexedAt).getTime();
    if (ageMs > MAX_NOTIFICATION_AGE_MS) continue;
    if (store.seenValueExists(notification.uri, NOTIFIED_TABLE)) continue;

    const message = buildNtfyMessage(botHandle, notification);
    try {
      const response = await fetchImpl(ntfyUrl, {
        method: 'POST',
        body: message.body,
        headers: message.headers,
      });
      if (!response.ok) {
        logger.debug('NOTIFY', `ntfy POST failed with status ${response.status}`, botId);
        continue;
      }
    } catch (error) {
      logger.debug('NOTIFY', `ntfy POST failed\n${formatDebugError(error)}`, botId);
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
