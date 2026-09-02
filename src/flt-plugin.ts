// A Vite plugin that loads flt's per-statement instrumentation into a
// project's test run, the way src/plugin.ts loads the always-on layer.
//
// This does not load src/plugin.ts's `depugPlugin` alongside it, and a
// wrapper config built from this file must not add it either: two
// transforms both rewriting the same file would have the second one read
// the first's already-rewritten text, and every literal position flt
// embeds would then describe that intermediate text instead of the
// TypeScript source (see docs/design-decisions.md, "Positions are
// literals").
import type { Plugin } from "vite";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { instrumentTarget } from "./flt-transform.ts";

const SETUP_FILE = fileURLToPath(new URL("./flt-setup.ts", import.meta.url));

export interface DepugFltPluginOptions {
  /** Paths in the target's fid are written relative to this directory. */
  root: string;
  /** The fid's own path component, e.g. "src/user.ts". */
  targetPath: string;
  targetName: string;
  targetLine: number;
  targetColumn: number;
}

export function depugFltPlugin(options: DepugFltPluginOptions): Plugin {
  return {
    name: "depug-flt",
    enforce: "pre",
    config() {
      return {
        test: {
          setupFiles: [SETUP_FILE],
        },
      };
    },
    transform(code, id) {
      if (id.includes("/node_modules/")) return null;
      if (!/\.tsx?$/.test(id)) return null;
      const relPath = relative(options.root, id);
      if (relPath !== options.targetPath) return null;

      const result = instrumentTarget(code, relPath, {
        name: options.targetName,
        line: options.targetLine,
        column: options.targetColumn,
      });
      if (!result.found) return null;
      return { code: result.code, map: null };
    },
  };
}
