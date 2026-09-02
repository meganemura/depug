// The other shape of project-split repository: the projects are written
// inline here rather than resolving to a config of their own, so there is
// no per-package file for a wrapper to extend.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "app",
          root: "./packages/app",
          include: ["app.test.ts"],
        },
      },
    ],
  },
});
