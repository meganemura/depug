// Standalone measurement script (not a vitest test): the per-event cost of
// the depug runtime collector, in isolation from vitest/transform/process
// overhead. Run with `node test/bench/per-event.ts`. Prints ns/event for
// several trials plus the median. The numbers are read off by hand;
// nothing here asserts.
import { createRuntime } from "../../src/runtime.ts";

const CALLS_PER_TRIAL = 2_000_000;
const TRIALS = 7;

function runTrial(): number {
  const runtime = createRuntime();
  const idPrefix = "bench:fn#";
  const start = process.hrtime.bigint();
  for (let i = 0; i < CALLS_PER_TRIAL; i++) {
    const callId = runtime.enter(idPrefix, 1, 1);
    runtime.exit(idPrefix, 1, 1, "return", callId);
  }
  const end = process.hrtime.bigint();
  const totalNs = Number(end - start);
  const events = CALLS_PER_TRIAL * 2; // one enter + one exit per call
  return totalNs / events;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// One untimed warm-up trial so JIT warm-up does not skew the first
// timed sample.
runTrial();

const results: number[] = [];
for (let t = 0; t < TRIALS; t++) {
  results.push(runTrial());
}

console.log(`calls per trial: ${CALLS_PER_TRIAL} (${CALLS_PER_TRIAL * 2} events)`);
console.log(`trials (n): ${TRIALS}`);
console.log(`ns/event per trial: ${results.map((r) => r.toFixed(2)).join(", ")}`);
console.log(`median ns/event: ${median(results).toFixed(2)}`);
