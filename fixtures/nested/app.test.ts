// The shape a flat fixture cannot check: a test inside a describe, with a
// name that is also a regular expression. vitest matches -t as a regex
// against the suite names and the test name joined by a space, so a rerun
// command built from the " > " form a reporter prints, or built without
// escaping, selects the wrong tests or none.
//
// The sibling name below extends this one, so an unanchored pattern
// selects both.
import { describe, expect, it } from "vitest";

describe("expandIPv6 (edge cases)", () => {
  it("fails on a $value", () => {
    expect(1).toBe(2);
  });

  it("fails on a $value too", () => {
    expect(1).toBe(2);
  });
});
