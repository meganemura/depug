// Instruments only this fixture's own app code, the same way
// fixtures/concurrent does, so the events dumped in app.test.ts's
// afterAll come from a real, plugin-driven transform run, not a
// hand-instrumented stand-in.
import { defineConfig } from "vitest/config";
import { depugPlugin } from "../../src/plugin.ts";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [depugPlugin({ include: (id) => id.endsWith("/fixtures/interleave/src/app.ts") })],
});
