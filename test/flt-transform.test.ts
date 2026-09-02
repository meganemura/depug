// Runs the flt transform and its runtime together, in-process, through
// Node's own type-stripping loader: no vite, no esbuild, no child process.
// This is the same technique test/transform.test.ts uses for the
// always-on transform, and for the same reason -- it runs the
// instrumented code for real, which a syntax check alone cannot confirm,
// while staying fast enough to cover branches, a fold, and a throw as
// separate cases. test/flt.test.ts additionally runs the fixture through
// a real vitest process, which is what proves the embedded positions
// survive esbuild.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { instrumentTarget, type FltTarget } from "../src/flt-transform.ts";
import { createFltRuntime, type FltLineRecord, type FltRecord } from "../src/flt-runtime.ts";
import type { FltLimits } from "../src/flt-render.ts";

const FIXTURE_PATH = join(process.cwd(), "fixtures/flt/src/app.ts");
const FIXTURE_ID = "fixtures/flt/src/app.ts";
const fixtureSource = readFileSync(FIXTURE_PATH, "utf8");
const LIMITS: FltLimits = { max_value_length: 200, max_elements: 10 };

const CLASSIFY: FltTarget = { name: "classify", line: 4, column: 17 };
const SUM_UNTIL: FltTarget = { name: "sumUntil", line: 18, column: 17 };
const EXPLODE: FltTarget = { name: "explode", line: 26, column: 17 };

describe("instrumentTarget: line count and matching", () => {
  it("keeps the file's line count unchanged for each of the fixture's targets", () => {
    for (const target of [CLASSIFY, SUM_UNTIL, EXPLODE]) {
      const { code, found } = instrumentTarget(fixtureSource, FIXTURE_ID, target);
      expect(found, target.name).toBe(true);
      expect(code.split("\n").length).toBe(fixtureSource.split("\n").length);
    }
  });

  it("inserts no newline characters", () => {
    const { code } = instrumentTarget(fixtureSource, FIXTURE_ID, CLASSIFY);
    const originalLines = fixtureSource.split("\n");
    const newLines = code.split("\n");
    for (let i = 0; i < originalLines.length; i++) {
      expect(newLines[i].length).toBeGreaterThanOrEqual(originalLines[i].length);
    }
  });

  it("reports not found, and returns the source untouched, for a position with no function", () => {
    const result = instrumentTarget(fixtureSource, FIXTURE_ID, { name: "nope", line: 1, column: 1 });
    expect(result.found).toBe(false);
    expect(result.code).toBe(fixtureSource);
  });
});

/** Loads one target's instrumented fixture through Node's own loader. */
async function loadInstrumented(
  target: FltTarget,
  targetK: number,
  tmpDir: string,
): Promise<{ mod: typeof import("../fixtures/flt/src/app.ts"); dump: () => { records: FltRecord[]; observedCalls: number } }> {
  const { code, found } = instrumentTarget(fixtureSource, FIXTURE_ID, target);
  expect(found, target.name).toBe(true);
  const runtime = createFltRuntime(targetK, LIMITS);
  globalThis.__depug_flt = runtime;
  const outFile = join(tmpDir, `${target.name}-${targetK}-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(outFile, code);
  const mod = await import(/* @vite-ignore */ pathToFileURL(outFile).href);
  return { mod, dump: () => runtime.dump() };
}

/**
 * Reconstructs the visible locals as of every record, one snapshot per
 * record so the result lines up index-for-index with `records`: a record
 * that carries no locals of its own (skipped_iterations, return, throw)
 * repeats whatever the last `call`/`line` record established.
 */
function reconstruct(records: readonly FltRecord[]): Record<string, unknown>[] {
  const snapshots: Record<string, unknown>[] = [];
  let state: Record<string, unknown> = {};
  for (const record of records) {
    if (record.type === "call") {
      state = { ...record.locals };
    } else if (record.type === "line") {
      const line = record as FltLineRecord;
      for (const name of line.out_of_scope) delete state[name];
      for (const [name, value] of Object.entries(line.new)) state[name] = value;
      for (const [name, change] of Object.entries(line.changed)) state[name] = change.new;
    }
    snapshots.push({ ...state });
  }
  return snapshots;
}

describe("classify: branches, assignments, and a block exit", () => {
  it("records call, then a line per statement, then return", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "flt-classify-"));
    try {
      const { mod, dump } = await loadInstrumented(CLASSIFY, 1, tmp);
      expect(mod.classify(5)).toBe("positive");
      const { records } = dump();
      expect(records[0]).toMatchObject({ type: "call", locals: { n: { value: "5" } } });
      expect(records.some((r) => r.type === "line")).toBe(true);
      expect(records.at(-1)).toMatchObject({ type: "return", value: { value: '"positive"' } });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reconstructs the visible locals at every line, including a block-scoped local going out of scope", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "flt-classify-"));
    try {
      const { mod, dump } = await loadInstrumented(CLASSIFY, 1, tmp);
      mod.classify(-3);
      const { records } = dump();

      // `sign` is declared inside the taken branch and must appear, then
      // disappear once the if/else-if/else statement as a whole finishes.
      const withSign = records.find((r) => r.type === "line" && "sign" in r.new);
      expect(withSign).toBeDefined();
      const afterBranch = records.find((r) => r.type === "line" && (r as FltLineRecord).out_of_scope.includes("sign"));
      expect(afterBranch).toBeDefined();

      const snapshots = reconstruct(records);
      // Right after `sign` leaves scope, it must be gone from the
      // reconstructed state, and `label` must hold what the branch set.
      const index = records.indexOf(afterBranch!);
      expect(snapshots[index]).not.toHaveProperty("sign");
      expect(snapshots[index]).toMatchObject({ n: { value: "-3" }, label: { value: '"negative"' } });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("sumUntil: folding a loop's middle iterations", () => {
  it("keeps the first and the last iteration, and folds the rest into one skipped_iterations record with the right count", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "flt-sum-"));
    try {
      const { mod, dump } = await loadInstrumented(SUM_UNTIL, 1, tmp);
      expect(mod.sumUntil(4)).toBe(6); // 4 iterations: i = 0, 1, 2, 3

      const { records } = dump();
      const skipped = records.find((r) => r.type === "skipped_iterations");
      expect(skipped).toMatchObject({ type: "skipped_iterations", count: 2 });

      const lineRecords = records.filter((r) => r.type === "line" && "i" in (r as FltLineRecord).new) as FltLineRecord[];
      // The first iteration's own line record shows `i` newly visible at 0.
      expect(lineRecords[0].new.i).toMatchObject({ value: "0" });

      const skippedIndex = records.indexOf(skipped!);
      const lastIterationLine = records[skippedIndex + 1] as FltLineRecord;
      expect(lastIterationLine.type).toBe("line");
      // Reconstructing across the fold still lands on the loop's real final state.
      expect(lastIterationLine.changed.i).toMatchObject({ old: { value: "0" }, new: { value: "3" } });
      expect(lastIterationLine.changed.total).toMatchObject({ old: { value: "0" }, new: { value: "6" } });

      const afterLoop = records.find((r) => r.type === "line" && (r as FltLineRecord).out_of_scope.includes("i"));
      expect(afterLoop).toBeDefined();

      const snapshots = reconstruct(records);
      const afterLoopIndex = records.indexOf(afterLoop!);
      expect(snapshots[afterLoopIndex]).not.toHaveProperty("i");
      expect(snapshots[afterLoopIndex]).toMatchObject({ total: { value: "6" } });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("explode: a call that exits by throwing", () => {
  it("records a throw with the error's name and rendered message", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "flt-explode-"));
    try {
      const { mod, dump } = await loadInstrumented(EXPLODE, 1, tmp);
      expect(() => mod.explode()).toThrow("boom");
      const { records } = dump();
      expect(records[0].type).toBe("call");
      expect(records.at(-1)).toMatchObject({ type: "throw", name: "Error", message: { value: '"boom"' } });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("a #k that never happens", () => {
  it("writes a target_summary record naming the requested #k and how many calls actually ran", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "flt-summary-"));
    try {
      const { mod, dump } = await loadInstrumented(EXPLODE, 5, tmp);
      try {
        mod.explode();
      } catch {
        // The call still runs and still throws; only tracing is off.
      }
      const { records, observedCalls } = dump();
      expect(records).toEqual([
        expect.objectContaining({ type: "target_summary", observed_calls: 1 }),
      ]);
      expect(records[0].fid).toMatch(/#5$/);
      expect(observedCalls).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
