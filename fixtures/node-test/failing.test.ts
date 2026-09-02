import { describe, test } from "node:test";
import assert from "node:assert";
import { explode, total } from "./src/app.ts";

describe("group (a)", () => {
  test("fails an assertion on a value that was already returned", () => {
    assert.equal(total([1, 2, 3]), 6);
  });

  test("fails with an error propagating out of app code", () => {
    explode();
  });
});
