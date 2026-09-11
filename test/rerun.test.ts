// Checks that a run stopped by the clock leaves nothing behind.
//
// The point of the verb is the process table after it returns, so that
// is what these assert. A test that only read the exit code would pass
// against a supervisor that times out and orphans the whole tree, which
// is the shape this exists to prevent: three runs of a command like the
// one a failure prints were found on one machine after 8 to 12 days,
// each holding a core.
//
// The blocking fixture is written per test and its processes are matched
// by a marker unique to that file, so a failure here cannot leave one
// running under someone else's name.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TIMED_OUT, guardedCommand, runRerun, withoutGuard } from "../src/verbs/rerun.ts";

let scratch: string | undefined;
let marker: string | undefined;

/** PIDs whose command line holds the marker. */
function survivors(needle: string): string[] {
  try {
    const out = execFileSync("/bin/sh", ["-c", `pgrep -f ${JSON.stringify(needle)} || true`], {
      encoding: "utf8",
    });
    return out.split("\n").filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

function blocker(): { file: string; needle: string } {
  scratch = mkdtempSync(join(tmpdir(), "depug-rerun-"));
  marker = `depugblock${process.pid}${Math.random().toString(36).slice(2, 8)}`;
  const file = join(scratch, `${marker}.test.mjs`);
  // `Atomics.wait` rather than a spin loop. The event loop is just as
  // stuck either way, which is the property under test, but a spin loop
  // burns a core for as long as it runs and this suite runs its files in
  // parallel. A sibling project traced two flaky timing tests to exactly
  // that and changed its own fixture the same way.
  writeFileSync(
    file,
    'import { test } from "node:test";\n' +
      'test("blocks", () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });\n',
  );
  return { file, needle: marker };
}

afterEach(() => {
  // Belt and braces: whatever the assertions did, nothing is left stuck.
  if (marker) {
    try {
      execFileSync("/bin/sh", ["-c", `pkill -9 -f ${JSON.stringify(marker)} || true`]);
    } catch {
      // pkill finding nothing is the good case.
    }
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
  marker = undefined;
});

describe("runRerun", () => {
  it("returns a finished command's own exit code without waiting for the clock", async () => {
    const started = Date.now();
    const ok = await runRerun({ command: ["node", "-e", "process.exit(0)"], cwd: process.cwd(), timeoutMs: 60_000 });
    const bad = await runRerun({ command: ["node", "-e", "process.exit(3)"], cwd: process.cwd(), timeoutMs: 60_000 });

    expect(ok).toMatchObject({ exitCode: 0, timedOut: false });
    expect(bad).toMatchObject({ exitCode: 3, timedOut: false });
    // The clock must not hold the process open once the child is done.
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it("stops a run that never returns, and leaves no process behind", async () => {
    const { file, needle } = blocker();

    const result = await runRerun({
      command: ["node", "--test", file],
      cwd: process.cwd(),
      timeoutMs: 3_000,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(TIMED_OUT);
    // The assertion that matters. `--test-timeout` cannot do this: the
    // timer it needs is on the blocked worker's own event loop.
    expect(survivors(needle)).toEqual([]);
  }, 60_000);

  it("reports the command it could not start rather than throwing", async () => {
    const result = await runRerun({
      command: ["depug-no-such-binary-exists"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(127);
    expect(result.timedOut).toBe(false);
  }, 30_000);
});

describe("the guard around a printed command", () => {
  it("wraps a command and takes the wrapper back off", () => {
    const plain = 'npx vitest run "test/a.test.ts" -t "^adds$"';
    const guarded = guardedCommand(plain);
    expect(guarded).toBe(`npx depug rerun -- ${plain}`);
    expect(withoutGuard(guarded.split(" "))).toEqual(plain.split(" "));
  });

  it("leaves a command that carries no guard alone", () => {
    // Including ones that merely start with the same words, which a
    // prefix match on text rather than on tokens would eat.
    expect(withoutGuard(["node", "--test", "a.mjs"])).toEqual(["node", "--test", "a.mjs"]);
    expect(withoutGuard(["npx", "depug", "frames"])).toEqual(["npx", "depug", "frames"]);
    expect(withoutGuard(["npx", "vitest", "run"])).toEqual(["npx", "vitest", "run"]);
  });

  it("accepts the forms a reader ends up with after editing", () => {
    // Without `npx`, and without the `--` that is easy to delete.
    expect(withoutGuard(["depug", "rerun", "--", "node", "--test"])).toEqual(["node", "--test"]);
    expect(withoutGuard(["depug", "rerun", "node", "--test"])).toEqual(["node", "--test"]);
    // A guard with nothing after it is not a command; keep it as written
    // so the error names what was actually typed.
    expect(withoutGuard(["npx", "depug", "rerun", "--"])).toEqual(["npx", "depug", "rerun", "--"]);
  });
});
