import { test } from "node:test";
import assert from "node:assert";
import { order } from "./src/sort.ts";

test("orders two numbers", () => {
  assert.deepEqual(order([2, 1]), [1, 2]);
});
