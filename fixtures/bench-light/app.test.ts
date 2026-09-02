// Many events, trivial per-call body: the transform's fixed per-call
// enter/exit cost is a much larger share of each call's own time here, so
// this workload's instrumented/plain wall-time ratio should be well above
// bench-heavy's, in proportion to the event count, not to a fixed factor.
import { expect, it } from "vitest";
import { trivialWork } from "./src/app.ts";

const ITERATIONS = 2_000_000;

it("calls a trivial function many times", () => {
  let total = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    total += trivialWork(i);
  }
  expect(total).toBeGreaterThan(0);
});
