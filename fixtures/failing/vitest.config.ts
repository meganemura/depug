import { defineConfig } from "vitest/config";
import DepugReporter from "depug/reporter";

// Imported by package name, not by a relative path, so this fixture takes
// the same route a project installing depug would. A relative import would
// keep working even if the package exported nothing.
export default defineConfig({
  test: {
    include: ["app.test.ts"],
    // The default reporter stays: depug adds its lines beside whatever a
    // project already prints, rather than replacing it.
    reporters: ["default", new DepugReporter()],
  },
});
