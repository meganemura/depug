// The four setup files a plugin adds to `setupFiles`.
//
// Each one exists to run before the test file, and therefore before the
// app modules it imports, so that the global the rewritten code calls is
// already there. That ordering is the whole reason they are separate
// modules, and it is what these check: importing one installs its global.
//
// They register vitest hooks at module scope, which is why importing them
// here is safe: without the environment variable a verb sets, the flush at
// the end of a run writes nothing.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFltRuntime } from "../src/flt-runtime.ts";
import { flushFltWorker, readFltWorkerFiles } from "../src/flt-collector.ts";

describe("the setup files install the global their rewrite calls", () => {
  it("the call index installs __depug", async () => {
    await import("../src/setup.ts");
    expect(typeof (globalThis as { __depug?: unknown }).__depug).toBe("object");
  });

  it("the probe installs __depugProbe", async () => {
    await import("../src/probe-setup.ts");
    expect(typeof (globalThis as { __depugProbe?: unknown }).__depugProbe).toBe("object");
  });

  it("the trace installs __depug_flt", async () => {
    await import("../src/flt-setup.ts");
    expect(typeof (globalThis as { __depug_flt?: unknown }).__depug_flt).toBe("object");
  });

  it("the injection installs both its runtime and its renderer", async () => {
    await import("../src/exec-setup.ts");
    expect(typeof (globalThis as { __depugExec?: unknown }).__depugExec).toBe("object");
    // The rewritten code calls the renderer by name too, so it has to be
    // a global as well and not only an import.
    expect(typeof (globalThis as { __depugExecRender?: unknown }).__depugExecRender).toBe("function");
  });
});

describe("a trace's worker file", () => {
  it("round-trips its records through the file the parent reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "depug-flt-worker-"));
    try {
      const runtime = createFltRuntime(1, { max_value_length: 200, max_elements: 10 });
      const call = runtime.enter("a.ts:f@1:1#", "a.ts", 1, 1, { n: 1 });
      call.line(2, 3, { n: 1 });
      call.ret(1, 3);
      call.exit("return", undefined);

      const path = flushFltWorker(dir, runtime);
      expect(readFileSync(path, "utf8")).toContain('"type":"call"');

      const files = readFltWorkerFiles(dir);
      const kinds = files.flatMap((f) => f.records).map((r) => r.type);
      expect(kinds).toEqual(["call", "line", "return"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads an absent directory as no records", () => {
    expect(readFltWorkerFiles(join(tmpdir(), "depug-no-such-dir-000"))).toEqual([]);
  });
});

afterAll(() => {
  // The setup files registered hooks on this file's own suite. Nothing
  // here asked them to write, so there is nothing to clean up beyond the
  // globals, which the next test file installs for itself anyway.
});
