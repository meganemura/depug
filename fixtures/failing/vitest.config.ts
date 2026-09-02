import { defineConfig } from "vitest/config";
import DepugReporter from "../../src/reporter.ts";

export default defineConfig({
  test: {
    include: ["app.test.ts"],
    // The default reporter stays: depug adds its lines beside whatever a
    // project already prints, rather than replacing it.
    reporters: ["default", new DepugReporter()],
  },
});
