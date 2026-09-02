// Two concurrent tests, one slower than the other, to force interleaving.
// The afterAll dump is test scaffolding (see fixtures/basic/app.test.ts).
import { afterAll, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import { tag } from "./src/app.ts";

test.concurrent("slow test", async () => {
  const result = await tag("slow", 50);
  expect(result).toBe("slow");
});

test.concurrent("fast test", async () => {
  const result = await tag("fast", 5);
  expect(result).toBe("fast");
});

afterAll(() => {
  const path = process.env.DEPUG_EVENTS_FILE;
  if (!path) return;
  const depug = (globalThis as { __depug?: { dump(): unknown[] } }).__depug;
  writeFileSync(path, JSON.stringify(depug ? depug.dump() : []));
});
