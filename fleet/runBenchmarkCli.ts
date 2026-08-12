// fleet/runBenchmarkCli.ts
import {runBenchmark} from './benchmarkHarness.ts';
import {formatBytesAsMegabytes} from './memoryLog.ts';

function log(message: string): void {
  console.log(`[${new Date().toUTCString()}] - [bsky.rss BENCH] ${message}`);
}

async function main(): Promise<void> {
  const botCount = Number(process.env.BENCH_BOT_COUNT ?? '59');
  const durationMs = Number(process.env.BENCH_DURATION_MS ?? '60000');
  const sampleIntervalMs = Number(process.env.BENCH_SAMPLE_INTERVAL_MS ?? '1000');
  const itemsPerPoll = Number(process.env.BENCH_ITEMS_PER_POLL ?? '3');
  const imageEveryNItems = Number(process.env.BENCH_IMAGE_EVERY_N ?? '2');
  const fetchIntervalMinutes = Number(process.env.BENCH_FETCH_INTERVAL_MINUTES ?? '0.1');

  log(
    `Running synthetic benchmark: ${botCount} bots, ${durationMs}ms duration, ` +
      `${itemsPerPoll} items/poll, image every ${imageEveryNItems} item(s)`,
  );

  const report = await runBenchmark({
    botCount,
    durationMs,
    sampleIntervalMs,
    itemsPerPoll,
    imageEveryNItems,
    fetchIntervalMinutes,
  });

  log(`Steady-state RSS: ${formatBytesAsMegabytes(report.steadyStateRssBytes)}`);
  log(`Peak RSS:         ${formatBytesAsMegabytes(report.peakRssBytes)}`);
  log(`Samples taken:    ${report.sampleCount}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
