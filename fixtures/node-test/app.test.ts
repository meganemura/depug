import { test } from "node:test";
import assert from "node:assert";
import { explode, total } from "./src/app.ts";

test("counts the rows", () => {
  assert.equal(total([1, 2, 3]), 3);
});

test("propagates an error out of app code", () => {
  assert.throws(() => explode(), /boom/);
});
