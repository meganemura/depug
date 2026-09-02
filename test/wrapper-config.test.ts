// A fixture run through the depug wrapper config still runs with the
// fixture's own settings, app events attribute to the test that produced
// them, and those events carry the position the plugin's transform hook
// measured from the original TypeScript source.
import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runFixtureVitest } from "./support/run-fixture.ts";

interface DepugEvent {
  kind: "enter" | "exit";
  fn: string;
  line: number;
  column: number;
  test: string | null;
}

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/basic", import.meta.url));
const WRAPPER_CONFIG = join(FIXTURE_DIR, "vitest.depug.config.ts");

it(
  "runs the fixture's own tests through the depug wrapper config, preserving its settings",
  () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "depug-wrapper-"));
    const eventsFile = join(tmpDir, "events.json");
    try {
      const result = runFixtureVitest(WRAPPER_CONFIG, FIXTURE_DIR, {
        DEPUG_EVENTS_FILE: eventsFile,
      });

      // The fixture's own tests assert `__FIXTURE_MARKER__` (from its
      // vitest.config.ts `define`) and `__FIXTURE_SETUP_RAN__` (from its
      // own setupFiles entry) still hold under the wrapper config. A
      // non-zero exit means one of those assertions failed, i.e. the
      // user's config did not survive.
      expect(result.status, `fixture run failed:\n${result.stdout}\n${result.stderr}`).toBe(0);

      const events = JSON.parse(readFileSync(eventsFile, "utf8")) as DepugEvent[];
      // A plugin that never ran would leave this file empty (the afterAll
      // dump would still fire, but __depug would be undefined).
      expect(events.length).toBeGreaterThan(0);

      const byFn = new Map<string, DepugEvent[]>();
      for (const event of events) {
        const list = byFn.get(event.fn) ?? [];
        list.push(event);
        byFn.set(event.fn, list);
      }

      const addOneCall = [...byFn.entries()].find(([fn]) => fn.includes(":addOne@"))?.[1];
      const greetCall = [...byFn.entries()].find(([fn]) => fn.includes(":greet@"))?.[1];
      const withCleanupCall = [...byFn.entries()].find(([fn]) => fn.includes(":withCleanup@"))?.[1];

      expect(addOneCall?.[0]).toMatchObject({ line: 1, column: 17, test: "first test calls addOne" });
      expect(greetCall?.[0]).toMatchObject({
        line: 5,
        column: 17,
        test: "second test calls greet and withCleanup",
      });
      // withCleanup is declared past line 10 in the fixture source; this is
      // the assertion that would fail if the plugin's `enforce: "pre"`
      // transform hook ever started seeing post-esbuild JS instead of the
      // original TypeScript.
      expect(withCleanupCall?.[0]).toMatchObject({
        line: 14,
        column: 17,
        test: "second test calls greet and withCleanup",
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  },
  30_000,
);
