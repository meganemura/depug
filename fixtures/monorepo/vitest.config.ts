// A repository split into vitest projects. vitest does not apply this
// config's plugins to a project's own config, so a wrapper that merged
// into this file alone would reach none of the code under test.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*"],
  },
});
