import { defineConfig } from "vitest/config";
import { depugPlugin } from "../../src/plugin.ts";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [depugPlugin({ include: (id) => id.endsWith("/fixtures/bench-heavy/src/app.ts") })],
});
