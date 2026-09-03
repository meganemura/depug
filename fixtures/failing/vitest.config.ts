import { defineConfig } from "vitest/config";
import DepugReporter from "../../src/reporter.ts";

// Imported by path, not by package name. Naming the package would make
// this fixture depend on the build being present, and a fresh clone has
// none: the suite must run on a checkout that has only been installed.
// The published entry points are checked where they can be checked
// properly, by installing a packed tarball into another project.
export default defineConfig({
  test: {
    include: ["app.test.ts"],
    // The default reporter stays: depug adds its lines beside whatever a
    // project already prints, rather than replacing it.
    reporters: ["default", new DepugReporter()],
  },
});
