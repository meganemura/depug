// The window-detection mechanism (beforeEach/afterEach setting one shared
// "current test" pointer) breaks under test.concurrent: two tests share a
// worker, so a slower test's events can be misattributed once a faster
// sibling has already run its own beforeEach or afterEach. This test
// demonstrates the break by running fixtures/concurrent for real, not by
// asserting a specific interleaving order (which is not exact-timing
// deterministic) but by asserting the resulting evidence: at least one
// function call's own entry and exit disagree about which test produced
// it, which no correct attribution could ever produce.
import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runFixtureVitest } from "./support/run-fixture.ts";

interface DepugEvent {
  kind: "enter" | "exit" | "suspend" | "resume";
  fn: string;
  test: string | null;
}

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/concurrent", import.meta.url));
const CONFIG = join(FIXTURE_DIR, "vitest.config.ts");

it(
  "misattributes at least one concurrent call's test window",
  () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "depug-concurrent-"));
    const eventsFile = join(tmpDir, "events.json");
    try {
      const result = runFixtureVitest(CONFIG, FIXTURE_DIR, { DEPUG_EVENTS_FILE: eventsFile });
      expect(result.status, `fixture run failed:\n${result.stdout}\n${result.stderr}`).toBe(0);

      // This test is about the window pointer on `tag`'s own two calls, so
      // it narrows to those. Filtering by name rather than counting every
      // event keeps the check from moving whenever the transform starts
      // covering another kind of function, such as the arrow the fixture
      // passes to `new Promise`.
      const allEvents = JSON.parse(readFileSync(eventsFile, "utf8")) as DepugEvent[];
      const events = allEvents.filter(
        (e) => (e.kind === "enter" || e.kind === "exit") && e.fn.includes(":tag@"),
      );
      expect(events).toHaveLength(4);

      const byFn = new Map<string, DepugEvent[]>();
      for (const event of events) {
        const list = byFn.get(event.fn) ?? [];
        list.push(event);
        byFn.set(event.fn, list);
      }
      expect(byFn.size).toBe(2);

      const mismatched = [...byFn.values()].filter(([enter, exit]) => enter.test !== exit.test);
      expect(mismatched.length).toBeGreaterThan(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  },
  30_000,
);
