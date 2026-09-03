// The two reporters, called directly.
//
// A reporter is an object a runner hands events to, so the events can be
// handed over here instead. The end-to-end tests prove a real run reaches
// it; these reach the branches a real run rarely takes, which is where a
// reporter quietly writes the wrong thing.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import DepugReporter from "../src/reporter.ts";
import depugNodeReporter, { buildNodeRerunCommand } from "../src/node-test-reporter.ts";

let outputDir: string;
let written: string[];
let restore: () => void;

beforeEach(() => {
  outputDir = mkdtempSync(join(tmpdir(), "depug-reporters-"));
  written = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  restore = () => {
    process.stdout.write = original;
  };
});

afterEach(() => {
  restore();
  rmSync(outputDir, { recursive: true, force: true });
});

function failure(name: string, file: string, stack: { file: string; line: number; column: number }[]) {
  return {
    name,
    fullName: name,
    module: { moduleId: file },
    parent: { type: "module" },
    result: () => ({
      state: "failed",
      errors: [{ name: "AssertionError", message: "no", stack: "AssertionError: no", stacks: stack }],
    }),
  };
}

describe("the vitest reporter", () => {
  it("writes nothing at all for a run with no failures", () => {
    const reporter = new DepugReporter({ outputDir });
    reporter.onInit({ config: { root: "/repo" }, getSeed: () => null });
    reporter.onTestRunEnd();
    // No run directory, no index, no lines: a green suite pays nothing.
    expect(readdirSync(outputDir)).toEqual([]);
    expect(written).toEqual([]);
  });

  it("does nothing when it is switched off", () => {
    const previous = process.env.DEPUG_DISABLE;
    process.env.DEPUG_DISABLE = "1";
    try {
      const reporter = new DepugReporter({ outputDir });
      reporter.onInit({ config: { root: "/repo" }, getSeed: () => 1 });
      reporter.onTestCaseResult(failure("t", "/repo/a.test.ts", [{ file: "/repo/a.test.ts", line: 1, column: 1 }]));
      reporter.onTestRunEnd();
      expect(readdirSync(outputDir)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.DEPUG_DISABLE;
      else process.env.DEPUG_DISABLE = previous;
    }
  });

  it("ignores a test that passed", () => {
    const reporter = new DepugReporter({ outputDir });
    reporter.onInit({ config: { root: "/repo" }, getSeed: () => null });
    reporter.onTestCaseResult({ name: "ok", result: () => ({ state: "passed", errors: [] }) });
    // A failure with no error object carries nothing to record either.
    reporter.onTestCaseResult({ name: "odd", result: () => ({ state: "failed", errors: [] }) });
    reporter.onTestRunEnd();
    expect(readdirSync(outputDir)).toEqual([]);
  });

  it("keeps the seed out of the rerun command when the run had none", () => {
    const reporter = new DepugReporter({ outputDir });
    reporter.onInit({ config: { root: "/repo" }, getSeed: () => null });
    reporter.onTestCaseResult(failure("t", "/repo/a.test.ts", [{ file: "/repo/a.test.ts", line: 3, column: 5 }]));
    reporter.onTestRunEnd();
    // Adding --sequence.seed where the suite never set one would put a
    // value in the command the original run did not use.
    expect(written.join("")).not.toContain("--sequence.seed");
  });

  it("records how many frames it dropped when a stack is deeper than the limit", () =>
    hegel.test((tc) => {
      const depth = tc.draw(gs.integers({ minValue: 1, maxValue: 60 }));
      const dir = mkdtempSync(join(tmpdir(), "depug-frames-limit-"));
      try {
        const reporter = new DepugReporter({ outputDir: dir });
        reporter.onInit({ config: { root: "/repo" }, getSeed: () => null });
        reporter.onTestCaseResult(
          failure("t", "/repo/a.test.ts",
            Array.from({ length: depth }, (_, i) => ({ file: "/repo/a.ts", line: i + 1, column: 1 }))),
        );
        reporter.onTestRunEnd();

        const runDir = join(dir, readdirSync(dir).find((n) => n.startsWith("run-"))!);
        const file = readdirSync(runDir).find((n) => n !== "index.json")!;
        const evidence = JSON.parse(readFileSync(join(runDir, file), "utf8"));

        expect(evidence.frames.length).toBe(Math.min(depth, evidence.limits.max_frames));
        // The count is present exactly when something was actually dropped.
        expect("frames_omitted" in evidence).toBe(depth > evidence.limits.max_frames);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }));
});

describe("the node:test rerun command", () => {
  it("anchors and escapes the name it was given", () =>
    hegel.test((tc) => {
      const name = tc.draw(gs.text({ minSize: 1, maxSize: 40 }));
      const command = buildNodeRerunCommand("a.test.ts", name);
      const pattern = JSON.parse(/--test-name-pattern=("(?:[^"\\]|\\.)*")/.exec(command)![1]);
      expect(new RegExp(pattern).test(name)).toBe(true);
    }));
});

describe("the node:test reporter", () => {
  async function drive(events: unknown[]): Promise<string[]> {
    const out: string[] = [];
    const previousRoot = process.env.DEPUG_ROOT;
    const previousOut = process.env.DEPUG_OUTPUT_DIR;
    process.env.DEPUG_ROOT = "/repo";
    process.env.DEPUG_OUTPUT_DIR = outputDir;
    try {
      for await (const line of depugNodeReporter((async function* () {
        for (const event of events) yield event as never;
      })())) {
        out.push(line);
      }
    } finally {
      if (previousRoot === undefined) delete process.env.DEPUG_ROOT;
      else process.env.DEPUG_ROOT = previousRoot;
      if (previousOut === undefined) delete process.env.DEPUG_OUTPUT_DIR;
      else process.env.DEPUG_OUTPUT_DIR = previousOut;
    }
    return out;
  }

  it("ignores a suite's rollup, which names no error of its own", async () => {
    const lines = await drive([
      { type: "test:fail", data: { name: "group", file: "/repo/a.test.ts", details: { error: { failureType: "subtestsFailed" } } } },
      { type: "test:summary" },
    ]);
    expect(lines).toEqual([]);
    expect(readdirSync(outputDir)).toEqual([]);
  });

  it("ignores every event that is not a failure", async () => {
    const lines = await drive([
      { type: "test:pass", data: { name: "ok" } },
      { type: "test:start", data: { name: "ok" } },
      { type: "test:summary" },
    ]);
    expect(lines).toEqual([]);
  });

  it("writes evidence and two lines for a test's own failure", async () => {
    const cause = new Error("boom");
    cause.stack = [
      "Error: boom",
      "    at explode (file:///repo/src/a.ts:9:9)",
      "    at file:///repo/a.test.ts:4:3",
    ].join("\n");

    const lines = await drive([
      {
        type: "test:fail",
        data: { name: "fails", file: "/repo/a.test.ts", details: { error: { failureType: "testCodeFailure", cause } } },
      },
      { type: "test:summary" },
    ]);

    expect(lines.join("")).toContain("depug evidence:");
    expect(lines.join("")).toContain("depug rerun:");
    const runDir = join(outputDir, readdirSync(outputDir).find((n) => n.startsWith("run-"))!);
    const evidence = JSON.parse(
      readFileSync(join(runDir, readdirSync(runDir).find((n) => n !== "index.json")!), "utf8"),
    );
    expect(evidence.test.framework).toBe("node:test");
    expect(evidence.frames[0]).toMatchObject({ path: "src/a.ts", name: "explode", app: true });
  });
});
