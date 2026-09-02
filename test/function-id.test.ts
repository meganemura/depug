// A function id has to name one function and no other, because the call
// counter that completes it (`#k`) is kept per id. Two functions sharing
// an id share a counter, and `#2` then means "the second call to either
// of them" -- an address that lands somewhere else on the next run.
//
// JavaScript makes this the common case rather than a corner: measured on
// one real codebase (honojs/hono at one pinned commit), 175 of 725
// instrumented functions were anonymous, and 250 of them would have
// shared an id under a name-only scheme.
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { instrumentSource } from "../src/transform.ts";
import { createRuntime, type DepugRuntime } from "../src/runtime.ts";

let tmpDir: string;
let runtime: DepugRuntime;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "depug-fid-"));
  runtime = createRuntime();
  globalThis.__depug = runtime;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function load(source: string, fileId: string): Promise<Record<string, unknown>> {
  const { code } = instrumentSource(source, fileId);
  const outFile = join(tmpDir, `${fileId.replace(/\W/g, "_")}.ts`);
  writeFileSync(outFile, code);
  return import(/* @vite-ignore */ pathToFileURL(outFile).href);
}

it("gives two anonymous functions in one file separate ids and separate counters", async () => {
  // Both arrows are anonymous and live in the same file: name and path
  // together cannot tell them apart. Only the position can.
  const source = [
    "export const run = (fs: (() => number)[]) => fs.map((f) => f());",
    "export const first = () => { return 1; };",
    "export const second = () => { return 2; };",
    "export const pair: (() => number)[] = [",
    "  () => { return 10; },",
    "  () => { return 20; },",
    "];",
  ].join("\n");

  const mod = await load(source, "anon.ts");
  const results = (mod.run as (fs: (() => number)[]) => number[])(
    mod.pair as (() => number)[],
  );
  expect(results).toEqual([10, 20]);

  const enters = runtime.dump().filter((e) => e.kind === "enter");
  const anonymousIds = enters
    .map((e) => e.fn)
    .filter((fn) => fn.includes("<anonymous>"));

  // Three anonymous functions ran: the array's two arrows, once each, and
  // the `.map` callback, once per element. Four entries in total.
  expect(anonymousIds).toHaveLength(4);

  // The part that matters: each distinct function has its own id, and its
  // own counter. Strip the counter to get one id for each function.
  const prefixes = anonymousIds.map((fn) => fn.slice(0, fn.lastIndexOf("#")));
  expect(new Set(prefixes).size).toBe(3);

  // The callback ran twice under one id, counting 1 then 2. The other two
  // ran once each, so both read #1. Under a name-only id all three would
  // have shared one counter and produced #1 through #4.
  const counters = new Map<string, string[]>();
  for (const id of anonymousIds) {
    const at = id.lastIndexOf("#");
    const list = counters.get(id.slice(0, at)) ?? [];
    list.push(id.slice(at));
    counters.set(id.slice(0, at), list);
  }
  expect([...counters.values()].map((c) => c.join(",")).sort()).toEqual([
    "#1",
    "#1",
    "#1,#2",
  ]);
});

it("keeps the call counter per function, so a second call to one does not advance another", async () => {
  const source = [
    "export function twice(f: () => void) { f(); f(); }",
    "export const once = () => {};",
    "export const called = () => {};",
  ].join("\n");

  const mod = await load(source, "counter.ts");
  (mod.twice as (f: () => void) => void)(mod.called as () => void);
  (mod.once as () => void)();

  const enters = runtime.dump().filter((e) => e.kind === "enter").map((e) => e.fn);
  expect(enters.filter((fn) => fn.includes(":called@")).map((fn) => fn.slice(-2))).toEqual([
    "#1",
    "#2",
  ]);
  expect(enters.filter((fn) => fn.includes(":once@"))).toHaveLength(1);
  expect(enters.find((fn) => fn.includes(":once@"))?.endsWith("#1")).toBe(true);
});

it("writes the id as path:name@line:column#k", async () => {
  const source = ["export function alpha() {", "  return 1;", "}"].join("\n");
  const mod = await load(source, "grammar.ts");
  (mod.alpha as () => number)();

  const [enter] = runtime.dump();
  // alpha's name starts at line 1, column 17 (`export function ` is 16
  // characters). The id carries the TypeScript position, not a position
  // in whatever the file becomes after the types are stripped.
  expect(enter.fn).toBe("grammar.ts:alpha@1:17#1");
});
