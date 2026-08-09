import {createHash} from 'node:crypto';

/**
 * Deterministic AT-Proto record key for a given publishing identity + RSS item. Same
 * Bluesky identifier, same item link, always produces the same key - this is what makes
 * BskyClient.post()'s createRecord call idempotent (design spec §4.2).
 *
 * Keyed by `identifier` (the Bluesky handle a bot config publishes to), not by botId.
 * Multiple bot configs can deliberately share one identifier - e.g. several FreshRSS
 * category exports feeding one logical account - and the same story appearing in two of
 * those feeds must be recognized as a duplicate of the *account's* publishing history,
 * not just of that one bot config's own history. Keying by botId let each bot config
 * independently decide a shared story was "new" and post it a second time to an account
 * that had already published it.
 */
export function computeDedupeKey(identifier: string, itemUrl: string): string {
  return createHash('sha256').update(`${identifier}|${itemUrl}`).digest('hex');
}
