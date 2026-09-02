import { expect, it } from "vitest";
import { explode, total } from "./src/app.ts";

it("fails an assertion on a value that was already returned", () => {
  expect(total([1, 2, 3])).toBe(6);
});

it("fails with an error propagating out of app code", () => {
  explode();
});

it("passes and writes no evidence", () => {
  expect(total([1])).toBe(1);
});
