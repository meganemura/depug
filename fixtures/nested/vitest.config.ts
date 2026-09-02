import { defineConfig } from "vitest/config";
import DepugReporter from "../../src/reporter.ts";

export default defineConfig({
  test: {
    include: ["app.test.ts"],
    reporters: ["default", new DepugReporter()],
  },
});
