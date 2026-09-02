// Two concurrent calls to the same async function (`worker`), each
// awaiting a different number of times before both call a second shared
// function (`checkpoint`). `worker`'s own enter order is fixed by
// Promise.all's synchronous call order regardless of interleaving, so it
// alone would not test anything about resuming from an await. `checkpoint`
// is the one whose call order (and so whose fid) depends on which
// `worker` call resumes past its own awaits first -- that is what this
// test checks stays the same across two separate process runs of the
// same fixture.
import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runFixtureVitest } from "./support/run-fixture.ts";

interface DepugEvent {
  kind: "enter" | "exit" | "suspend" | "resume";
  fn: string;
}

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/interleave", import.meta.url));
const CONFIG = join(FIXTURE_DIR, "vitest.config.ts");

function runOnce(tmpDir: string, label: string): DepugEvent[] {
  const eventsFile = join(tmpDir, `events-${label}.json`);
  const result = runFixtureVitest(CONFIG, FIXTURE_DIR, { DEPUG_EVENTS_FILE: eventsFile });
  expect(result.status, `fixture run ${label} failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
  return JSON.parse(readFileSync(eventsFile, "utf8")) as DepugEvent[];
}

it(
  "assigns the same fid to the same call, in the same order, across two runs of an interleaved fixture",
  () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "depug-interleave-"));
    try {
      const run1 = runOnce(tmpDir, "1");
      const run2 = runOnce(tmpDir, "2");

      const checkpointEnters1 = run1.filter((e) => e.kind === "enter" && e.fn.includes(":checkpoint@"));
      expect(checkpointEnters1.length).toBe(2);

      // The real witness that interleaving happened, not just that both
      // workers ran to completion in call order: `worker("b", 1)` awaits
      // once, `worker("a", 3)` awaits three times, so if resuming past an
      // await actually interleaves the two calls, "b"'s exit (fewer hops)
      // comes before "a"'s exit in the recorded stream even though "a" was
      // the first one entered.
      const exitOrder = run1.filter((e) => e.kind === "exit" && e.fn.includes(":worker@")).map((e) => e.fn);
      const firstWorkerFn = run1.find((e) => e.kind === "enter" && e.fn.includes(":worker@"))?.fn;
      expect(exitOrder[0]).not.toBe(firstWorkerFn);

      // At minimum, the sequence enter events name each call, in order,
      // across both instrumented functions.
      const enterFids1 = run1.filter((e) => e.kind === "enter").map((e) => e.fn);
      const enterFids2 = run2.filter((e) => e.kind === "enter").map((e) => e.fn);
      expect(enterFids2).toEqual(enterFids1);

      // The fuller sequence, suspend/resume included, checked separately
      // rather than assumed to hold just because the enter-only sequence
      // above does.
      const fullSequence1 = run1.map((e) => `${e.kind}:${e.fn}`);
      const fullSequence2 = run2.map((e) => `${e.kind}:${e.fn}`);
      expect(fullSequence2).toEqual(fullSequence1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  },
  30_000,
);
