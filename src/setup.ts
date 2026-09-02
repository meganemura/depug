// Loaded through vitest's setupFiles, before the test file (and therefore
// the app modules it imports) runs. That ordering is what lets this file
// install the global `__depug` collector without the target application
// ever importing depug itself.
//
// Test window attribution hooks beforeEach/afterEach instead of wrapping
// each `it(name, fn)` body: it only needs vitest's public hook API, no
// second pass over the test file's AST. This breaks under
// `test.concurrent`, where two tests interleave in one worker and share
// this one mutable current-test pointer (see fixtures/concurrent).
import { afterAll, afterEach, beforeEach } from "vitest";
import { flushWorker } from "./collector.ts";
import { installGlobalRuntime } from "./runtime.ts";

const runtime = installGlobalRuntime();

beforeEach((context) => {
  runtime.setCurrentTest(context.task.name);
});

afterEach(() => {
  runtime.setCurrentTest(null);
});

// A verb runs in the parent process and asks for the events by naming a
// directory. Without that variable this file only installs the runtime,
// which is what the always-on layer wants: nothing is written unless a
// verb asked for it.
afterAll(() => {
  const dir = process.env.DEPUG_FRAMES_DIR;
  if (dir) flushWorker(dir, runtime);
});
