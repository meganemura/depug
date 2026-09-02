// Demonstrates the one documented way window detection breaks: two
// test.concurrent tests share one worker and one `currentTest` pointer, so
// a slower test's exit event can be misattributed once a faster sibling's
// afterEach has already reset the pointer.
import { defineConfig } from "vitest/config";
import { depugPlugin } from "../../src/plugin.ts";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [depugPlugin({ include: (id) => id.endsWith("/fixtures/concurrent/src/app.ts") })],
});
