// depug against Node's own test runner, in a fixture with no vitest
// anywhere and no configuration of its own.
//
// The point of these is that the instrumentation is the same. depug
// rewrites TypeScript before it executes; vitest owns that step through a
// vite plugin and Node owns it through module.registerHooks, and the
// transforms, the ids, and the files on the other side do not change. A
// test that only exercised the vitest path would let that stop being true
// without saying so.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detectRunner, withNodeTestHook } from "../src/runner.ts";
import { runFrames } from "../src/verbs/frames.ts";
import { runProbe } from "../src/verbs/probe.ts";
import { runExec } from "../src/verbs/exec.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/node-test", import.meta.url));
const COMMAND = ["node", "--test", "app.test.ts"];

function records(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

describe("choosing a runner from the command", () => {
  it("reads node:test out of the command it was handed", () => {
    expect(detectRunner(["node", "--test", "app.test.ts"])).toBe("node");
    expect(detectRunner(["node", "--test-reporter=spec", "--test"])).toBe("node");
    expect(detectRunner(["npx", "vitest", "run", "a.test.ts"])).toBe("vitest");
    // The rerun line a failure prints is a vitest command, and it must not
    // be read as anything else.
    expect(detectRunner(["npx", "vitest", "run", "x.test.ts", "-t", "^a b$"])).toBe("vitest");
  });

  it("keeps whatever NODE_OPTIONS a project already set", () => {
    // Replacing it would drop settings the suite may need to run at all.
    const combined = withNodeTestHook("--max-old-space-size=4096");
    expect(combined.startsWith("--max-old-space-size=4096 ")).toBe(true);
    expect(combined).toContain("--import");
    expect(withNodeTestHook(undefined).startsWith("--import")).toBe(true);
  });
});

describe("the verbs against node --test", () => {
  it("indexes calls with the same ids the vitest path produces", () => {
    const result = runFrames({
      command: COMMAND,
      cwd: FIXTURE,
      includePathPrefix: `${FIXTURE}/src`,
    });
    const calls = records(result.files[0]).filter((r) => r.type === "call");
    // Relative path, TypeScript coordinates, per-test call index: the same
    // id grammar, from a runner that never sees a vite plugin.
    expect(calls.map((c) => c.fid)).toEqual([
      "src/app.ts:total@4:17#1",
      "src/app.ts:explode@8:17#1",
    ]);
    // Attribution works through node:test's own beforeEach.
    expect(calls[0].test).toBe("counts the rows");
    expect(calls[1].test).toBe("propagates an error out of app code");
  }, 120_000);

  it("records a throw as a throw", () => {
    const result = runFrames({
      command: COMMAND,
      cwd: FIXTURE,
      includePathPrefix: `${FIXTURE}/src`,
    });
    const returns = records(result.files[0]).filter((r) => r.type === "return");
    expect(returns.find((r) => String(r.fid).includes("explode"))?.exit_kind).toBe("throw");
  }, 120_000);

  it("probes a function's arguments and return", () => {
    const result = runProbe({
      command: COMMAND,
      cwd: FIXTURE,
      targets: ["src/app.ts:total@4:17"],
    });
    const fn = result.output.functions["src/app.ts:total@4:17"];
    expect(fn.calls).toBe(1);
    expect(fn.parameters[0].samples).toEqual(["[1, 2, 3]"]);
    expect(fn.returns.samples).toEqual(["3"]);
  }, 120_000);

  it("evaluates an expression in the running scope", () => {
    // The fixture passes on its own; changing `rows` mid-call makes the
    // assertion fail, which is what shows the expression reached the scope.
    const result = runExec({
      fid: "src/app.ts:total@4:17#1",
      atLine: 5,
      visit: 1,
      expression: "rows = [1,2,3,4,5]",
      command: COMMAND,
      cwd: FIXTURE,
    });
    expect(result.records[0]).toMatchObject({ type: "evaluation", value: "[1,2,3,4,5]" });
    expect(result.envelope.exit_status).not.toBe(0);
  }, 120_000);
});
