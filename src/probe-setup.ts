// Installs the probe collector before any test file runs, and writes what
// it saw when the run ends.
//
// The rewritten application code calls `__depugProbe` by name, so the
// global has to exist before the module holding that code is imported.
// vitest's setupFiles run first, which is the whole reason this file
// exists as a separate entry point rather than as part of the plugin.
import { afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installGlobalProbeRuntime } from "./probe-runtime.ts";

const runtime = installGlobalProbeRuntime();

afterAll(() => {
  const dir = process.env.DEPUG_PROBE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `probe-${process.pid}.json`), JSON.stringify(runtime.dump()));
});
