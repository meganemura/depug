import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["app.test.ts"],
    // A relative path, to catch a wrapper that hoists this project to the
    // repository root and leaves it resolving from the wrong directory.
    setupFiles: ["./support/marker.ts"],
  },
});
