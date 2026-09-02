// Exercises src/flt-runtime.ts directly, scripting the calls the
// transform would otherwise generate. test/flt-transform.test.ts proves
// the transform produces calls shaped like these for a real fixture; this
// file isolates the runtime's own bookkeeping (folding, recursion,
// secrets, truncation) from whatever the transform happens to generate,
// so a runtime bug and a transform bug cannot mask each other.
import { describe, expect, it } from "vitest";
import { createFltRuntime, type FltLineRecord, type FltRecord } from "../src/flt-runtime.ts";
import { isSecretName } from "../src/flt-render.ts";

const LIMITS = { max_value_length: 20, max_elements: 3 };

function reconstruct(records: readonly FltRecord[]): Record<string, unknown>[] {
  const snapshots: Record<string, unknown>[] = [];
  let state: Record<string, unknown> = {};
  for (const record of records) {
    if (record.type === "call") state = { ...record.locals };
    else if (record.type === "line") {
      const line = record as FltLineRecord;
      for (const name of line.out_of_scope) delete state[name];
      for (const [name, value] of Object.entries(line.new)) state[name] = value;
      for (const [name, change] of Object.entries(line.changed)) state[name] = change.new;
    }
    snapshots.push({ ...state });
  }
  return snapshots;
}

describe("loop folding, scripted directly against the runtime", () => {
  it("keeps the first and last of 6 iterations and folds the other 4 into one record", () => {
    const runtime = createFltRuntime(1, LIMITS);
    const handle = runtime.enter("f.ts:loop@1:1#", "f.ts", 1, 1, { n: 0 });

    handle.loopEnter();
    for (let i = 0; i < 6; i++) {
      handle.loopIterStart();
      handle.line(2, 1, { i, total: i * i });
    }
    handle.loopExit();
    handle.ret(30);

    const { records } = runtime.dump();
    const skipped = records.filter((r) => r.type === "skipped_iterations");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ count: 4 });

    const lineRecords = records.filter((r) => r.type === "line") as FltLineRecord[];
    expect(lineRecords).toHaveLength(2); // iteration 1 (kept live) and iteration 6 (kept as the last)
    expect(lineRecords[0].new.i).toMatchObject({ value: "0" });
    expect(lineRecords[1].changed.i).toMatchObject({ old: { value: "0" }, new: { value: "5" } });
    expect(lineRecords[1].changed.total).toMatchObject({ old: { value: "0" }, new: { value: "25" } });

    // Reconstruction lands on the true final state even though 4 of the 6
    // iterations were never individually recorded.
    const snapshots = reconstruct(records);
    expect(snapshots.at(-2)).toMatchObject({ i: { value: "5" }, total: { value: "25" } });
  });

  it("keeps every iteration when the loop runs fewer than 3 times (nothing to fold)", () => {
    const runtime = createFltRuntime(1, LIMITS);
    const handle = runtime.enter("f.ts:loop@1:1#", "f.ts", 1, 1, {});
    handle.loopEnter();
    for (let i = 0; i < 2; i++) {
      handle.loopIterStart();
      handle.line(2, 1, { i });
    }
    handle.loopExit();
    handle.ret(undefined);

    const { records } = runtime.dump();
    expect(records.filter((r) => r.type === "skipped_iterations")).toHaveLength(0);
    expect(records.filter((r) => r.type === "line")).toHaveLength(2);
  });

  it("flushes a still-pending iteration as the last one when the function returns from inside the loop", () => {
    const runtime = createFltRuntime(1, LIMITS);
    const handle = runtime.enter("f.ts:loop@1:1#", "f.ts", 1, 1, {});
    handle.loopEnter();
    for (let i = 0; i < 4; i++) {
      handle.loopIterStart();
      if (i === 3) {
        handle.ret(i); // returns mid-iteration, before this loop's own loopExit ever runs
        break;
      }
      handle.line(2, 1, { i });
    }

    const { records } = runtime.dump();
    // Iteration 1 was live, 2 folded, and the return happening inside
    // iteration 4 (before it logs anything) still resolves the fold: one
    // skipped_iterations record, then the return -- iteration 4 itself
    // produced no `line` record because it returned before its own
    // `.line()` call.
    expect(records.map((r) => r.type)).toEqual(["call", "line", "skipped_iterations", "return"]);
    expect(records[2]).toMatchObject({ count: 2 });
  });
});

describe("recursion: two calls to the same function are independent", () => {
  it("traces only the call whose index matches, even when a traced call recurses into an untraced one", () => {
    const runtime = createFltRuntime(1, LIMITS);
    const outer = runtime.enter("f.ts:fact@1:1#", "f.ts", 1, 1, { n: 3 });
    expect(outer.tracing).toBe(true);
    outer.line(2, 1, { n: 3, step: "before recursion" });

    const inner = runtime.enter("f.ts:fact@1:1#", "f.ts", 1, 1, { n: 2 });
    expect(inner.tracing).toBe(false);
    inner.line(2, 1, { n: 2 }); // must be a no-op: not tracing
    inner.ret(2);

    outer.line(3, 1, { n: 3, step: "after recursion" });
    outer.ret(6);

    const { records } = runtime.dump();
    expect(records.every((r) => r.fid.endsWith("#1"))).toBe(true);
    const steps = records.filter((r): r is FltLineRecord => r.type === "line").map((r) => r.new.step ?? r.changed.step?.new);
    expect(steps).toEqual([{ value: '"before recursion"' }, { value: '"after recursion"' }]);
  });
});

describe("secrets", () => {
  it("matches the same default names the schema documents", () => {
    for (const name of ["password", "apiKey", "auth_token", "sessionId", "cookie"]) {
      expect(isSecretName(name)).toBe(true);
    }
    expect(isSecretName("username")).toBe(false);
  });

  it("withholds a captured local whose name looks like a secret, never rendering its value", () => {
    const runtime = createFltRuntime(1, LIMITS);
    const handle = runtime.enter("f.ts:login@1:1#", "f.ts", 1, 1, { password: "hunter2" });
    handle.ret(undefined);
    const { records } = runtime.dump();
    const call = records[0] as Extract<FltRecord, { type: "call" }>;
    expect(call.locals.password).toEqual({ redacted: true, reason: "name" });
  });
});

describe("rendering limits", () => {
  it("truncates a value past max_value_length and reports the original length", () => {
    const runtime = createFltRuntime(1, LIMITS);
    const handle = runtime.enter("f.ts:f@1:1#", "f.ts", 1, 1, { text: "x".repeat(50) });
    handle.ret(undefined);
    const { records } = runtime.dump();
    const call = records[0] as Extract<FltRecord, { type: "call" }>;
    expect(call.locals.text).toMatchObject({ truncated: true, original_length: 52 }); // 50 chars + 2 quotes
  });
});
