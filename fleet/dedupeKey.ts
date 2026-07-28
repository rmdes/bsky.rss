import { createHash } from "node:crypto";

/**
 * Deterministic AT-Proto record key for a given bot + RSS item. Same bot,
 * same item link, always produces the same key — this is what makes
 * BskyClient.post()'s createRecord call idempotent (design spec §4.2).
 */
export function computeDedupeKey(botId: string, itemUrl: string): string {
  return createHash("sha256").update(`${botId}|${itemUrl}`).digest("hex");
}
