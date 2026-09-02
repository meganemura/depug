// Runs two concurrent calls to the same function (`worker`), each
// awaiting a different number of times before calling a second shared
// function (`checkpoint`), inside one Promise.all. The afterAll dump is
// test scaffolding, not part of depug (see fixtures/basic/app.test.ts).
import { afterAll, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { worker } from "./src/app.ts";

it("runs two interleaved workers concurrently", async () => {
  const [a, b] = await Promise.all([worker("a", 3), worker("b", 1)]);
  expect(a).toBe("a");
  expect(b).toBe("b");
});

afterAll(() => {
  const path = process.env.DEPUG_EVENTS_FILE;
  if (!path) return;
  const depug = (globalThis as { __depug?: { dump(): unknown[] } }).__depug;
  writeFileSync(path, JSON.stringify(depug ? depug.dump() : []));
});
