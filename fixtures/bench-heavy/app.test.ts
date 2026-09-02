// Few events, heavy per-call body: the transform adds a fixed number of
// enter/exit calls regardless of how much work each call does, so this
// workload's instrumented/plain wall-time ratio should sit close to 1.0.
import { expect, it } from "vitest";
import { heavyWork } from "./src/app.ts";

const CALLS = 20;
const WORK_PER_CALL = 2_000_000;

it("calls a CPU-heavy function a few times", () => {
  let total = 0;
  for (let i = 0; i < CALLS; i++) {
    total += heavyWork(WORK_PER_CALL);
  }
  expect(Number.isFinite(total)).toBe(true);
});
