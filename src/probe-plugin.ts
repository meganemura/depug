// Loads the probe rewrite into a test run, and installs the collector the
// rewritten code calls.
//
// This is a second plugin rather than a mode of the first one because the
// two rewrites answer to different verbs. `frames` instruments every file
// it is pointed at; a probe instruments the one file holding its target
// and leaves the rest of the run at its ordinary speed.
import type { Plugin } from "vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { instrumentProbes, type ProbeTarget } from "./probe-transform.ts";

const SETUP_FILE = fileURLToPath(new URL("./probe-setup.ts", import.meta.url));

export interface ProbePluginOptions {
  /** Function ids to observe, each `path:name@line:column`. */
  targets: readonly string[];
  /** Ids name a file relative to this directory. */
  root?: string;
}

export function depugProbePlugin(options: ProbePluginOptions): Plugin {
  const root = options.root ?? process.cwd();
  // Every target names its file in its own first segment, so the plugin
  // knows which files to touch without being told a second time.
  const files = new Set(options.targets.map((target) => target.slice(0, target.indexOf(":"))));

  return {
    name: "depug-probe",
    // Ahead of vite:esbuild, so the rewrite sees TypeScript and the
    // positions in an id mean what they say.
    enforce: "pre",
    config() {
      return { test: { setupFiles: [SETUP_FILE] } };
    },
    transform(code, id) {
      const relativeId = relative(root, id);
      if (!files.has(relativeId)) return null;
      const result = instrumentProbes(code, relativeId, options.targets);
      if (result.targets.length === 0) return null;
      // What the rewrite matched is known here and needed by the verb,
      // which runs in the parent process. The verb reads it back from this
      // file, the same way it reads the observations.
      writeTargets(result.targets);
      return { code: result.code, map: null };
    },
  };
}

/**
 * Records which functions the rewrite matched, and which of their
 * parameters it could not read. A verb reports both, so a reader can tell
 * "this parameter was always undefined" from "nobody looked at it".
 */
function writeTargets(targets: readonly ProbeTarget[]): void {
  const dir = process.env.DEPUG_PROBE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `targets-${process.pid}.json`), JSON.stringify(targets));
}
