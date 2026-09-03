// Turning a line into a function id.
//
// This is the conversion that kept costing whole re-runs: a failure names
// a line, a diff changes one, and every verb wants a function id. Doing it
// by eye means matching braces, and getting it wrong costs a process.
import { describe, expect, it } from "vitest";
import { functionRanges, functionsContaining } from "../src/function-range.ts";
import { run } from "../src/cli.ts";
import { fileURLToPath } from "node:url";

const NESTED = [
  "export const makeAdder = (base: number) =>",  // 1
  "  function add(n: number): number {",         // 2
  "    const sum = base + n;",                   // 3
  "    return sum;",                             // 4
  "  };",                                        // 5
  "",                                            // 6
  "export function alone(): number {",           // 7
  "  return 1;",                                 // 8
  "}",                                           // 9
].join("\n");

describe("which function holds a line", () => {
  it("puts the innermost function first", () => {
    // Line 3 sits inside `add`, which sits inside `makeAdder`. The inner
    // one is the answer: its locals are what the line touched.
    const holders = functionsContaining(NESTED, "a.ts", 3);
    expect(holders.map((h) => h.id)).toEqual(["a.ts:add@2:12", "a.ts:makeAdder@1:14"]);
  });

  it("spans a function's whole declaration, not just its name", () => {
    const ranges = functionRanges(NESTED, "a.ts");
    const adder = ranges.find((r) => r.name === "makeAdder")!;
    expect(adder.startLine).toBe(1);
    expect(adder.endLine).toBe(5);
  });

  it("returns nothing for a line outside every function", () => {
    expect(functionsContaining(NESTED, "a.ts", 6)).toEqual([]);
  });
});

describe("--at through the command line", () => {
  const FIXTURE = fileURLToPath(new URL("../fixtures/flt", import.meta.url));
  const VITEST_BIN = fileURLToPath(new URL("../node_modules/.bin/vitest", import.meta.url));

  function framesAt(at: string) {
    return run([
      "frames", "--cwd", FIXTURE, "--include", `${FIXTURE}/src`, "--at", at,
      "--", VITEST_BIN, "run", "app.test.ts", "-t", "builds an adder",
    ]);
  }

  it("names the recorded call whose function holds the line", () => {
    const out = framesAt("src/app.ts:59").stdout;
    const listed = out.split("\n").filter((l) => l.startsWith("  src/app.ts:"));
    // Innermost first, and both are calls the index actually recorded.
    expect(listed[0].trim()).toMatch(/^src\/app\.ts:add@\d+:\d+#1$/);
    expect(listed[1].trim()).toMatch(/^src\/app\.ts:makeAdder@\d+:\d+#1$/);
  }, 120_000);

  it("says so when no function holds the line, rather than listing nothing", () => {
    expect(framesAt("src/app.ts:1").stdout).toContain("no function in src/app.ts holds line 1");
  }, 120_000);

  it("names a malformed --at instead of guessing", () => {
    expect(framesAt("src/app.ts").stdout).toContain("--at wants <file>:<line>");
  }, 120_000);
});
