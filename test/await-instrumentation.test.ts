// Checks the suspend/resume instrumentation the transform adds around
// `await`, including two splice-offset collisions the corpus regression
// test cannot see: an `await` touching a function's opening brace with no
// space (`{await x}`) and a doubly-nested `await` with nothing after its
// operand (`await await x`). Both collisions produce syntactically valid
// output either way, so a diagnostic-count check passes regardless of
// whether the two insertions at the shared offset landed in the right
// order; only running the instrumented code (as this file does, through
// the same @vite-ignore dynamic import transform.test.ts uses) can catch
// the wrong order, which surfaces as a TDZ ReferenceError or a swapped
// suspend/resume sequence, not a parse error.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { instrumentSource } from "../src/transform.ts";
import { createRuntime, type DepugRuntime } from "../src/runtime.ts";

let tmpDir: string;
let runtime: DepugRuntime;
let fileCounter = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "depug-await-"));
  runtime = createRuntime();
  globalThis.__depug = runtime;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function loadInstrumented(source: string): Promise<Record<string, (...args: never[]) => unknown>> {
  fileCounter += 1;
  const { code } = instrumentSource(source, `await-fixture-${fileCounter}.ts`);
  const outFile = join(tmpDir, `mod-${fileCounter}.ts`);
  writeFileSync(outFile, code);
  return import(/* @vite-ignore */ pathToFileURL(outFile).href) as Promise<
    Record<string, (...args: never[]) => unknown>
  >;
}

describe("await instrumentation: ordinary case", () => {
  it("records suspend before and resume after a single await, tied to the enclosing call", async () => {
    const source = `
export async function tag(label: string): Promise<string> {
  const result = await Promise.resolve(label);
  return result;
}
`;
    const mod = await loadInstrumented(source);
    const result = await (mod.tag as (label: string) => Promise<string>)("x");
    expect(result).toBe("x");

    const events = runtime.dump();
    expect(events.map((e) => e.kind)).toEqual(["enter", "suspend", "resume", "exit"]);
    // Every event names the same call id: an await does not allocate a
    // new one, it only reports through the id its enclosing call's entry
    // already assigned.
    const fns = new Set(events.map((e) => e.fn));
    expect(fns.size).toBe(1);
  });

  it("does not change line count when instrumenting an await", () => {
    const source = `export async function tag(label: string): Promise<string> {\n  return await Promise.resolve(label);\n}\n`;
    const { code } = instrumentSource(source, "line-count-fixture.ts");
    expect(code.split("\n").length).toBe(source.split("\n").length);
  });
});

describe("await instrumentation: offset collisions", () => {
  it("runs correctly when an await sits directly against the function's opening brace (no whitespace)", async () => {
    const source = `export async function tag(){return await Promise.resolve("ok")}`;
    const { code } = instrumentSource(source, "collision-open-brace.ts");
    // No inserted string carries a newline, so this single-line source
    // must still be a single line after instrumenting.
    expect(code.split("\n").length).toBe(1);

    const mod = await loadInstrumented(source);
    const result = await (mod.tag as () => Promise<string>)();
    expect(result).toBe("ok");

    const events = runtime.dump();
    expect(events.map((e) => e.kind)).toEqual(["enter", "suspend", "resume", "exit"]);
    expect(new Set(events.map((e) => e.fn)).size).toBe(1);
  });

  it("runs correctly for a doubly-nested await with nothing after it", async () => {
    const source = `export async function tag(){return await await Promise.resolve("ok")}`;
    const mod = await loadInstrumented(source);
    const result = await (mod.tag as () => Promise<string>)();
    expect(result).toBe("ok");

    const events = runtime.dump();
    // Both awaits report through the same call id (there is only one
    // enclosing instrumented function), and nest properly: the inner
    // await's suspend/resume pair is fully inside the outer one's, not
    // interleaved with it.
    expect(events.map((e) => e.kind)).toEqual(["enter", "suspend", "suspend", "resume", "resume", "exit"]);
    expect(new Set(events.map((e) => e.fn)).size).toBe(1);
  });
});

describe("await instrumentation: nested functions and no enclosing call", () => {
  it("ties an await to its own function's call id, not an outer function's, when nested", async () => {
    const source = `
export async function outer(): Promise<string> {
  async function inner(): Promise<string> {
    return await Promise.resolve("inner");
  }
  return await inner();
}
`;
    const mod = await loadInstrumented(source);
    const result = await (mod.outer as () => Promise<string>)();
    expect(result).toBe("inner");

    const events = runtime.dump();
    const byFn = new Map<string, string[]>();
    for (const event of events) {
      const list = byFn.get(event.fn) ?? [];
      list.push(event.kind);
      byFn.set(event.fn, list);
    }
    // Two distinct calls (outer#1, inner#1), each with its own full
    // enter/suspend/resume/exit sequence -- inner's await never reports
    // through outer's call id, and outer's await never reports through
    // inner's.
    expect(byFn.size).toBe(2);
    for (const [, kinds] of byFn) {
      expect(kinds).toEqual(["enter", "suspend", "resume", "exit"]);
    }
  });

  it("leaves a top-level await with no enclosing instrumented function untouched", () => {
    // Top-level await needs no CallFrame to report through, so this
    // source has nothing to splice around the await at all -- the only
    // observable effect is that the line count still matches (the
    // transform did not error out on it).
    const source = `export const value = await Promise.resolve(1);\n`;
    const { code } = instrumentSource(source, "top-level-await.ts");
    expect(code).toBe(source);
  });
});
