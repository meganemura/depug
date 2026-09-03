// `frames`: run one test again with instrumentation and write the call
// index.
//
// A snapshot names where a failure surfaced. The index names every call
// the test made, so an agent can find the one that produced the value and
// address it by id. Building it costs a whole extra run of the test, which
// is why nothing builds it until a verb is invoked.
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { readCodeState, type CodeState } from "../code-state.ts";
import { readWorkerFiles, type FrameRecord } from "../collector.ts";
import { SCHEMA_VERSION } from "../evidence.ts";
import { applyConfigArgument, writeWrapperConfig } from "../wrapper-config.ts";
import { detectRunner, withNodeTestHook, type Runner } from "../runner.ts";

export interface FramesEnvelope {
  type: "envelope";
  schema_version: number;
  code_state: CodeState;
  command: string[];
  exit_status: number | null;
  seed: number | null;
  outside_window_events: number;
}

export interface FramesResult {
  /** One file for each worker that recorded anything. */
  files: string[];
  records: FrameRecord[];
  envelope: FramesEnvelope;
  stdout: string;
  stderr: string;
}

/**
 * A directory for one verb's worker files, under the project's own output
 * directory. Each invocation gets its own so a second run does not read
 * the first one's records back as its own.
 */
export function freshFramesDir(cwd: string): string {
  const base = process.env.DEPUG_OUTPUT_DIR ?? join(cwd, "tmp", "depug");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "frames-"));
}

/** Reads `--sequence.seed` back out of the command, for the envelope. */
export function seedFromCommand(args: readonly string[]): number | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--sequence.seed=")) {
      const value = Number(arg.slice("--sequence.seed=".length));
      return Number.isFinite(value) ? value : null;
    }
    if (arg === "--sequence.seed") {
      const value = Number(args[i + 1]);
      return Number.isFinite(value) ? value : null;
    }
  }
  return null;
}

export interface RunFramesInput {
  /** The child command, already split: `["npx", "vitest", "run", ...]`. */
  command: string[];
  cwd: string;
  /** Files under any of these prefixes are instrumented; the application boundary. */
  includePathPrefixes: string[];
  /** Detected from the command when not given. */
  runner?: Runner;
  /**
   * Where the worker files go. The default puts them beside the failure
   * snapshots, under the project's own `tmp/depug`, so everything one
   * investigation produced sits in one place a reader can list.
   */
  framesDir?: string;
  timeoutMs?: number;
}

/**
 * Runs the command once with the plugin loaded, then reads back what the
 * workers recorded and appends the envelope.
 *
 * The envelope goes on after the child exits because only the parent knows
 * how the child ended. A reader who finds records but no envelope is
 * looking at a run that did not finish.
 */
export function runFrames(input: RunFramesInput): FramesResult {
  const framesDir = input.framesDir ?? freshFramesDir(input.cwd);
  const runner = input.runner ?? detectRunner(input.command);

  // node:test has no config to wrap: Node owns the transform step itself,
  // so the command goes through untouched and the hook arrives by
  // NODE_OPTIONS.
  const wrapper =
    runner === "vitest"
      ? writeWrapperConfig({ cwd: input.cwd, includePathPrefixes: input.includePathPrefixes })
      : undefined;

  const [bin, ...rest] = input.command;
  const args = wrapper ? applyConfigArgument(rest, wrapper.configPath).args : [...rest];

  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // A verb spawns a fresh top-level vitest. Inherited pool variables
    // would make the child believe it is already a worker.
    if (key.startsWith("VITEST") || key.startsWith("TINYPOOL")) continue;
    env[key] = value;
  }
  env.DEPUG_FRAMES_DIR = framesDir;
  if (runner === "node") {
    env.NODE_OPTIONS = withNodeTestHook(env.NODE_OPTIONS);
    env.DEPUG_ROOT = input.cwd;
    // A JSON list, because a path may hold any delimiter a plain join
    // would pick, and the hook still accepts a bare string.
    env.DEPUG_INCLUDE = JSON.stringify(input.includePathPrefixes.map((p) => relative(input.cwd, p)));
  }
  // The child is a re-execution, not the suite. Its own failures are the
  // point, and a second set of snapshot files would only add noise.
  env.DEPUG_DISABLE = "1";

  let child;
  try {
    child = spawnSync(bin, args, {
      cwd: input.cwd,
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: input.timeoutMs ?? 120_000,
    });
  } finally {
    // The generated config has done its work once the child has read it.
    // Leaving it behind would let a stale one be picked up by a later glob.
    wrapper?.cleanup();
  }

  const workerFiles = readWorkerFiles(framesDir);
  const records = workerFiles.flatMap((file) => file.records);

  const envelope: FramesEnvelope = {
    type: "envelope",
    schema_version: SCHEMA_VERSION,
    code_state: readCodeState(input.cwd),
    command: input.command,
    exit_status: child.status,
    seed: seedFromCommand(rest),
    outside_window_events: records.filter((record) => record.test === null).length,
  };

  for (const file of workerFiles) {
    appendFileSync(file.path, `${JSON.stringify(envelope)}\n`);
  }

  return {
    files: workerFiles.map((file) => file.path),
    records,
    envelope,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
  };
}

/**
 * The sequence two runs are compared on: the calls the application made,
 * in order. Suspend and resume are left out of this projection because a
 * caller asks for them separately, as a second, stricter comparison.
 */
export function callSequence(records: readonly FrameRecord[]): string[] {
  return records.filter((record) => record.type === "call").map((record) => record.fid);
}

export function fullSequence(records: readonly FrameRecord[]): string[] {
  return records.map((record) => `${record.type}:${record.fid}`);
}
