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
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  buildRerunCommand,
  buildSnapError,
  buildTestNamePattern,
  evidenceFileName,
  linkLatest,
  runDirName,
  writeJson,
  writeRunIndex,
} from "../src/evidence.ts";
import { hasProducerFrame, isAppFile, toEvidenceFrames } from "../src/stack.ts";
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

describe("the -t pattern selects the test it names, and nothing else", () => {
  // This is the bug that shipped. vitest matches -t as a regular
  // expression against the suite and test names joined by a space, and a
  // pattern that is not escaped, or not anchored, selects the wrong tests
  // or none. Generated names are the point: the failure needed a name with
  // a regex metacharacter in it, and a hand-written fixture had none.
  it("matches its own full name, for any names a suite could use", () =>
    hegel.test((tc) => {
      const depth = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
      const namePath = tc.draw(
        gs.arrays(gs.text({ minSize: 1, maxSize: 30 }), { minSize: depth, maxSize: depth }),
      );
      const pattern = buildTestNamePattern(namePath);
      expect(new RegExp(pattern).test(namePath.join(" "))).toBe(true);
    }));

  it("does not also select a test whose name merely starts with it", () =>
    hegel.test((tc) => {
      // Without anchors, "saves a draft" also selects "saves a draft and
      // publishes it", and a rerun runs two tests while claiming one.
      const namePath = tc.draw(gs.arrays(gs.text({ minSize: 1, maxSize: 20 }), { minSize: 1, maxSize: 3 }));
      const suffix = tc.draw(gs.text({ minSize: 1, maxSize: 10 }));
      const longer = `${namePath.join(" ")}${suffix}`;
      tc.assume(longer !== namePath.join(" "));
      expect(new RegExp(buildTestNamePattern(namePath)).test(longer)).toBe(false);
    }));

  it("puts the pattern into the command so it survives being read back", () =>
    hegel.test((tc) => {
      const namePath = tc.draw(gs.arrays(gs.text({ minSize: 1, maxSize: 20 }), { minSize: 1, maxSize: 3 }));
      const command = buildRerunCommand({ testFile: "a.test.ts", namePath, seed: null });
      // The command is text a person copies. Reading the -t argument back
      // has to give the pattern, quotes and escapes intact.
      //
      // `[\s\S]` rather than `.`: a test name can contain U+2028, which
      // JSON.stringify leaves raw and a JS regex's `.` does not match.
      const quoted = /-t ([\s\S]*)$/.exec(command)![1];
      expect(JSON.parse(quoted)).toBe(buildTestNamePattern(namePath));
    }));
});

describe("naming an evidence file", () => {
  it("produces a name a filesystem accepts, for any test name", () =>
    hegel.test((tc) => {
      // Test names carry anything: slashes, emoji, newlines, nothing at all.
      const ordinal = tc.draw(gs.integers({ minValue: 1, maxValue: 999 }));
      const name = tc.draw(gs.optional(gs.text()));
      const fileName = evidenceFileName(ordinal, name);
      expect(fileName).toMatch(/^\d{3}-[a-z0-9-]+\.json$/);
      // The ordinal is what orders the directory, so it has to survive.
      expect(fileName.slice(0, 3)).toBe(String(ordinal).padStart(3, "0"));
    }));

  it("gives two different failures two different files", () =>
    hegel.test((tc) => {
      // The ordinal exists so that two tests with the same name, or with
      // names that slug to the same text, do not overwrite each other.
      const a = tc.draw(gs.integers({ minValue: 1, maxValue: 999 }));
      const b = tc.draw(gs.integers({ minValue: 1, maxValue: 999 }));
      tc.assume(a !== b);
      const name = tc.draw(gs.text());
      expect(evidenceFileName(a, name)).not.toBe(evidenceFileName(b, name));
    }));
});

describe("deciding which frames are the project's own", () => {
  it("counts a file under the root and outside its dependencies", () =>
    hegel.test((tc) => {
      const segments = tc.draw(
        gs.arrays(gs.text({ alphabet: "abcdef", minSize: 1, maxSize: 6 }), { minSize: 1, maxSize: 4 }),
      );
      const root = "/repo";
      expect(isAppFile(root, `${root}/${segments.join("/")}.ts`)).toBe(true);
      // A dependency is not the project's own code, at any depth.
      expect(isAppFile(root, `${root}/node_modules/${segments.join("/")}.ts`)).toBe(false);
      // Neither is anything outside the root.
      expect(isAppFile(root, `/elsewhere/${segments.join("/")}.ts`)).toBe(false);
    }));

  it("keeps the frames in order and never invents one", () =>
    hegel.test((tc) => {
      const entries = tc.draw(
        gs.arrays(
          gs.record({
            method: gs.text({ alphabet: "abc", maxSize: 5 }),
            file: gs.text({ alphabet: "abc/", minSize: 1, maxSize: 10 }).map((p) => `/repo/${p}.ts`),
            line: gs.integers({ minValue: 1, maxValue: 9999 }),
            column: gs.integers({ minValue: 1, maxValue: 200 }),
          }),
          { maxSize: 30 },
        ),
      );
      const limit = tc.draw(gs.integers({ minValue: 0, maxValue: 40 }));
      const frames = toEvidenceFrames(entries, "/repo", limit);

      expect(frames.length).toBe(Math.min(entries.length, limit));
      frames.forEach((frame, index) => {
        expect(frame.index).toBe(index);
        expect(frame.line).toBe(entries[index].line);
        // Paths come out relative, so an evidence file reads the same
        // wherever the checkout is.
        expect(frame.path?.startsWith("/")).toBe(false);
      });
    }));
});

describe("the pieces that write the run directory", () => {
  it("names a run directory that sorts by time and stays unique per process", () =>
    hegel.test((tc) => {
      const pid = tc.draw(gs.integers({ minValue: 1, maxValue: 999999 }));
      const stamp = tc.draw(gs.integers({ minValue: 0, maxValue: 2_000_000_000_000 }));
      const name = runDirName(new Date(stamp), pid);
      expect(name).toMatch(/^run-\d{8}-\d{6}-\d+$/);
      // Two runs of the same process at the same second would collide, and
      // two processes at the same second must not.
      expect(name.endsWith(`-${pid}`)).toBe(true);
    }));

  it("keeps a long failure message but says it cut it", () =>
    hegel.test((tc) => {
      const limits = { max_frames: 20, max_value_length: 200, max_elements: 10, max_samples: 10 };
      const length = tc.draw(gs.integers({ minValue: 0, maxValue: 3000 }));
      const error = buildSnapError("AssertionError", "m".repeat(length), "stack", limits);

      const allowance = limits.max_value_length * 5;
      expect(error.message.length).toBeLessThanOrEqual(allowance);
      // The flag and the original length are present exactly when
      // something was cut, so a reader can tell a short message from a
      // truncated one.
      expect(error.message_truncated === true).toBe(length > allowance);
      if (length > allowance) expect(error.message_original_length).toBe(length);
    }));

  it("writes an index whose every path opens", () => {
    const dir = mkdtempSync(join(tmpdir(), "depug-index-"));
    try {
      writeJson(join(dir, "001-a.json"), { kind: "snap" });
      const indexPath = writeRunIndex(dir, [
        { path: "001-a.json", test: { framework: "vitest", name: "a", file: "a.ts", line: 1 },
          error: { name: "E", message: "m" } },
      ]);
      const index = JSON.parse(readFileSync(indexPath, "utf8"));
      expect(index.failures).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(dir, index.failures[0].path), "utf8")).kind).toBe("snap");

      // `latest` points at the run that just finished.
      linkLatest(dir, dir);
      expect(realpathSync(join(dir, "latest"))).toBe(realpathSync(dir));
      // Pointing it a second time replaces it rather than failing.
      linkLatest(dir, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says whether the snapshot holds the code that produced the value", () =>
    hegel.test((tc) => {
      const testFile = "a.test.ts";
      const producers = tc.draw(gs.integers({ minValue: 0, maxValue: 5 }));
      const frames = [
        ...Array.from({ length: producers }, (_, i) => ({
          index: i, path: "src/app.ts", line: i + 1, column: 1, name: "f", app: true,
        })),
        { index: producers, path: testFile, line: 1, column: 1, name: null, app: true },
      ];
      // This is what decides which of the two lines a failure prints.
      expect(hasProducerFrame(frames, testFile)).toBe(producers > 0);
    }));
});
