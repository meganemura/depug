// Standalone measurement script (not a vitest test): whole-suite wall time
// with and without the depug transform, for two workloads that hold the
// event count and the per-call body cost inversely proportional to each
// other. Run with `node test/bench/suite-overhead.ts`. Prints per-trial
// times, medians, and the ratio for each workload. The numbers are read
// off by hand; nothing here asserts.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const VITEST_BIN = fileURLToPath(new URL("../../node_modules/.bin/vitest", import.meta.url));
const RUNS = 5;

function runOnce(configPath: string, cwd: string): number {
  const start = performance.now();
  const result = spawnSync(VITEST_BIN, ["run", "--config", configPath], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
  });
  const end = performance.now();
  if (result.status !== 0) {
    throw new Error(`run failed (${configPath}):\n${result.stdout}\n${result.stderr}`);
  }
  return end - start;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function bench(
  name: string,
  fixtureDir: string,
  plainConfig: string,
  instrumentedConfig: string,
): void {
  const plainPath = join(fixtureDir, plainConfig);
  const instrumentedPath = join(fixtureDir, instrumentedConfig);

  // One untimed run per config first, so file-system and module caches are
  // warm before any timed trial.
  runOnce(plainPath, fixtureDir);
  runOnce(instrumentedPath, fixtureDir);

  const plainTimes: number[] = [];
  for (let i = 0; i < RUNS; i++) plainTimes.push(runOnce(plainPath, fixtureDir));
  const instrumentedTimes: number[] = [];
  for (let i = 0; i < RUNS; i++) instrumentedTimes.push(runOnce(instrumentedPath, fixtureDir));

  const plainMedian = median(plainTimes);
  const instrumentedMedian = median(instrumentedTimes);

  console.log(`\n=== ${name} ===`);
  console.log(`plain (ms), n=${RUNS}: ${plainTimes.map((t) => t.toFixed(1)).join(", ")}`);
  console.log(`median plain: ${plainMedian.toFixed(1)} ms`);
  console.log(
    `instrumented (ms), n=${RUNS}: ${instrumentedTimes.map((t) => t.toFixed(1)).join(", ")}`,
  );
  console.log(`median instrumented: ${instrumentedMedian.toFixed(1)} ms`);
  console.log(`ratio (instrumented / plain): ${(instrumentedMedian / plainMedian).toFixed(3)}`);
}

const heavyDir = fileURLToPath(new URL("../../fixtures/bench-heavy", import.meta.url));
const lightDir = fileURLToPath(new URL("../../fixtures/bench-light", import.meta.url));

bench(
  "bench-heavy (20 calls, 2e6 iterations each -> 40 events)",
  heavyDir,
  "vitest.config.ts",
  "vitest.instrumented.config.ts",
);
bench(
  "bench-light (2e6 trivial calls -> 4e6 events)",
  lightDir,
  "vitest.config.ts",
  "vitest.instrumented.config.ts",
);
