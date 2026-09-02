import { expect, it } from "vitest";
import { classify, explode, sumUntil } from "./src/app.ts";

it("classifies numbers", () => {
  expect(classify(5)).toBe("positive");
  expect(classify(-3)).toBe("negative");
});

it("sums up to a limit", () => {
  expect(sumUntil(4)).toBe(6);
});

it("explodes", () => {
  expect(() => explode()).toThrow("boom");
});
