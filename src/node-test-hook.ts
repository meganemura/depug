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

function framesMode(): { rewrite: Rewrite; flush: () => void } {
  const runtime = installGlobalRuntime();
  const includePrefix = process.env.DEPUG_INCLUDE ?? "src";

  beforeEach((t: { name?: string }) => runtime.setCurrentTest(t?.name ?? null));
  afterEach(() => runtime.setCurrentTest(null));

  return {
    rewrite(relativePath, source) {
      if (!relativePath.startsWith(includePrefix)) return undefined;
      if (/\.(test|spec)\.tsx?$/.test(relativePath)) return undefined;
      return instrumentSource(source, relativePath).code;
    },
    flush() {
      const dir = process.env.DEPUG_FRAMES_DIR;
      if (dir) flushWorker(dir, runtime);
    },
  };
}

function probeMode(targets: string[]): { rewrite: Rewrite; flush: () => void } {
  const runtime = installGlobalProbeRuntime();
  const files = new Set(targets.map((target) => target.slice(0, target.indexOf(":"))));

  return {
    rewrite(relativePath, source) {
      if (!files.has(relativePath)) return undefined;
      const result = instrumentProbes(source, relativePath, targets);
      if (result.targets.length === 0) return undefined;
      writeSidecar("targets", result.targets);
      return result.code;
    },
    flush() {
      const dir = process.env.DEPUG_PROBE_DIR;
      if (dir) writeSidecar("probe", runtime.dump());
    },
  };
}

function execMode(): { rewrite: Rewrite; flush: () => void } {
  const prefix = process.env.DEPUG_EXEC_FID_PREFIX ?? "";
  const runtime = installGlobalExecRuntime({
    fidPrefix: prefix,
    targetCall: Number(process.env.DEPUG_EXEC_CALL ?? "1"),
    targetLine: Number(process.env.DEPUG_EXEC_LINE ?? "0"),
    targetVisit: Number(process.env.DEPUG_EXEC_VISIT ?? "1"),
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
        targetLine: Number(process.env.DEPUG_EXEC_LINE ?? "0"),
        expression: process.env.DEPUG_EXEC_STATEMENT ?? "undefined",
      });
      return result.injected ? result.code : undefined;
    },
    flush() {
      const dir = process.env.DEPUG_EXEC_DIR;
      if (!dir) return;
      const lines = runtime.dump().map((record) => JSON.stringify(record));
      writeFile(dir, `exec-${process.pid}.jsonl`, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
    },
  };
}

function fltMode(): { rewrite: Rewrite; flush: () => void } {
  const runtime = installGlobalFltRuntime(
    Number(process.env.DEPUG_FLT_TARGET_K ?? "0"),
    DEFAULT_LIMITS,
  );
  const target = {
    path: process.env.DEPUG_FLT_PATH ?? "",
    name: process.env.DEPUG_FLT_NAME ?? "",
    line: Number(process.env.DEPUG_FLT_LINE ?? "0"),
    column: Number(process.env.DEPUG_FLT_COLUMN ?? "0"),
  };

  beforeEach((t: { name?: string }) => runtime.setCurrentTest(t?.name ?? null));
  afterEach(() => runtime.setCurrentTest(null));

  return {
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
      const dir = process.env.DEPUG_FLT_DIR;
      if (dir) flushFltWorker(dir, runtime);
    },
  };
}

/** Writes one JSON file into the probe directory, named by process. */
function writeSidecar(prefix: string, value: unknown): void {
  const dir = process.env.DEPUG_PROBE_DIR;
  if (!dir) return;
  writeFile(dir, `${prefix}-${process.pid}.json`, JSON.stringify(value));
}

function writeFile(dir: string, name: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
}

function chooseMode(): { rewrite: Rewrite; flush: () => void } | undefined {
  const probeTargets = process.env.DEPUG_PROBE_TARGETS;
  if (probeTargets) return probeMode(JSON.parse(probeTargets) as string[]);
  if (process.env.DEPUG_EXEC_FID_PREFIX) return execMode();
  if (process.env.DEPUG_FLT_DIR) return fltMode();
  if (process.env.DEPUG_FRAMES_DIR) return framesMode();
  return undefined;
}

const mode = chooseMode();

if (mode) {
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.startsWith("file:")) return result;
      const path = fileURLToPath(url);
      if (!/\.tsx?$/.test(path) || path.includes(`${"/"}node_modules${"/"}`)) return result;

      const text = sourceText(result.source as string | ArrayBufferView | undefined);
      if (text === undefined) return result;

      const rewritten = mode.rewrite(relative(root, path), text);
      // The source goes back with its format untouched, so Node still
      // strips the types afterwards. depug rewrites TypeScript and hands
      // back TypeScript.
      return rewritten === undefined ? result : { ...result, source: rewritten };
    },
  });

  process.on("exit", () => mode.flush());
}
