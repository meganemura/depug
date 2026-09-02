// exec is the one verb that changes what the program computes, so its
// tests check two things the others do not: that an injected expression
// actually reached the running scope, and that it cannot fire without the
// launcher arming it.
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createExecRuntime, renderExecValue } from "../src/exec-runtime.ts";
import { instrumentExec } from "../src/exec-transform.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli.ts";

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/flt", import.meta.url));
const VITEST_BIN = fileURLToPath(new URL("../node_modules/.bin/vitest", import.meta.url));
const SUM_UNTIL = "src/app.ts:sumUntil@18:17#1";

function exec(...extra: string[]) {
  return run([
    "exec", SUM_UNTIL, "--cwd", FIXTURE_DIR, ...extra,
    "--", VITEST_BIN, "run", "app.test.ts", "-t", "sums up to a limit",
  ]);
}

describe("the injection gate", () => {
  it("evaluates nothing when the launcher did not arm it", () => {
    // An instrumented file left behind by a crashed run still calls the
    // guard. The guard has to say no.
    const runtime = createExecRuntime({
      fidPrefix: "src/app.ts:f@1:1#",
      targetCall: 1,
      targetLine: 5,
      targetVisit: 1,
      armed: false,
    });
    expect(runtime.shouldRun(runtime.enter(), 5)).toBe(false);
  });

  it("evaluates on the named call, line, and visit, and no other", () => {
    const runtime = createExecRuntime({
      fidPrefix: "src/app.ts:f@1:1#",
      targetCall: 2,
      targetLine: 5,
      targetVisit: 2,
      armed: true,
    });
    const first = runtime.enter();
    expect(runtime.shouldRun(first, 5)).toBe(false); // wrong call
    const second = runtime.enter();
    expect(runtime.shouldRun(second, 6)).toBe(false); // wrong line
    expect(runtime.shouldRun(second, 5)).toBe(false); // right line, visit 1
    expect(runtime.shouldRun(second, 5)).toBe(true); // visit 2
    expect(runtime.shouldRun(second, 5)).toBe(false); // visit 3
  });

  it("reports which visits happened when the requested one never did", () => {
    const runtime = createExecRuntime({
      fidPrefix: "src/app.ts:f@1:1#",
      targetCall: 1,
      targetLine: 5,
      targetVisit: 9,
      armed: true,
    });
    const call = runtime.enter();
    runtime.shouldRun(call, 5);
    runtime.shouldRun(call, 5);
    expect(runtime.dump()).toEqual([
      expect.objectContaining({
        type: "evaluation_summary",
        line_visits_observed: 2,
        target_visit: 9,
        evaluated: false,
      }),
    ]);
  });

  it("reports a call that never happened, rather than an empty file", () => {
    const runtime = createExecRuntime({
      fidPrefix: "src/app.ts:f@1:1#",
      targetCall: 3,
      targetLine: 5,
      targetVisit: 1,
      armed: true,
    });
    runtime.enter();
    expect(runtime.dump()).toEqual([
      expect.objectContaining({ type: "target_summary", observed_calls: 1, target_index: 3 }),
    ]);
  });
});

describe("the injection rewrite", () => {
  it("keeps the line count and refuses a line holding no statement", () => {
    const source = readFileSync(join(FIXTURE_DIR, "src/app.ts"), "utf8");
    const target = { name: "sumUntil", line: 18, column: 17, expression: "total = 1" };

    const good = instrumentExec(source, "src/app.ts", { ...target, targetLine: 21 });
    expect(good.injected).toBe(true);
    expect(good.code.split("\n")).toHaveLength(source.split("\n").length);

    const bad = instrumentExec(source, "src/app.ts", { ...target, targetLine: 1 });
    expect(bad.injected).toBe(false);
    expect(bad.code).toBe(source);
    // The lines that would have worked, so a caller can correct the aim.
    expect(bad.candidateLines).toContain(21);
  });

  it("renders a value shallowly and survives one that will not render", () => {
    expect(renderExecValue(10)).toBe("10");
    expect(renderExecValue("a")).toBe('"a"');
    expect(renderExecValue(null)).toBe("null");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(renderExecValue(circular)).toBe("<render threw>");
  });
});

describe("exec through the command line", () => {
  it("assigns a local in the running scope and changes the outcome", () => {
    // The fixture's test passes on its own. Setting `total` mid-loop makes
    // it fail, which is the proof that the expression reached the scope
    // rather than a copy of it.
    const result = exec("--line", "21", "--statement", "total = 100");
    expect(result.stdout).toContain("depug value: 100");
    expect(result.stdout).toContain("depug result: fail (exit 1)");
  }, 120_000);

  it("records an expression that throws instead of losing the run", () => {
    const result = exec("--line", "21", "--statement", 'JSON.parse("{")');
    expect(result.stdout).toMatch(/depug raised: SyntaxError/);
  }, 120_000);

  it("refuses an id with no call index", () => {
    const result = run([
      "exec", "src/app.ts:sumUntil@18:17", "--cwd", FIXTURE_DIR, "--line", "21",
      "--statement", "total = 1", "--", VITEST_BIN, "run", "app.test.ts",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("including #k");
  });

  it("names the missing option rather than running the command", () => {
    expect(exec("--statement", "total = 1").stdout).toContain("exec needs --line");
    expect(exec("--line", "21").stdout).toContain("exec needs --statement");
  });
});
