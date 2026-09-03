// A function id has to name one function and no other, because the call
// counter that completes it (`#k`) is kept per id. Two functions sharing
// an id share a counter, and `#2` then means "the second call to either
// of them" -- an address that lands somewhere else on the next run.
//
// JavaScript makes this the common case rather than a corner: measured on
// one real codebase (honojs/hono at one pinned commit), 175 of 725
// instrumented functions were anonymous, and 250 of them would have
// shared an id under a name-only scheme.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { instrumentSource } from "../src/transform.ts";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
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

it("names a private method by its own name, not <computed>", async () => {
  // A private method's name is a PrivateIdentifier rather than an
  // Identifier. Reading that as "computed" throws the name away and puts
  // every private method in a file under one label, which is exactly the
  // collision the position in an id exists to prevent.
  const source = [
    "export class Store {",
    "  #load() { return 1; }",
    "  #save() { return 2; }",
    "  run() { return this.#load() + this.#save(); }",
    "}",
  ].join("\n");

  const mod = await load(source, "store.ts");
  const Store = mod.Store as new () => { run(): number };
  expect(new Store().run()).toBe(3);

  const names = runtime
    .dump()
    .filter((e) => e.kind === "enter")
    .map((e) => e.fn.slice(e.fn.indexOf(":") + 1, e.fn.indexOf("@")));
  expect(names.sort()).toEqual(["#load", "#save", "run"]);
});

describe("the call counter, over any sequence of calls", () => {
  it("numbers each function's calls from 1, without gaps or sharing", () =>
    hegel.test((tc) => {
      // `#k` is the whole addressing scheme. A gap or a shared counter
      // makes an id point somewhere else on the next run.
      const names = ["a", "b", "c"];
      const sequence = tc.draw(gs.arrays(gs.sampledFrom(names), { maxSize: 60 }));
      const runtime = createRuntime();

      for (const name of sequence) {
        const prefix = `f.ts:${name}@1:1#`;
        const call = runtime.enter(prefix, 1, 1);
        runtime.exit(prefix, 1, 1, "return", call);
      }

      const perName = new Map<string, string[]>();
      for (const event of runtime.dump()) {
        if (event.kind !== "enter") continue;
        const prefix = event.fn.slice(0, event.fn.lastIndexOf("#"));
        const list = perName.get(prefix) ?? [];
        list.push(event.fn.slice(event.fn.lastIndexOf("#") + 1));
        perName.set(prefix, list);
      }

      for (const [prefix, counters] of perName) {
        const expected = sequence.filter((n) => prefix.includes(`:${n}@`)).length;
        expect(counters).toEqual(Array.from({ length: expected }, (_, i) => String(i + 1)));
      }
    }));

  it("names the call each new call began inside", () =>
    hegel.test((tc) => {
      // JavaScript runs one call chain at a time, so a call entered while
      // another is running began inside it.
      const depth = tc.draw(gs.integers({ minValue: 1, maxValue: 8 }));
      const runtime = createRuntime();
      const opened: string[] = [];

      for (let i = 0; i < depth; i++) {
        const prefix = `f.ts:fn${i}@1:1#`;
        const call = runtime.enter(prefix, 1, 1);
        opened.push(`${prefix}${call}`);
      }

      const enters = runtime.dump().filter((e) => e.kind === "enter");
      expect(enters[0].parent).toBeNull();
      for (let i = 1; i < depth; i++) {
        expect(enters[i].parent).toBe(opened[i - 1]);
      }
    }));

  it("does not let a suspended call claim what ran while it waited", () =>
    hegel.test((tc) => {
      // An `await` moves the boundary: a suspended call is not executing,
      // so a call entered meanwhile did not begin inside it.
      const runtime = createRuntime();
      const outer = "f.ts:outer@1:1#";
      const other = "f.ts:other@2:1#";

      const call = runtime.enter(outer, 1, 1);
      runtime.suspend(outer, 1, 1, call);
      const otherCall = runtime.enter(other, 2, 1);
      runtime.exit(other, 2, 1, "return", otherCall);
      runtime.resume(outer, 1, 1, call, tc.draw(gs.integers()));
      runtime.exit(outer, 1, 1, "return", call);

      const enters = runtime.dump().filter((e) => e.kind === "enter");
      expect(enters[1].fn.startsWith(other)).toBe(true);
      expect(enters[1].parent).toBeNull();
    }));
});
