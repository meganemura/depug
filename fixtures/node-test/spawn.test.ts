import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { total } from "./src/app.ts";

test("reads the JSON a child Node CLI prints", () => {
  const child = spawnSync(process.execPath, ["-e", 'process.stdout.write(JSON.stringify({ rows: [1, 2] }) + "\\n")'], {
    encoding: "utf8",
  });
  assert.equal(total(JSON.parse(child.stdout).rows), 2);
});
