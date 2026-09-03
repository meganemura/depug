// Checks that a text-splice transform can report a function's own
// TypeScript position, keep the file's line count unchanged, and pair
// entry with exit 1:1 across return, throw, and a function that already
// has its own try/finally. The instrumented code runs through a
// `@vite-ignore` dynamic import, so Node's own type-stripping loader reads
// it directly; vite and esbuild never see this file. That is enough to
// run the instrumented code for real and check entry/exit pairing, but it
// does not show the embedded line/column literals survive vite/esbuild's
// own transform -- wrapper-config.test.ts checks that, by running a real
// vitest process end to end.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { instrumentSource } from "../src/transform.ts";
import { createRuntime, type DepugRuntime } from "../src/runtime.ts";

const FIXTURE_PATH = join(process.cwd(), "fixtures/basic/src/app.ts");
const FIXTURE_ID = "fixtures/basic/src/app.ts";

// Read once and reused by every test in this file. Read directly with
// node:fs, independent of the transform under test, so the raw source is
// never touched by the code being verified.
const fixtureSource = readFileSync(FIXTURE_PATH, "utf8");

describe("instrumentSource: line count", () => {
  it("keeps the total line count identical after instrumenting every function", () => {
    const { code } = instrumentSource(fixtureSource, FIXTURE_ID);
    expect(code.split("\n").length).toBe(fixtureSource.split("\n").length);
  });

  it("inserts no newline characters (every insertion lengthens a line, never adds one)", () => {
    const { code } = instrumentSource(fixtureSource, FIXTURE_ID);
    // A line-by-line diff of the split would only prove the count matches;
    // this additionally proves no insertion carried a literal "\n".
    const originalLines = fixtureSource.split("\n");
    const newLines = code.split("\n");
    for (let i = 0; i < originalLines.length; i++) {
      expect(newLines[i].length).toBeGreaterThanOrEqual(originalLines[i].length);
    }
  });
});

describe("instrumented fixture code, executed through Node's own loader", () => {
  let tmpDir: string;
  let runtime: DepugRuntime;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "depug-transform-"));
    runtime = createRuntime();
    globalThis.__depug = runtime;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function loadInstrumentedFixture(): Promise<typeof import("../fixtures/basic/src/app.ts")> {
    const { code } = instrumentSource(fixtureSource, FIXTURE_ID);
    const outFile = join(tmpDir, "app.ts");
    writeFileSync(outFile, code);
    return import(/* @vite-ignore */ pathToFileURL(outFile).href);
  }

  it("sanity: the fixture source still carries a type annotation (not already-stripped JS)", () => {
    // If this ever fails, a plugin transforming this same file would be
    // instrumenting post-esbuild JS instead of the original TypeScript,
    // and every position assertion below would be checking the wrong
    // coordinate system without an obvious symptom.
    expect(fixtureSource).toContain(": number");
  });

  it("reports the enter/exit position of a function declared past line 10", async () => {
    const mod = await loadInstrumentedFixture();
    mod.withCleanup(3);
    const events = runtime.dump();
    expect(events).toEqual([
      expect.objectContaining({ kind: "enter", line: 14, column: 17 }),
      expect.objectContaining({ kind: "exit", line: 14, column: 17, exitKind: "return" }),
    ]);
  });

  it("reports each of the 3 fixture functions at its own declared line/column", async () => {
    const mod = await loadInstrumentedFixture();
    mod.addOne(1);
    mod.greet("world");
    mod.withCleanup(1);
    const enters = runtime.dump().filter((e) => e.kind === "enter");
    expect(enters).toEqual([
      expect.objectContaining({ line: 1, column: 17 }), // addOne
      expect.objectContaining({ line: 5, column: 17 }), // greet
      expect.objectContaining({ line: 14, column: 17 }), // withCleanup, past line 10
    ]);
  });

  it("pairs entry and exit 1:1 for a plain return", async () => {
    const mod = await loadInstrumentedFixture();
    mod.addOne(1);
    const events = runtime.dump();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "enter", fn: expect.stringMatching(/:addOne@\d+:\d+#1$/) });
    expect(events[1]).toMatchObject({ kind: "exit", fn: events[0].fn, exitKind: "return" });
  });

  it("pairs entry and exit 1:1 for a throw", async () => {
    const mod = await loadInstrumentedFixture();
    expect(() => mod.greet("")).toThrow("empty name");
    const events = runtime.dump();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "enter", fn: expect.stringMatching(/:greet@\d+:\d+#1$/) });
    expect(events[1]).toMatchObject({ kind: "exit", fn: events[0].fn, exitKind: "throw" });
  });

  it("pairs entry and exit 1:1 for a function with its own try/finally", async () => {
    const mod = await loadInstrumentedFixture();
    mod.withCleanup(5);
    const events = runtime.dump();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "enter", fn: expect.stringMatching(/:withCleanup@\d+:\d+#1$/) });
    expect(events[1]).toMatchObject({ kind: "exit", fn: events[0].fn, exitKind: "return" });
  });

  it("pairs entry and exit 1:1 for an empty-body arrow function", async () => {
    const mod = await loadInstrumentedFixture();
    mod.emptyArrow();
    const events = runtime.dump();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "enter", fn: expect.stringMatching(/:emptyArrow@\d+:\d+#1$/) });
    expect(events[1]).toMatchObject({ kind: "exit", fn: events[0].fn, exitKind: "return" });
  });

  it("pairs entry and exit 1:1 for an empty-body function declaration", async () => {
    const mod = await loadInstrumentedFixture();
    mod.emptyFunction();
    const events = runtime.dump();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "enter", fn: expect.stringMatching(/:emptyFunction@\d+:\d+#1$/) });
    expect(events[1]).toMatchObject({ kind: "exit", fn: events[0].fn, exitKind: "return" });
  });

  it("pairs entry and exit 1:1 for an empty-body method", async () => {
    const mod = await loadInstrumentedFixture();
    new mod.EmptyMethodHolder().emptyMethod();
    const events = runtime.dump();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "enter", fn: expect.stringMatching(/:emptyMethod@\d+:\d+#1$/) });
    expect(events[1]).toMatchObject({ kind: "exit", fn: events[0].fn, exitKind: "return" });
  });

  it("keeps entry/exit paired across a mixed sequence of return, throw, and repeated calls", async () => {
    const mod = await loadInstrumentedFixture();
    mod.addOne(1);
    expect(() => mod.greet("")).toThrow();
    mod.greet("world");
    mod.withCleanup(2);
    const events = runtime.dump();
    expect(events).toHaveLength(8);
    const byCall = new Map<string, { kind: string }[]>();
    for (const event of events) {
      const list = byCall.get(event.fn) ?? [];
      list.push(event);
      byCall.set(event.fn, list);
    }
    expect(byCall.size).toBe(4);
    for (const [, pair] of byCall) {
      expect(pair.map((e) => e.kind)).toEqual(["enter", "exit"]);
    }
  });
});

describe("functions that are not plain declarations", () => {
  let tmp: string;
  let rt: DepugRuntime;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "depug-shapes-"));
    rt = createRuntime();
    globalThis.__depug = rt;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function load(): Promise<typeof import("../fixtures/basic/src/app.ts")> {
    const { code } = instrumentSource(fixtureSource, FIXTURE_ID);
    const outFile = join(tmp, "app.ts");
    writeFileSync(outFile, code);
    return import(/* @vite-ignore */ pathToFileURL(outFile).href);
  }

  it("records an arrow written with an expression body, and returns its value", async () => {
    const mod = await load();
    expect(mod.double(21)).toBe(42);
    const events = rt.dump();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "enter", fn: expect.stringMatching(/:double@\d+:\d+#1$/) });
    expect(events[1]).toMatchObject({ kind: "exit", exitKind: "return" });
  });

  it("records a constructor and both accessors under their own names", async () => {
    const mod = await load();
    const counter = new mod.Counter(1);
    counter.value = 5;
    expect(counter.value).toBe(5);

    const names = rt
      .dump()
      .filter((e) => e.kind === "enter")
      .map((e) => e.fn.slice(e.fn.indexOf(":") + 1, e.fn.indexOf("@")));
    expect(names).toEqual(["constructor", "value", "value"]);
  });
});

/**
 * Generates small but structurally varied TypeScript, so the line-count
 * invariant is checked against shapes nobody wrote down.
 *
 * The corpus test covers one real codebase; this covers combinations that
 * codebase happens not to contain. Both matter: the empty-body collision
 * came from real code, and the shapes below are how a rewrite meets a
 * `switch` inside a `catch` inside a loop without waiting for someone to
 * commit one.
 */
function drawStatements(tc: { draw: <T>(g: gs.Generator<T>) => T }, depth: number, indent: string): string[] {
  const count = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
  const out: string[] = [];

  for (let i = 0; i < count; i++) {
    const kind = tc.draw(
      gs.sampledFrom(
        depth > 0
          ? (["const", "if", "loop", "try", "switch", "return", "throw", "empty", "nested"] as const)
          : (["const", "return", "throw", "empty"] as const),
      ),
    );
    const inner = depth > 0 ? drawStatements(tc, depth - 1, `${indent}  `) : [];

    if (kind === "const") out.push(`${indent}const v${i} = ${i} + 1;`);
    else if (kind === "return") out.push(`${indent}return ${i};`);
    else if (kind === "throw") out.push(`${indent}throw new Error("e${i}");`);
    else if (kind === "empty") out.push(`${indent}{}`);
    else if (kind === "if") {
      out.push(`${indent}if (${i} > 0) {`, ...inner, `${indent}}`);
    } else if (kind === "loop") {
      out.push(`${indent}for (const x${i} of [1, 2]) {`, ...inner, `${indent}}`);
    } else if (kind === "try") {
      out.push(`${indent}try {`, ...inner, `${indent}} catch (e${i}) {`, ...inner, `${indent}}`);
    } else if (kind === "switch") {
      out.push(`${indent}switch (${i}) {`, `${indent}  case 1: {`, ...inner, `${indent}    break;`, `${indent}  }`, `${indent}}`);
    } else {
      out.push(`${indent}function nested${i}(): void {`, ...inner, `${indent}}`);
    }
  }
  return out;
}

const sourceGenerator = gs.composite<string>((tc) => {
  const shape = tc.draw(
    gs.sampledFrom(["declaration", "arrow-block", "arrow-expression", "method", "async"] as const),
  );
  const body = drawStatements(tc, tc.draw(gs.integers({ minValue: 0, maxValue: 3 })), "  ");

  if (shape === "arrow-expression") return `export const f = (n: number) => n + 1;\n`;
  if (shape === "arrow-block") return `export const f = (n: number): void => {\n${body.join("\n")}\n};\n`;
  if (shape === "method") {
    return `export class C {\n  m(n: number): void {\n${body.map((l) => `  ${l}`).join("\n")}\n  }\n  #p(): void {}\n  get g(): number { return 1; }\n}\n`;
  }
  if (shape === "async") {
    return `export async function f(n: number): Promise<void> {\n  await Promise.resolve(n);\n${body.join("\n")}\n}\n`;
  }
  return `export function f(n: number): void {\n${body.join("\n")}\n}\n`;
});

describe("the invariant the whole design rests on", () => {
  it("keeps the line count for any shape of TypeScript", () =>
    hegel.test((tc) => {
      // Positions are embedded as literals rather than recovered from a
      // source map, so a rewrite that moved a line would put every
      // recorded coordinate one off with nothing to signal it.
      const source = tc.draw(sourceGenerator);
      const { code } = instrumentSource(source, "g.ts");
      expect(code.split("\n")).toHaveLength(source.split("\n").length);
    }));

  it("produces code that still parses, for any shape of TypeScript", () =>
    hegel.test((tc) => {
      const source = tc.draw(sourceGenerator);
      const before = ts.createSourceFile("g.ts", source, ts.ScriptTarget.Latest, true);
      // The generator only builds valid programs; if that ever stops being
      // true this check would blame the transform for the generator.
      expect(diagnosticCount(before)).toBe(0);

      const { code } = instrumentSource(source, "g.ts");
      const after = ts.createSourceFile("g.ts", code, ts.ScriptTarget.Latest, true);
      expect(diagnosticCount(after)).toBe(0);
    }));

  it("reports every function it rewrote at a line that exists", () =>
    hegel.test((tc) => {
      const source = tc.draw(sourceGenerator);
      const lineCount = source.split("\n").length;
      for (const fn of instrumentSource(source, "g.ts").functions) {
        expect(fn.line).toBeGreaterThanOrEqual(1);
        expect(fn.line).toBeLessThanOrEqual(lineCount);
        expect(fn.column).toBeGreaterThanOrEqual(1);
        // The id has to name that same position, or a verb aimed with it
        // reads a different function.
        expect(fn.idPrefix).toBe(`g.ts:${fn.name}@${fn.line}:${fn.column}#`);
      }
    }));
});

/** The parser's own diagnostics, which are not on the public type. */
function diagnosticCount(sourceFile: ts.SourceFile): number {
  return (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics?.length ?? 0;
}
