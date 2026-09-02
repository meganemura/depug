// A plain vitest config, as if this were an unrelated project that has
// never heard of depug. It carries one distinguishing setting (the
// `define` marker) and its own setupFiles entry, so a test can tell
// whether the depug wrapper config preserved this project's own settings
// instead of only adding depug's.
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Vitest resolves `root` against the process cwd, not this file's own
  // directory, unless told otherwise. Pinning it here is what lets this
  // config (and the depug wrapper that imports it) be run with `--config`
  // from any cwd and still only see this fixture's own files.
  root: import.meta.dirname,
  define: {
    __FIXTURE_MARKER__: JSON.stringify("fixture-original-config"),
  },
  test: {
    setupFiles: ["./support/fixture-setup.ts"],
  },
});
