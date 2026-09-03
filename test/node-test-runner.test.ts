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
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { parseStack } from "../src/stack-parse.ts";
import { chooseMode, rewriteFor } from "../src/node-test-hook.ts";
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

describe("the always-on layer under node --test", () => {
  const NODE_BIN = process.execPath;
  const REPORTER = fileURLToPath(new URL("../src/node-test-reporter.ts", import.meta.url));

  function runFailing(outputDir: string) {
    const env: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("VITEST") || key.startsWith("TINYPOOL")) continue;
      env[key] = value;
    }
    env.DEPUG_OUTPUT_DIR = outputDir;
    env.DEPUG_ROOT = FIXTURE;
    return spawnSync(
      NODE_BIN,
      ["--test", `--test-reporter=${REPORTER}`, "--test-reporter-destination=stdout", "failing.test.ts"],
      { cwd: FIXTURE, env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000 },
    );
  }

  it("writes evidence and prints two lines for each failure", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "depug-nodesnap-"));
    const result = runFailing(outputDir);
    expect(result.stdout.match(/^depug evidence: .+$/gm) ?? []).toHaveLength(2);
    expect(result.stdout.match(/^depug rerun: .+$/gm) ?? []).toHaveLength(2);

    // The same two failure shapes the vitest path distinguishes.
    expect(result.stdout).toContain("(the value's source already returned; rerun to reach it)");
    expect(result.stdout).toContain("(the failing call is in these frames)");

    const runs = readdirSync(outputDir).filter((name) => name.startsWith("run-"));
    const dir = join(outputDir, runs[0]);
    const propagation = readdirSync(dir).find((n) => n.includes("propagating"))!;
    const evidence = JSON.parse(readFileSync(join(dir, propagation), "utf8"));

    expect(evidence.test.framework).toBe("node:test");
    // Node's type stripping preserves positions, so the frame lands on the
    // author's own line with no source map in the path.
    expect(evidence.frames[0]).toMatchObject({ path: "src/app.ts", name: "explode", app: true });
    const source = readFileSync(join(FIXTURE, "src/app.ts"), "utf8").split("\n");
    expect(source[evidence.frames[0].line - 1]).toContain("throw new Error");
  }, 90_000);

  it("prints a rerun command that narrows the file to that test", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "depug-nodererun-"));
    runFailing(outputDir);
    const runs = readdirSync(outputDir).filter((name) => name.startsWith("run-"));
    const dir = join(outputDir, runs[0]);
    const propagation = readdirSync(dir).find((n) => n.includes("propagating"))!;
    const command = JSON.parse(readFileSync(join(dir, propagation), "utf8")).rerun_command as string;

    const args = command
      .replace(/^node /, "")
      .match(/"(?:[^"\\]|\\.)*"|--test-name-pattern=(?:"(?:[^"\\]|\\.)*")|\S+/g)!
      .map((token) => (token.startsWith('"') ? JSON.parse(token) : token));

    const env: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("VITEST") || key.startsWith("TINYPOOL")) continue;
      env[key] = value;
    }
    env.DEPUG_DISABLE = "1";

    const result = spawnSync(NODE_BIN, ["--test-reporter=tap", ...args], {
      cwd: FIXTURE,
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    // The file holds two failing tests; the command runs one.
    expect(`${result.stdout}${result.stderr}`).toMatch(/^# tests 1$/m);
  }, 90_000);
});

describe("reading a V8 stack string", () => {
  it("never throws, whatever text it is handed", () =>
    hegel.test((tc) => {
      // The string comes from a runner, and a runner that changes its
      // format should not take the reporter down with it.
      const stack = tc.draw(gs.text());
      const entries = parseStack(stack);
      for (const entry of entries) {
        expect(Number.isFinite(entry.line)).toBe(true);
        expect(Number.isFinite(entry.column)).toBe(true);
      }
    }));

  it("reads back the positions of frames it was given", () =>
    hegel.test((tc) => {
      // Build a stack the way V8 writes one, then check the positions
      // survive the parse.
      const frames = tc.draw(
        gs.arrays(
          gs.record({
            method: gs.sampledFrom(["fn", "Object.run", "<anonymous>", ""]),
            file: gs.text({ alphabet: "abc", minSize: 1, maxSize: 8 }),
            line: gs.integers({ minValue: 1, maxValue: 99999 }),
            column: gs.integers({ minValue: 1, maxValue: 999 }),
          }),
          { minSize: 1, maxSize: 12 },
        ),
      );

      const text = [
        "Error: something went wrong",
        ...frames.map((f) =>
          f.method === ""
            ? `    at file:///src/${f.file}.ts:${f.line}:${f.column}`
            : `    at ${f.method} (file:///src/${f.file}.ts:${f.line}:${f.column})`,
        ),
        // Node's own frames are dropped: they can never be app code, and a
        // reader should not step over the runner's internals.
        "    at Test.run (node:internal/test_runner/test:1397:25)",
      ].join("\n");

      const parsed = parseStack(text);
      expect(parsed).toHaveLength(frames.length);
      parsed.forEach((entry, index) => {
        expect(entry.line).toBe(frames[index].line);
        expect(entry.column).toBe(frames[index].column);
        expect(entry.file).toBe(`/src/${frames[index].file}.ts`);
      });
    }));

  it("keeps the first line, the error's own message, out of the frames", () =>
    hegel.test((tc) => {
      // A message can look like anything, including like a frame.
      const message = tc.draw(gs.text({ maxSize: 60 }));
      const parsed = parseStack(`Error: ${message}`);
      expect(parsed).toEqual([]);
    }));
});

describe("choosing what to do from the variables a verb set", () => {
  const ROOT = "/repo";
  const SOURCE = ["export function f(n: number): number {", "  return n + 1;", "}", ""].join("\n");

  it("does nothing at all when no verb asked for anything", () => {
    // The hook is preloaded by NODE_OPTIONS, which a project may have set
    // for its own reasons. Loading it must not instrument anything.
    expect(chooseMode({})).toBeUndefined();
  });

  it("builds the call index when a frames directory is named", () => {
    const mode = chooseMode({ DEPUG_FRAMES_DIR: "/tmp/x", DEPUG_INCLUDE: "src" })!;
    expect(mode.attributesTests).toBe(true);
    expect(rewriteFor(mode, ROOT, `${ROOT}/src/a.ts`, SOURCE)).toContain("__depug.enter");
    // Outside the include path, inside a dependency, or not TypeScript.
    expect(rewriteFor(mode, ROOT, `${ROOT}/other/a.ts`, SOURCE)).toBeUndefined();
    expect(rewriteFor(mode, ROOT, `${ROOT}/node_modules/x/a.ts`, SOURCE)).toBeUndefined();
    expect(rewriteFor(mode, ROOT, `${ROOT}/src/a.css`, SOURCE)).toBeUndefined();
    expect(rewriteFor(mode, ROOT, `${ROOT}/src/a.test.ts`, SOURCE)).toBeUndefined();
  });

  it("probes only the file holding a target", () => {
    const mode = chooseMode({ DEPUG_PROBE_TARGETS: JSON.stringify(["src/a.ts:f@1:17"]) })!;
    expect(rewriteFor(mode, ROOT, `${ROOT}/src/a.ts`, SOURCE)).toContain("__depugProbe.enter");
    expect(rewriteFor(mode, ROOT, `${ROOT}/src/b.ts`, SOURCE)).toBeUndefined();
  });

  it("traces only its target, and attributes events to a test", () => {
    const mode = chooseMode({
      DEPUG_FLT_DIR: "/tmp/x", DEPUG_FLT_PATH: "src/a.ts", DEPUG_FLT_NAME: "f",
      DEPUG_FLT_LINE: "1", DEPUG_FLT_COLUMN: "17", DEPUG_FLT_TARGET_K: "1",
    })!;
    expect(mode.attributesTests).toBe(true);
    expect(rewriteFor(mode, ROOT, `${ROOT}/src/a.ts`, SOURCE)).toContain("__depug_flt");
    expect(rewriteFor(mode, ROOT, `${ROOT}/src/b.ts`, SOURCE)).toBeUndefined();
  });

  it("injects only at its target's line, and attributes nothing", () => {
    const mode = chooseMode({
      DEPUG_EXEC_FID_PREFIX: "src/a.ts:f@1:17#", DEPUG_EXEC_CALL: "1",
      DEPUG_EXEC_LINE: "2", DEPUG_EXEC_VISIT: "1", DEPUG_EXEC_STATEMENT: "n = 9",
      DEPUG_EXEC_DIR: "/tmp/x",
    })!;
    // exec addresses one call by index; it has no use for a test window.
    expect(mode.attributesTests).toBeUndefined();
    expect(rewriteFor(mode, ROOT, `${ROOT}/src/a.ts`, SOURCE)).toContain("__depugExec.shouldRun");
    expect(rewriteFor(mode, ROOT, `${ROOT}/src/b.ts`, SOURCE)).toBeUndefined();
  });

  it("keeps the line count whichever mode is chosen", () =>
    hegel.test((tc) => {
      const extra = tc.draw(gs.integers({ minValue: 0, maxValue: 5 }));
      const body = Array.from({ length: extra }, (_, i) => `  const v${i} = ${i};`);
      const source = ["export function f(n: number): number {", ...body, "  return n + 1;", "}", ""].join("\n");

      const modes = [
        chooseMode({ DEPUG_FRAMES_DIR: "/tmp/x", DEPUG_INCLUDE: "src" })!,
        chooseMode({ DEPUG_PROBE_TARGETS: JSON.stringify(["src/a.ts:f@1:17"]) })!,
        chooseMode({
          DEPUG_FLT_DIR: "/tmp/x", DEPUG_FLT_PATH: "src/a.ts", DEPUG_FLT_NAME: "f",
          DEPUG_FLT_LINE: "1", DEPUG_FLT_COLUMN: "17", DEPUG_FLT_TARGET_K: "1",
        })!,
      ];
      for (const mode of modes) {
        const code = rewriteFor(mode, ROOT, `${ROOT}/src/a.ts`, source);
        expect(code).toBeDefined();
        expect(code!.split("\n")).toHaveLength(source.split("\n").length);
      }
    }));
});
