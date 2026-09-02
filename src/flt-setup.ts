// Loaded through vitest's setupFiles by the flt plugin, before the test
// file (and the target module it imports) runs. See src/setup.ts for the
// general shape this follows and the concurrency limit it inherits
// (test.concurrent misattributes; see fixtures/concurrent).
//
// This installs a separate global, `__depug_flt`, rather than reusing
// `__depug`: a `flt` re-execution does not load the always-on plugin at
// all (see src/flt-plugin.ts), so there is no `__depug` to share, and
// keeping the two globals apart means a project that somehow loads both
// plugins in one run cannot have one runtime's calls land on the other's.
import { afterAll, afterEach, beforeEach } from "vitest";
import { flushFltWorker } from "./flt-collector.ts";
import { installGlobalFltRuntime } from "./flt-runtime.ts";
import { DEFAULT_LIMITS } from "./evidence.ts";

const targetK = Number(process.env.DEPUG_FLT_TARGET_K ?? "0");
const runtime = installGlobalFltRuntime(targetK, DEFAULT_LIMITS);

beforeEach((context) => {
  runtime.setCurrentTest(context.task.name);
});

afterEach(() => {
  runtime.setCurrentTest(null);
});

afterAll(() => {
  const dir = process.env.DEPUG_FLT_DIR;
  if (dir) flushFltWorker(dir, runtime);
});
