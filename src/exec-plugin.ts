// Loads the injection rewrite into a test run, for one function and one
// line.
//
// It touches exactly one file, the one holding the target. Every other
// module in the run reaches the runtime unchanged, which is what keeps an
// injection from being something a reader has to go looking for.
import type { Plugin } from "vite";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { instrumentExec } from "./exec-transform.ts";

const SETUP_FILE = fileURLToPath(new URL("./exec-setup.ts", import.meta.url));

export interface ExecPluginOptions {
  root: string;
  targetPath: string;
  targetName: string;
  targetLine: number;
  targetColumn: number;
  /** The line to evaluate at. */
  atLine: number;
  /** The caller's expression, as source. */
  expression: string;
}

export function depugExecPlugin(options: ExecPluginOptions): Plugin {
  return {
    name: "depug-exec",
    enforce: "pre",
    config() {
      return { test: { setupFiles: [SETUP_FILE] } };
    },
    transform(code, id) {
      const relativeId = relative(options.root, id);
      if (relativeId !== options.targetPath) return null;
      const result = instrumentExec(code, relativeId, {
        name: options.targetName,
        line: options.targetLine,
        column: options.targetColumn,
        targetLine: options.atLine,
        expression: options.expression,
      });
      if (!result.injected) return null;
      return { code: result.code, map: null };
    },
  };
}
