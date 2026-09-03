// The plugins and the hook, called directly.
//
// Each one is an ordinary object whose `transform` is a function, so it
// can be exercised without a runner. The end-to-end tests prove a verb can
// load one into someone else's test run; these prove the object itself
// decides correctly which files to touch, which is the part that goes
// wrong quietly.
import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { depugPlugin } from "../src/plugin.ts";
import { depugProbePlugin } from "../src/probe-plugin.ts";
import { depugFltPlugin } from "../src/flt-plugin.ts";
import { depugExecPlugin } from "../src/exec-plugin.ts";

const ROOT = "/repo";
const SOURCE = ["export function f(n: number): number {", "  return n + 1;", "}", ""].join("\n");

/** Calls a plugin's transform hook the way vite would. */
function transform(plugin: unknown, code: string, id: string): string | null {
  const hook = (plugin as { transform: (c: string, i: string) => { code: string } | null }).transform;
  return hook.call(plugin, code, id)?.code ?? null;
}

describe("the always-on plugin", () => {
  it("adds its setup file so the runtime exists before the app module loads", () => {
    const config = (depugPlugin() as unknown as { config: () => { test: { setupFiles: string[] } } }).config();
    expect(config.test.setupFiles[0]).toMatch(/setup\.ts$/);
  });

  it("runs before types are stripped, or the positions would be wrong", () => {
    expect((depugPlugin() as unknown as { enforce: string }).enforce).toBe("pre");
  });

  it("touches a file the include predicate accepts, and no other", () =>
    hegel.test((tc) => {
      const wanted = tc.draw(gs.text({ alphabet: "abc", minSize: 1, maxSize: 6 }));
      const other = tc.draw(gs.text({ alphabet: "xyz", minSize: 1, maxSize: 6 }));
      const plugin = depugPlugin({ root: ROOT, include: (id) => id.endsWith(`${wanted}.ts`) });

      expect(transform(plugin, SOURCE, `${ROOT}/src/${wanted}.ts`)).toContain("__depug.enter");
      expect(transform(plugin, SOURCE, `${ROOT}/src/${other}x.ts`)).toBeNull();
    }));

  it("writes the id relative to the root it was given", () => {
    const code = transform(depugPlugin({ root: ROOT }), SOURCE, `${ROOT}/src/a.ts`)!;
    // A vite module id is absolute; an id that kept it would name a
    // different function on every machine.
    expect(code).toContain('"src/a.ts:f@1:17#"');
    expect(code).not.toContain(ROOT);
  });

  it("leaves a test file and a dependency alone by default", () => {
    const plugin = depugPlugin({ root: ROOT });
    expect(transform(plugin, SOURCE, `${ROOT}/src/a.test.ts`)).toBeNull();
    expect(transform(plugin, SOURCE, `${ROOT}/node_modules/x/a.ts`)).toBeNull();
    expect(transform(plugin, SOURCE, `${ROOT}/src/a.css`)).toBeNull();
  });
});

describe("the targeted plugins", () => {
  it("probe touches only the file holding a target", () => {
    const plugin = depugProbePlugin({ root: ROOT, targets: ["src/a.ts:f@1:17"] });
    expect(transform(plugin, SOURCE, `${ROOT}/src/a.ts`)).toContain("__depugProbe.enter");
    expect(transform(plugin, SOURCE, `${ROOT}/src/b.ts`)).toBeNull();
  });

  it("probe leaves the file alone when the id matches no function in it", () => {
    const plugin = depugProbePlugin({ root: ROOT, targets: ["src/a.ts:nope@99:1"] });
    expect(transform(plugin, SOURCE, `${ROOT}/src/a.ts`)).toBeNull();
  });

  it("flt touches only its target's file", () => {
    const plugin = depugFltPlugin({
      root: ROOT, targetPath: "src/a.ts", targetName: "f", targetLine: 1, targetColumn: 17,
    });
    expect(transform(plugin, SOURCE, `${ROOT}/src/a.ts`)).toContain("__depug_flt");
    expect(transform(plugin, SOURCE, `${ROOT}/src/b.ts`)).toBeNull();
  });

  it("exec touches only its target's line", () => {
    const plugin = depugExecPlugin({
      root: ROOT, targetPath: "src/a.ts", targetName: "f", targetLine: 1, targetColumn: 17,
      atLine: 2, expression: "n = 9",
    });
    expect(transform(plugin, SOURCE, `${ROOT}/src/a.ts`)).toContain("__depugExec.shouldRun");
    // A line holding no statement of that function is not injectable, and
    // the plugin declines rather than putting the expression somewhere else.
    const wrongLine = depugExecPlugin({
      root: ROOT, targetPath: "src/a.ts", targetName: "f", targetLine: 1, targetColumn: 17,
      atLine: 1, expression: "n = 9",
    });
    expect(transform(wrongLine, SOURCE, `${ROOT}/src/a.ts`)).toBeNull();
  });

  it("every targeted plugin keeps the line count it was handed", () =>
    hegel.test((tc) => {
      const extra = tc.draw(gs.integers({ minValue: 0, maxValue: 6 }));
      const body = Array.from({ length: extra }, (_, i) => `  const v${i} = ${i};`);
      const source = ["export function f(n: number): number {", ...body, "  return n + 1;", "}", ""].join("\n");
      const targetLine = 2 + extra;

      for (const plugin of [
        depugProbePlugin({ root: ROOT, targets: ["src/a.ts:f@1:17"] }),
        depugFltPlugin({ root: ROOT, targetPath: "src/a.ts", targetName: "f", targetLine: 1, targetColumn: 17 }),
        depugExecPlugin({
          root: ROOT, targetPath: "src/a.ts", targetName: "f", targetLine: 1, targetColumn: 17,
          atLine: targetLine, expression: "n = 9",
        }),
      ]) {
        const code = transform(plugin, source, `${ROOT}/src/a.ts`);
        expect(code).not.toBeNull();
        expect(code!.split("\n")).toHaveLength(source.split("\n").length);
      }
    }));
});
