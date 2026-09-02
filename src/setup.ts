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
import { afterEach, beforeEach } from "vitest";
import { installGlobalRuntime } from "./runtime.ts";

const runtime = installGlobalRuntime();

beforeEach((context) => {
  runtime.setCurrentTest(context.task.name);
});

afterEach(() => {
  runtime.setCurrentTest(null);
});
