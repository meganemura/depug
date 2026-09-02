// Drives the CLI the way an agent would: take the command a failure
// printed, put a verb in front of it, read what comes back.
//
// These run real child processes against a fixture, because what is being
// checked is that the plugin reaches a separate vitest invocation at all.
// An in-process check would confirm the plugin works and say nothing about
// whether a verb can load it into someone else's test run.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFid, fidWithoutCall } from "../src/fid.ts";
import { applyConfigArgument, findProjectConfig } from "../src/wrapper-config.ts";
import { seedFromCommand } from "../src/verbs/frames.ts";
import { run } from "../src/cli.ts";

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/failing", import.meta.url));
const VITEST_BIN = fileURLToPath(new URL("../node_modules/.bin/vitest", import.meta.url));
const PROPAGATION_TEST = "fails with an error propagating out of app code";

function cli(...argv: string[]) {
  return run([...argv, "--cwd", FIXTURE_DIR, "--include", `${FIXTURE_DIR}/src`, "--",
    VITEST_BIN, "run", "app.test.ts", "-t", PROPAGATION_TEST]);
}

function readRecords(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

describe("reading a function id apart", () => {
  it("splits a path, a name, a position, and a call index", () => {
    expect(parseFid("src/user.ts:parseUser@12:17#2")).toEqual({
      path: "src/user.ts",
      name: "parseUser",
      line: 12,
      column: 17,
      call: 2,
    });
  });

  it("accepts a target with no call index, which names every call", () => {
    expect(parseFid("src/user.ts:parseUser@12:17")?.call).toBeUndefined();
    expect(fidWithoutCall("src/user.ts:parseUser@12:17#2")).toBe("src/user.ts:parseUser@12:17");
  });

  it("returns undefined rather than throwing on something that is not an id", () => {
    // A person retypes an id by hand; the verb reports it, not a stack.
    expect(parseFid("parseUser")).toBeUndefined();
    expect(parseFid("")).toBeUndefined();
  });
});

describe("loading the plugin into someone else's run", () => {
  it("finds the project's own config to build on", () => {
    expect(findProjectConfig(FIXTURE_DIR)).toBe(`${FIXTURE_DIR}/vitest.config.ts`);
  });

  it("replaces a --config the caller passed instead of adding a second one", () => {
    // Two --config arguments would let vitest choose, and the plugin would
    // silently not load.
    const result = applyConfigArgument(["run", "--config", "mine.ts", "x.test.ts"], "/tmp/w.ts");
    expect(result.replaced).toBe("mine.ts");
    expect(result.args).toEqual(["run", "x.test.ts", "--config", "/tmp/w.ts"]);
    expect(result.args.filter((a) => a === "--config")).toHaveLength(1);
  });

  it("reads the seed back out of the command for the envelope", () => {
    expect(seedFromCommand(["run", "--sequence.seed=42"])).toBe(42);
    expect(seedFromCommand(["run", "--sequence.seed", "7"])).toBe(7);
    expect(seedFromCommand(["run"])).toBeNull();
  });
});

describe("frames", () => {
  it("indexes the application call the test made, by relative path", () => {
    const result = cli("frames");
    const file = /^depug frames: (.+)$/m.exec(result.stdout)?.[1];
    expect(file, result.stdout).toBeTruthy();

    const records = readRecords(file!);
    const call = records.find((r) => r.type === "call")!;
    // The id is relative to the project, so it names the same function on
    // any machine holding the repository.
    expect(call.fid).toBe("src/app.ts:explode@9:17#1");
    expect(call.path).toBe("src/app.ts");
    expect(call.test).toBe(PROPAGATION_TEST);

    // The call left through a throw, and the index says so.
    const ret = records.find((r) => r.type === "return")!;
    expect(ret.fid).toBe(call.fid);
    expect(ret.exit_kind).toBe("throw");
  }, 120_000);

  it("closes the index with an envelope naming the command and how it ended", () => {
    const result = cli("frames");
    const file = /^depug frames: (.+)$/m.exec(result.stdout)![1];
    const envelope = readRecords(file).at(-1)!;
    expect(envelope.type).toBe("envelope");
    expect(envelope.exit_status).toBe(1);
    expect(envelope.command).toContain(PROPAGATION_TEST);
    expect((envelope.code_state as Record<string, unknown>).git_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.stdout).toContain("depug result: fail (exit 1)");
  }, 120_000);

  it("says so plainly when nothing under the include path ran", () => {
    // Pointing at a directory the test never reaches is a mistake a reader
    // should see named, not read as "this test called nothing".
    const result = run(["frames", "--cwd", FIXTURE_DIR, "--include", `${FIXTURE_DIR}/nowhere`,
      "--", VITEST_BIN, "run", "app.test.ts", "-t", PROPAGATION_TEST]);
    expect(result.stdout).toContain("no application calls were recorded");
    expect(result.stdout).toContain("use --include to point elsewhere");
  }, 120_000);
});

describe("preflight", () => {
  it("reports deterministic when two separate runs make the same calls", () => {
    const result = cli("preflight");
    expect(result.stdout).toMatch(/^depug preflight: deterministic \(app calls: 1\)$/m);
    // It names both indexes, so a reader can compare them by hand.
    const line = /^depug preflight indexes: (.+)$/m.exec(result.stdout)![1];
    expect(line.split(" ")).toHaveLength(2);
  }, 180_000);
});

describe("the command line itself", () => {
  it("refuses a call with no command after the separator", () => {
    expect(run(["frames"]).exitCode).toBe(2);
    expect(run(["frames"]).stdout).toContain("the command must follow `--`");
    expect(run(["frames", "--"]).stdout).toContain("no command followed `--`");
  });

  it("names an unknown verb rather than doing something else", () => {
    const result = run(["frame", "--", "x"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("unknown verb: frame");
  });

  it("prints usage with no arguments", () => {
    expect(run([]).exitCode).toBe(0);
    expect(run([]).stdout).toContain("depug <verb>");
  });
});
