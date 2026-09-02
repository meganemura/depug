// A Vite plugin that gives a test project depug's function entry/exit
// instrumentation without touching that project's own vitest.config.ts. A project loads it
// by writing one small wrapper config that imports its own config and adds
// this plugin (see fixtures/basic/vitest.depug.config.ts for the pattern);
// the project's config file itself never changes.
import type { Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { instrumentSource } from "./transform.ts";

// Resolved relative to this file, not the caller's cwd, so the wrapper
// config works regardless of which directory vitest is invoked from.
const SETUP_FILE = fileURLToPath(new URL("./setup.ts", import.meta.url));

export interface DepugPluginOptions {
  /**
   * Returns true for a module id that should be instrumented. Defaults to
   * every non-test .ts/.tsx file outside node_modules. Callers with a
   * narrower "app code" boundary (a src/ directory, for example) should
   * pass their own predicate.
   */
  include?: (id: string) => boolean;
}

const DEFAULT_INCLUDE = (id: string): boolean => {
  if (id.includes("/node_modules/")) return false;
  if (!/\.tsx?$/.test(id)) return false;
  if (/\.(test|spec)\.tsx?$/.test(id)) return false;
  return true;
};

export function depugPlugin(options: DepugPluginOptions = {}): Plugin {
  const include = options.include ?? DEFAULT_INCLUDE;

  return {
    name: "depug",
    // Runs before vite:esbuild strips types, so `code` is still the
    // original TypeScript text the transform's positions are measured
    // against.
    enforce: "pre",
    config() {
      return {
        test: {
          setupFiles: [SETUP_FILE],
        },
      };
    },
    transform(code, id) {
      if (!include(id)) return null;
      const { code: instrumented } = instrumentSource(code, id);
      // instrumentSource never re-prints the tree (see transform.ts), so
      // there is no coordinate remapping to describe: line and column are
      // the same literals a source map would otherwise exist to recover.
      return { code: instrumented, map: null };
    },
  };
}
