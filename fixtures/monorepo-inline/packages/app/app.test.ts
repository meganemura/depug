import { expect, it } from "vitest";
import { double } from "./src/app.ts";

it("doubles inside an inline project", () => {
  expect(double(21)).toBe(42);
});
