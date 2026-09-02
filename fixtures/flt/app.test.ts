import { expect, it } from "vitest";
import { classify, explode, guarded, makeAdder, sumUntil } from "./src/app.ts";

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

it("runs through try, catch, finally and switch", () => {
  expect(guarded(-1)).toBe("in-catch+finally+other");
});

it("builds an adder", () => {
  expect(makeAdder(10)(5)).toBe(15);
});
