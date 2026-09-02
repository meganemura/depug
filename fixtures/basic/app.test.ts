// Stands in for a project's own test file. It exercises the app functions
// under two named tests, to check that events attribute to the right
// test, and checks that the fixture's own vitest.config.ts settings are
// still active under the depug wrapper config. The afterAll dump is test
// scaffolding, not part of depug: a real verb would read events itself,
// in-process, rather than round-tripping them through a file for an
// outer process to inspect.
import { afterAll, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { addOne, greet, withCleanup } from "./src/app.ts";

declare const __FIXTURE_MARKER__: string;

it("first test calls addOne", () => {
  expect(__FIXTURE_MARKER__).toBe("fixture-original-config");
  expect(globalThis.__FIXTURE_SETUP_RAN__).toBe(true);
  addOne(1);
});

it("second test calls greet and withCleanup", () => {
  greet("world");
  withCleanup(2);
});

afterAll(() => {
  const path = process.env.DEPUG_EVENTS_FILE;
  if (!path) return;
  const depug = (globalThis as { __depug?: { dump(): unknown[] } }).__depug;
  writeFileSync(path, JSON.stringify(depug ? depug.dump() : []));
});
