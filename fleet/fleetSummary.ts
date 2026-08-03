import {
  emptyBotCounters,
  type BotCounters,
  type BotOperationalSnapshot,
} from "./botOperations.ts";
import { formatBytesAsMegabytes } from "./memoryLog.ts";

const counterNames: readonly (keyof BotCounters)[] = [
  "feedPollSucceeded",
  "feedPollFailed",
  "openGraphAttempted",
  "openGraphSucceeded",
  "openGraphFallback",
  "queued",
  "policySkipped",
  "postSucceeded",
  "postUncertain",
  "postDeferred",
  "postException",
];

export function sumBotCounters(states: readonly BotOperationalSnapshot[]): BotCounters {
  const totals = emptyBotCounters();
  for (const state of states) {
    for (const name of counterNames) totals[name] += state.counters[name];
  }
  return totals;
}

export function subtractBotCounters(current: BotCounters, previous: BotCounters): BotCounters {
  const delta = emptyBotCounters();
  for (const name of counterNames) delta[name] = current[name] - previous[name];
  return delta;
}

export function formatFleetIntervalSummary(input: {
  delta: BotCounters;
  queueDepth: number;
  feedsFailing: number;
  rssBytes: number;
}): string {
  const feedAttempts = input.delta.feedPollSucceeded + input.delta.feedPollFailed;
  const terminalPosts = input.delta.postSucceeded + input.delta.postUncertain;
  const postOutcomes = [
    ratio(input.delta.postSucceeded, terminalPosts),
    ...(input.delta.postDeferred === 0
      ? []
      : [count(input.delta.postDeferred, "deferred", "deferred")]),
    ...(input.delta.postException === 0
      ? []
      : [count(input.delta.postException, "exception", "exceptions")]),
  ].join(", ");

  return [
    `5m: feeds ${ratio(input.delta.feedPollSucceeded, feedAttempts)}`,
    `OG ${ratio(input.delta.openGraphSucceeded, input.delta.openGraphAttempted)}, ${count(input.delta.openGraphFallback, "fallback", "fallbacks")}`,
    `posts ${postOutcomes}`,
    `${input.delta.policySkipped} policy-skipped`,
    `queue ${input.queueDepth}`,
    count(input.feedsFailing, "feed failing", "feeds failing"),
    `RSS ${formatBytesAsMegabytes(input.rssBytes)}`,
  ].join(" · ");
}

function ratio(successful: number, attempted: number): string {
  return attempted === 0 ? "n/a" : `${successful}/${attempted} ok`;
}

function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}
