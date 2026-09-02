import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // fixtures/** are separate vitest projects, each with its own config.
    // depug's own test suite spawns them as subprocesses; it must not also
    // collect their test files directly, which would run them
    // uninstrumented and race the subprocess runs over shared files.
    include: ["test/**/*.test.ts"],
    exclude: ["fixtures/**", "node_modules/**"],
  },
});
