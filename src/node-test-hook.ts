// Loads depug into a `node --test` run.
//
// This is the whole of node:test support, and it is short because the
// rewriting was never tied to a runner. depug instruments by rewriting
// TypeScript before it executes; vitest happens to own that step through a
// vite plugin, and Node owns it through `module.registerHooks`. The
// transforms, the runtimes, and the files they write are the same ones.
//
// A verb loads this with `NODE_OPTIONS="--import <this file>"`, which
// reaches the child process node:test starts for each test file. A plain
// `--import` on the command line does not: it applies to the parent, and
// the tests run somewhere else.
//
// Which mode runs is read from the same environment variables the vitest
// plugins read, so a verb sets up one runner the same way it sets up the
// other.
import { registerHooks } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach } from "node:test";
import { instrumentSource } from "./transform.ts";
import { installGlobalRuntime } from "./runtime.ts";
import { flushWorker } from "./collector.ts";
import { instrumentProbes } from "./probe-transform.ts";
import { installGlobalProbeRuntime } from "./probe-runtime.ts";
import { instrumentExec } from "./exec-transform.ts";
import { installGlobalExecRuntime, renderExecValue } from "./exec-runtime.ts";
import { instrumentTarget } from "./flt-transform.ts";
import { installGlobalFltRuntime } from "./flt-runtime.ts";
import { flushFltWorker } from "./flt-collector.ts";
import { DEFAULT_LIMITS } from "./evidence.ts";

const root = process.env.DEPUG_ROOT ?? process.cwd();

function sourceText(source: string | ArrayBufferView | undefined): string | undefined {
  if (source === undefined) return undefined;
  if (typeof source === "string") return source;
  return Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString("utf8");
}

/**
 * Rewrites one module, or returns undefined to leave it alone.
 *
 * Chosen once, at load, rather than per module: the mode cannot change
 * during a run, and a verb that set up two of these at once would be a
 * bug in the launcher rather than something to resolve here.
 */
type Rewrite = (relativePath: string, source: string) => string | undefined;

/**
 * What a mode does, separated from the act of installing it.
 *
 * The factories below decide and rewrite; the block at the bottom of this
 * file is the only place that touches Node's module system or node:test's
 * hooks. Keeping the decision out of the side effect is what lets a test
 * ask "which files would this touch, and what would it write" without a
 * runner in the room.
 */
export interface HookMode {
  rewrite: Rewrite;
  flush: () => void;
  /** True where events should be attributed to the running test. */
  attributesTests?: boolean;
  setCurrentTest?: (name: string | null) => void;
}

/**
 * The prefixes `DEPUG_INCLUDE` names: a JSON list, or one bare path for a
 * caller that predates the list. Both forms are relative to the root.
 */
export function readIncludePrefixes(value: string | undefined): string[] {
  if (value === undefined || value === "") return ["src"];
  if (value.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) return parsed as string[];
    } catch {
      // Not JSON after all; treat it as one path below.
    }
  }
  return [value];
}

function framesMode(env: NodeJS.ProcessEnv): HookMode {
  const runtime = installGlobalRuntime();
  const includePrefixes = readIncludePrefixes(env.DEPUG_INCLUDE);

  return {
    attributesTests: true,
    setCurrentTest: (name) => runtime.setCurrentTest(name),
    rewrite(relativePath, source) {
      if (!includePrefixes.some((prefix) => relativePath.startsWith(prefix))) return undefined;
      if (/\.(test|spec)\.tsx?$/.test(relativePath)) return undefined;
      return instrumentSource(source, relativePath).code;
    },
    flush() {
      const dir = env.DEPUG_FRAMES_DIR;
      if (dir) flushWorker(dir, runtime);
    },
  };
}

function probeMode(targets: string[], env: NodeJS.ProcessEnv): HookMode {
  const runtime = installGlobalProbeRuntime();
  const files = new Set(targets.map((target) => target.slice(0, target.indexOf(":"))));

  return {
    rewrite(relativePath, source) {
      if (!files.has(relativePath)) return undefined;
      const result = instrumentProbes(source, relativePath, targets);
      if (result.targets.length === 0) return undefined;
      writeSidecar("targets", result.targets, env);
      return result.code;
    },
    flush() {
      if (env.DEPUG_PROBE_DIR) writeSidecar("probe", runtime.dump(), env);
    },
  };
}

function execMode(env: NodeJS.ProcessEnv): HookMode {
  const prefix = env.DEPUG_EXEC_FID_PREFIX ?? "";
  const runtime = installGlobalExecRuntime({
    fidPrefix: prefix,
    targetCall: Number(env.DEPUG_EXEC_CALL ?? "1"),
    targetLine: Number(env.DEPUG_EXEC_LINE ?? "0"),
    targetVisit: Number(env.DEPUG_EXEC_VISIT ?? "1"),
  });
  (globalThis as { __depugExecRender?: typeof renderExecValue }).__depugExecRender = renderExecValue;

  // The prefix is `path:name@line:column#`, which is where the target's
  // own coordinates come from without a second set of variables.
  const match = /^(.*):([^:]*)@(\d+):(\d+)#$/.exec(prefix);

  return {
    rewrite(relativePath, source) {
      if (!match || relativePath !== match[1]) return undefined;
      const result = instrumentExec(source, relativePath, {
        name: match[2],
        line: Number(match[3]),
        column: Number(match[4]),
        targetLine: Number(env.DEPUG_EXEC_LINE ?? "0"),
        expression: env.DEPUG_EXEC_STATEMENT ?? "undefined",
      });
      return result.injected ? result.code : undefined;
    },
    flush() {
      const dir = env.DEPUG_EXEC_DIR;
      if (!dir) return;
      const lines = runtime.dump().map((record) => JSON.stringify(record));
      writeFile(dir, `exec-${process.pid}.jsonl`, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
    },
  };
}

function fltMode(env: NodeJS.ProcessEnv): HookMode {
  const runtime = installGlobalFltRuntime(Number(env.DEPUG_FLT_TARGET_K ?? "0"), DEFAULT_LIMITS);
  const target = {
    path: env.DEPUG_FLT_PATH ?? "",
    name: env.DEPUG_FLT_NAME ?? "",
    line: Number(env.DEPUG_FLT_LINE ?? "0"),
    column: Number(env.DEPUG_FLT_COLUMN ?? "0"),
  };

  return {
    attributesTests: true,
    setCurrentTest: (name) => runtime.setCurrentTest(name),
    rewrite(relativePath, source) {
      if (relativePath !== target.path) return undefined;
      const result = instrumentTarget(source, relativePath, {
        name: target.name,
        line: target.line,
        column: target.column,
      });
      return result.found ? result.code : undefined;
    },
    flush() {
      const dir = env.DEPUG_FLT_DIR;
      if (dir) flushFltWorker(dir, runtime);
    },
  };
}

/** Writes one JSON file into the probe directory, named by process. */
function writeSidecar(prefix: string, value: unknown, env: NodeJS.ProcessEnv): void {
  const dir = env.DEPUG_PROBE_DIR;
  if (!dir) return;
  writeFile(dir, `${prefix}-${process.pid}.json`, JSON.stringify(value));
}

function writeFile(dir: string, name: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
}

/**
 * Picks the mode from the variables a verb set, or undefined where none
 * did. Takes the environment rather than reading the global one, so the
 * choice can be exercised without a process to arrange.
 */
export function chooseMode(env: NodeJS.ProcessEnv): HookMode | undefined {
  const probeTargets = env.DEPUG_PROBE_TARGETS;
  if (probeTargets) return probeMode(JSON.parse(probeTargets) as string[], env);
  if (env.DEPUG_EXEC_FID_PREFIX) return execMode(env);
  if (env.DEPUG_FLT_DIR) return fltMode(env);
  if (env.DEPUG_FRAMES_DIR) return framesMode(env);
  return undefined;
}

/** Rewrites one module, or returns undefined to leave it alone. */
export function rewriteFor(mode: HookMode, root: string, path: string, text: string): string | undefined {
  if (!/\.tsx?$/.test(path) || path.includes("/node_modules/")) return undefined;
  return mode.rewrite(relative(root, path), text);
}

const mode = chooseMode(process.env);

if (mode) {
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.startsWith("file:")) return result;
      const path = fileURLToPath(url);

      const text = sourceText(result.source as string | ArrayBufferView | undefined);
      if (text === undefined) return result;

      const rewritten = rewriteFor(mode, root, path, text);
      // The source goes back with its format untouched, so Node still
      // strips the types afterwards. depug rewrites TypeScript and hands
      // back TypeScript.
      return rewritten === undefined ? result : { ...result, source: rewritten };
    },
  });

  if (mode.attributesTests && mode.setCurrentTest) {
    beforeEach((t: { name?: string }) => mode.setCurrentTest!(t?.name ?? null));
    afterEach(() => mode.setCurrentTest!(null));
  }

  process.on("exit", () => mode.flush());
}
