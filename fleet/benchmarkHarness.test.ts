import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runBenchmark} from './benchmarkHarness.ts';

test('runBenchmark runs N synthetic bots against the local mock server and reports plausible RSS samples', async () => {
  const report = await runBenchmark({
    botCount: 3,
    durationMs: 2000,
    sampleIntervalMs: 200,
    itemsPerPoll: 5,
    imageEveryNItems: 2,
    fetchIntervalMinutes: 0.02, // ~1.2s - several poll cycles within the 2s window
  });

  assert.ok(
    report.steadyStateRssBytes > 0,
    'steady-state RSS must be a real, positive measurement',
  );
  assert.ok(
    report.peakRssBytes >= report.steadyStateRssBytes,
    'peak must be at least the steady-state value',
  );
  assert.ok(report.sampleCount >= 5, 'expected multiple samples over a 2s run at a 200ms interval');
});

test('runBenchmark tears down cleanly - no open handles keep the process alive', async () => {
  // node:test fails the run if the process can't exit naturally; a leaked
  // HTTP server or FeedSub interval would hang here rather than assert false.
  await runBenchmark({
    botCount: 1,
    durationMs: 500,
    sampleIntervalMs: 100,
    itemsPerPoll: 2,
    imageEveryNItems: 0,
    fetchIntervalMinutes: 0.02,
  });
  assert.ok(true, 'reaching this line without hanging is the actual assertion');
});
