// Runs a fixture whose tests really fail, through a real vitest process
// with depug's reporter registered, and checks what a reader would
// actually get: two printed lines, one evidence file for each failure, and
// a rerun command that runs that one test.
//
// The rerun command is executed here rather than pattern-matched. A
// command that looks right and selects three tests would pass any check
// that only reads it.
import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runFixtureVitest, type FixtureRunResult } from "./support/run-fixture.ts";

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/failing", import.meta.url));
const CONFIG = join(FIXTURE_DIR, "vitest.config.ts");
const VITEST_BIN = fileURLToPath(new URL("../node_modules/.bin/vitest", import.meta.url));

const ASSERTION_TEST = "fails an assertion on a value that was already returned";
const PROPAGATION_TEST = "fails with an error propagating out of app code";

interface Frame {
  path: string | null;
  line: number | null;
  name: string | null;
  app: boolean;
}

interface Evidence {
  schema_version: number;
  kind: string;
  capture_mode: string;
  code_state: { git_sha: string | null; dirty_digest: string | null };
  test: { framework: string; name: string; file: string; line: number | null };
  error: { name: string; message: string; stack: string };
  frames: Frame[];
  rerun_command: string | null;
  limits: Record<string, number>;
}

let run: FixtureRunResult;
let runDir: string;
let evidence: Record<string, Evidence>;

beforeAll(() => {
  const outputDir = mkdtempSync(join(tmpdir(), "depug-snap-"));
  run = runFixtureVitest(CONFIG, FIXTURE_DIR, { DEPUG_OUTPUT_DIR: outputDir });

  const runs = readdirSync(outputDir).filter((name) => name.startsWith("run-"));
  expect(runs, `no run directory was written:\n${run.stdout}\n${run.stderr}`).toHaveLength(1);
  runDir = join(outputDir, runs[0]);

  evidence = {};
  for (const file of readdirSync(runDir)) {
    if (file === "index.json") continue;
    const parsed = JSON.parse(readFileSync(join(runDir, file), "utf8")) as Evidence;
    evidence[parsed.test.name] = parsed;
  }

  // `latest` is written in the same step, so it is checked from here too.
  expect(realpathSync(join(outputDir, "latest"))).toBe(realpathSync(runDir));
});

describe("what a failing suite prints", () => {
  it("prints an evidence path and a rerun command for each failure", () => {
    const evidenceLines = run.stdout.match(/^depug evidence: .+$/gm) ?? [];
    const rerunLines = run.stdout.match(/^depug rerun: .+$/gm) ?? [];
    expect(evidenceLines).toHaveLength(2);
    expect(rerunLines).toHaveLength(2);
    // The path is absolute, so it can be opened from any directory.
    for (const line of evidenceLines) expect(line).toMatch(/depug evidence: \//);
  });

  it("says whether the snapshot can answer, or whether a rerun is needed", () => {
    expect(run.stdout).toContain("(the value's source already returned; rerun to reach it)");
    expect(run.stdout).toContain("(the failing call is in these frames)");
  });

  it("writes nothing for a test that passed", () => {
    // The fixture holds 3 tests and 2 of them fail.
    expect(Object.keys(evidence).sort()).toEqual([ASSERTION_TEST, PROPAGATION_TEST].sort());
  });
});

describe("what the evidence file holds", () => {
  it("keeps the failure text and the code state", () => {
    const propagation = evidence[PROPAGATION_TEST];
    expect(propagation.schema_version).toBe(1);
    expect(propagation.kind).toBe("snap");
    expect(propagation.capture_mode).toBe("failure_text");
    expect(propagation.error).toMatchObject({ name: "Error", message: "boom from app code" });
    expect(propagation.error.stack).toContain("boom from app code");
    // This suite runs inside a git repository, so both parts are readable.
    expect(propagation.code_state.git_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(propagation.code_state.dirty_digest).not.toBeNull();
  });

  it("marks the app frame the error propagated out of", () => {
    const frames = evidence[PROPAGATION_TEST].frames;
    expect(frames[0]).toMatchObject({ path: "src/app.ts", name: "explode", app: true });
    // The producer is still on the stack, so this snapshot can answer.
    expect(frames.filter((f) => f.app && f.path !== "app.test.ts")).not.toHaveLength(0);
  });

  it("shows an assertion failure with no frame outside the test file", () => {
    const frames = evidence[ASSERTION_TEST].frames;
    expect(frames.length).toBeGreaterThan(0);
    // `total` returned before the assertion threw, so nothing in the stack
    // names it. This is the shape that needs a rerun.
    expect(frames.filter((f) => f.app && f.path !== "app.test.ts")).toHaveLength(0);
  });

  it("records positions in TypeScript coordinates", () => {
    // `explode` throws on line 10 of the fixture source. A position taken
    // from the JavaScript vitest executed would not match the file.
    const source = readFileSync(join(FIXTURE_DIR, "src/app.ts"), "utf8").split("\n");
    const frame = evidence[PROPAGATION_TEST].frames[0];
    expect(source[frame.line! - 1]).toContain("throw new Error");
  });
});

describe("the run index", () => {
  it("lists every failure with a path relative to the run directory", () => {
    const index = JSON.parse(readFileSync(join(runDir, "index.json"), "utf8"));
    expect(index.schema_version).toBe(1);
    expect(index.failures).toHaveLength(2);
    for (const failure of index.failures) {
      expect(failure.path).not.toContain("/");
      expect(readFileSync(join(runDir, failure.path), "utf8")).toContain('"kind": "snap"');
    }
  });
});

describe("the printed rerun command", () => {
  it("runs that one test and no other", () => {
    const command = evidence[PROPAGATION_TEST].rerun_command!;
    expect(command).toContain(PROPAGATION_TEST);

    // Execute the command's own arguments, rather than a re-derived set,
    // so this checks what was printed. `npx vitest` becomes the local
    // binary because the fixture is not a package of its own.
    const args = command
      .replace(/^npx vitest /, "")
      .match(/"[^"]*"|\S+/g)!
      .map((token) => (token.startsWith('"') ? JSON.parse(token) : token));

    const env: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("VITEST") || key.startsWith("TINYPOOL")) continue;
      env[key] = value;
    }
    env.DEPUG_DISABLE = "1";

    const result = spawnSync(VITEST_BIN, args, {
      cwd: FIXTURE_DIR,
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    // The fixture holds 3 tests; the command must select exactly the one.
    expect(output, output).toMatch(/Tests\s+1 failed \| 2 skipped \(3\)/);
  }, 90_000);
});

describe("a rerun command for a test inside a describe", () => {
  // A flat fixture cannot catch this. vitest joins the suite and test
  // names with a space and matches the result as a regular expression, so
  // the " > " form, an unescaped name, or a missing anchor each selects
  // something other than the one test.
  const NESTED_DIR = fileURLToPath(new URL("../fixtures/nested", import.meta.url));

  it("selects exactly the one test, and not its sibling", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "depug-nested-"));
    const nestedRun = runFixtureVitest(join(NESTED_DIR, "vitest.config.ts"), NESTED_DIR, {
      DEPUG_OUTPUT_DIR: outputDir,
    });

    const runs = readdirSync(outputDir).filter((name) => name.startsWith("run-"));
    const dir = join(outputDir, runs[0]);
    const file = readdirSync(dir).find((name) => name !== "index.json")!;
    const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as Evidence;

    const command = parsed.rerun_command!;
    const args = command
      .replace(/^npx vitest /, "")
      .match(/"(?:[^"\\]|\\.)*"|\S+/g)!
      .map((token) => (token.startsWith('"') ? JSON.parse(token) : token));

    const env: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("VITEST") || key.startsWith("TINYPOOL")) continue;
      env[key] = value;
    }
    env.DEPUG_DISABLE = "1";

    const result = spawnSync(VITEST_BIN, args, {
      cwd: NESTED_DIR,
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    // Two tests exist and one is a prefix of the other. Exactly one runs.
    expect(output, `${command}\n${output}\n${nestedRun.stdout}`).toMatch(
      /Tests\s+1 failed \| 1 skipped \(2\)/,
    );
  }, 90_000);
});
