// Drives the CLI the way an agent would: take the command a failure
// printed, put a verb in front of it, read what comes back.
//
// These run real child processes against a fixture, because what is being
// checked is that the plugin reaches a separate vitest invocation at all.
// An in-process check would confirm the plugin works and say nothing about
// whether a verb can load it into someone else's test run.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { parseFid, fidWithoutCall, formatFid } from "../src/fid.ts";
import { applyConfigArgument, findProjectConfig } from "../src/wrapper-config.ts";
import { eventsToJsonl, flushWorker, readWorkerFiles, toFrameRecord } from "../src/collector.ts";
import { createRuntime } from "../src/runtime.ts";
import { seedFromCommand } from "../src/verbs/frames.ts";
import { formatPreflight } from "../src/verbs/preflight.ts";
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

describe("a function id survives being written and read back", () => {
  it("round-trips any id the transform can produce", () =>
    hegel.test((tc) => {
      // The shapes the transform actually emits: a relative path, a name
      // that is an identifier or one of the synthetic labels, a position,
      // and a call index.
      const path = tc.draw(gs.text({ alphabet: "abc/._-", minSize: 1, maxSize: 20 }));
      const name = tc.draw(
        gs.sampledFrom(["parseUser", "#private", "<anonymous>", "<computed>", "constructor", "f"]),
      );
      const line = tc.draw(gs.integers({ minValue: 1, maxValue: 100000 }));
      const column = tc.draw(gs.integers({ minValue: 1, maxValue: 500 }));
      const call = tc.draw(gs.optional(gs.integers({ minValue: 1, maxValue: 10000 })));

      const original = { path, name, line, column, call: call ?? undefined };
      const written = formatFid(original);
      const read = parseFid(written);
      // Compare against the value that went in, not against the text that
      // came out: `format(parse(format(x))) === format(x)` holds even for
      // a format that drops a field, because it drops it both times.
      expect(read).toEqual(original);
    }));

  it("never throws on text that is not an id", () =>
    hegel.test((tc) => {
      // A person retypes an id by hand. Every verb takes one, so the parse
      // has to answer rather than raise.
      const text = tc.draw(gs.text());
      const parsed = parseFid(text);
      if (parsed !== undefined) {
        // Whatever it accepted has to read back as what it was given.
        expect(formatFid(parsed)).toBe(text);
      }
    }));
});

describe("writing the index a verb reads back", () => {
  it("emits one parseable line for every event it can name", () =>
    hegel.test((tc) => {
      // The file is the interface. A line a reader cannot parse is not a
      // partial record, it is a broken one.
      const events = tc.draw(
        gs.arrays(
          gs.record({
            kind: gs.sampledFrom(["enter", "exit", "suspend", "resume"] as const),
            fn: gs.tuples(
              gs.text({ alphabet: "abc/", minSize: 1, maxSize: 8 }),
              gs.sampledFrom(["f", "<anonymous>", "#p"]),
              gs.integers({ minValue: 1, maxValue: 999 }),
              gs.integers({ minValue: 1, maxValue: 99 }),
              gs.integers({ minValue: 1, maxValue: 99 }),
            ).map(([p, n, l, c, k]) => `${p}.ts:${n}@${l}:${c}#${k}`),
            line: gs.integers({ minValue: 1, maxValue: 999 }),
            column: gs.integers({ minValue: 1, maxValue: 99 }),
            test: gs.optional(gs.text({ maxSize: 20 })),
          }),
          { maxSize: 25 },
        ),
      );

      const jsonl = eventsToJsonl(events);
      const lines = jsonl === "" ? [] : jsonl.trimEnd().split("\n");
      expect(lines).toHaveLength(events.length);

      lines.forEach((line, index) => {
        const record = JSON.parse(line);
        expect(record.fid).toBe(events[index].fn);
        // Only an entry says which call it began inside; the others have
        // no such claim to make.
        expect("parent" in record).toBe(events[index].kind === "enter");
      });
    }));

  it("drops an event whose id it cannot read, rather than writing half a record", () =>
    hegel.test((tc) => {
      const broken = tc.draw(gs.text({ maxSize: 20 }).filter((s) => !s.includes("@")));
      expect(
        toFrameRecord({ kind: "enter", fn: broken, line: 1, column: 1, test: null }),
      ).toBeUndefined();
    }));
});

describe("comparing two runs", () => {
  it("names where two runs first differed, and says the test is not eligible", () => {
    // A divergence is the answer preflight exists to give. Reporting it as
    // a bare "not deterministic" would leave a reader with nowhere to look.
    const report = formatPreflight({
      deterministic: false,
      callCount: 2,
      secondCallCount: 2,
      fullMatched: false,
      divergence: { index: 1, first: "src/a.ts:f@1:1#1", second: "src/a.ts:g@2:1#1" },
      files: [["/tmp/a.jsonl"], ["/tmp/b.jsonl"]],
      exitStatuses: [1, 1],
    });
    expect(report).toContain("first divergence at call 1");
    expect(report).toContain("src/a.ts:f@1:1#1");
    expect(report).toContain("src/a.ts:g@2:1#1");
    expect(report).toContain("not eligible");
  });

  it("notes a suspend order that differed without calling the test ineligible", () => {
    // The verbs address calls, so a difference in suspend order is worth
    // saying and is not a reason to refuse.
    const report = formatPreflight({
      deterministic: true,
      callCount: 3,
      secondCallCount: 3,
      fullMatched: false,
      files: [[], []],
      exitStatuses: [0, 0],
    });
    expect(report).toContain("deterministic (app calls: 3)");
    expect(report).toContain("suspend and resume order differed");
    expect(report).not.toContain("not eligible");
  });

  it("reports a run that ended with no status at all", () => {
    // A child killed or timed out has no exit status, and reading that as
    // a pass would be the worst of the three outcomes to get wrong.
    const report = formatPreflight({
      deterministic: true, callCount: 0, secondCallCount: 0, fullMatched: true,
      files: [[], []], exitStatuses: [null, null],
    });
    expect(report).toContain("app calls: 0");
  });
});

describe("reading worker files back", () => {
  it("round-trips events through the file a worker writes", () =>
    hegel.test((tc) => {
      // The file is how a verb in the parent learns what happened in a
      // worker. Anything lost between the two is lost for good.
      const count = tc.draw(gs.integers({ minValue: 0, maxValue: 12 }));
      const dir = mkdtempSync(join(tmpdir(), "depug-worker-"));
      try {
        const runtime = createRuntime();
        for (let i = 0; i < count; i++) {
          const prefix = `src/a.ts:f${i % 3}@1:1#`;
          const call = runtime.enter(prefix, 1, 1);
          runtime.exit(prefix, 1, 1, "return", call);
        }
        flushWorker(dir, runtime);

        const files = readWorkerFiles(dir);
        const records = files.flatMap((f) => f.records);
        expect(records).toHaveLength(count * 2);
        expect(records.filter((r) => r.type === "call")).toHaveLength(count);
        // The worker names its own file, so several workers do not collide.
        if (count > 0) expect(files[0].path).toContain(`frames-${process.pid}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }));

  it("reads an absent directory as no records, not as a failure", () => {
    // A run that instrumented nothing writes no directory, and a verb has
    // to report that rather than fall over reading it.
    expect(readWorkerFiles(join(tmpdir(), "depug-does-not-exist-000"))).toEqual([]);
  });
});

describe("what the command line refuses", () => {
  it("names an unknown option instead of ignoring it", () => {
    const result = run(["frames", "--wat", "x", "--", "node"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("unknown option: --wat");
  });

  it("asks for the operand each verb needs", () => {
    expect(run(["probe", "--", "node"]).stdout).toContain("probe needs a function id");
    expect(run(["flt", "--", "node"]).stdout).toContain("flt needs a function id");
    expect(run(["exec", "--", "node"]).stdout).toContain("exec needs a function id");
  });

  it("refuses an flt target with no call index", () => {
    // `#k` is what makes the address name one call rather than a function.
    const result = run(["flt", "src/a.ts:f@1:1", "--", "node"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("#k");
  });

  it("prints the same usage for --help as for no arguments", () => {
    expect(run(["--help"]).stdout).toBe(run([]).stdout);
    expect(run(["-h"]).exitCode).toBe(0);
  });

  it("reports a malformed --at rather than guessing what was meant", () => {
    const result = run([
      "frames", "--cwd", FIXTURE_DIR, "--at", "nofile.ts:3",
      "--", VITEST_BIN, "run", "app.test.ts", "-t", PROPAGATION_TEST,
    ]);
    expect(result.stdout).toContain("could not read");
  }, 120_000);
});
