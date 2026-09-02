// Drives the CLI end to end, the way an agent would: run `frames` first to
// discover a call's real fid (the same two-step an agent takes: `frames`
// names the calls, `flt` follows one of them), then run `flt` against it
// through a real vitest child process. This is what proves the embedded
// line/column literals survive vite/esbuild for flt's own transform, the
// way test/wrapper-config.test.ts proves it for the always-on one.
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.ts";

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/flt", import.meta.url));
const VITEST_BIN = fileURLToPath(new URL("../node_modules/.bin/vitest", import.meta.url));

function cli(...argv: string[]) {
  return run([...argv, "--cwd", FIXTURE_DIR, "--", VITEST_BIN, "run", "app.test.ts"]);
}

function readRecords(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function framesFile(): string {
  const result = cli("frames");
  const file = /^depug frames: (.+)$/m.exec(result.stdout)?.[1];
  if (!file) throw new Error(`frames produced no index: ${result.stdout}`);
  return file;
}

/** The fid `frames` recorded for the k-th call to a named function. */
function fidFor(records: readonly Record<string, unknown>[], name: string, k: number): string {
  const call = records.find(
    (r) => r.type === "call" && typeof r.fid === "string" && (r.fid as string).includes(`:${name}@`) && (r.fid as string).endsWith(`#${k}`),
  );
  if (!call) throw new Error(`frames recorded no call ${name}#${k}`);
  return call.fid as string;
}

function fltFileFrom(stdout: string): string {
  const file = /^depug flt: (.+)$/m.exec(stdout)?.[1];
  if (!file) throw new Error(`flt produced no file: ${stdout}`);
  return file;
}

describe("flt", () => {
  it("follows one call and shows call, then a line per statement, then return, reconstructing a block exit", () => {
    const fid = fidFor(readRecords(framesFile()), "classify", 2);
    const result = cli("flt", fid);

    const records = readRecords(fltFileFrom(result.stdout));
    expect(records[0]).toMatchObject({ type: "call" });
    expect(records.some((r) => r.type === "line")).toBe(true);
    // `classify(-3)` takes the `else if` branch, whose block-scoped `sign`
    // must appear and then leave scope once the whole if/else-if/else
    // statement finishes.
    expect(
      records.some(
        (r) => r.type === "line" && Array.isArray((r as { out_of_scope?: unknown }).out_of_scope) && (r.out_of_scope as string[]).includes("sign"),
      ),
    ).toBe(true);
    const withoutEnvelope = records.filter((r) => r.type !== "envelope");
    expect(withoutEnvelope.at(-1)).toMatchObject({ type: "return", value: { value: '"negative"' } });

    const envelope = records.find((r) => r.type === "envelope")!;
    expect(envelope.traced).toBe(true);
    expect(result.stdout).toContain("depug result: pass (exit 0)");
  }, 180_000);

  it("folds a loop's middle iterations, keeping the first and the last", () => {
    const fid = fidFor(readRecords(framesFile()), "sumUntil", 1);
    const result = cli("flt", fid);
    const records = readRecords(fltFileFrom(result.stdout));
    expect(records.find((r) => r.type === "skipped_iterations")).toMatchObject({ count: 2 });
  }, 180_000);

  it("records a throw for a call that exits through one", () => {
    const fid = fidFor(readRecords(framesFile()), "explode", 1);
    const result = cli("flt", fid);
    const records = readRecords(fltFileFrom(result.stdout));
    const withoutEnvelope = records.filter((r) => r.type !== "envelope");
    expect(withoutEnvelope.at(-1)).toMatchObject({ type: "throw", name: "Error", message: { value: '"boom"' } });
  }, 180_000);

  it("reports traced:false and a target_summary when the requested #k never happened", () => {
    const fid = fidFor(readRecords(framesFile()), "classify", 1);
    const missingFid = fid.replace(/#\d+$/, "#5"); // classify only ran twice in this test file

    const result = cli("flt", missingFid);
    const records = readRecords(fltFileFrom(result.stdout));
    const envelope = records.find((r) => r.type === "envelope")!;
    expect(envelope.traced).toBe(false);
    expect(envelope.observed_calls).toBe(2);
    expect(records.some((r) => r.type === "target_summary")).toBe(true);
    expect(result.stdout).toContain("depug note: call #5 did not happen; observed 2 call(s) of this function");
  }, 180_000);

  it("refuses when --index's code state does not match this run's working tree", () => {
    const file = framesFile();
    const fid = fidFor(readRecords(file), "classify", 1);

    // A hand-written envelope with a code_state that cannot match any real
    // checkout, appended the same way `frames` appends its own -- no
    // actual git mutation needed to exercise the mismatch path.
    const badIndex = `${file}.bad-code-state.jsonl`;
    const original = readFileSync(file, "utf8");
    const badEnvelope = { type: "envelope", code_state: { git_sha: "0".repeat(40), dirty_digest: "clean" } };
    writeFileSync(badIndex, `${original}${JSON.stringify(badEnvelope)}\n`);

    const result = cli("flt", fid, "--index", badIndex);
    expect(result.stdout).toContain("depug flt: refused");
    expect(result.stdout).toContain("does not match this run's working tree");
  }, 180_000);

  it("names an incomplete fid rather than guessing which call was meant", () => {
    const result = run(["flt", "src/app.ts:classify@4:17", "--cwd", FIXTURE_DIR, "--", VITEST_BIN, "run", "app.test.ts"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("needs a complete function id, including #k");
  });
});
