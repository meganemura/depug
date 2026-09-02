// `flt`: run one call again with per-statement instrumentation and write
// its frame lifetime trace.
//
// Where `frames` indexes every call a test made, `flt` follows one of
// them, named by its full fid including `#k`, and shows how its locals
// changed statement by statement. See src/flt-transform.ts and
// src/flt-runtime.ts for how the trace itself is built; this module is the
// same shape as src/verbs/frames.ts's `runFrames`: write a wrapper config,
// spawn the command once, read back what the worker(s) wrote, append the
// envelope.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { compareCodeState, readCodeState, type CodeState } from "../code-state.ts";
import { DEFAULT_LIMITS, SCHEMA_VERSION, type Limits } from "../evidence.ts";
import type { ParsedFid } from "../fid.ts";
import { readFltWorkerFiles, type FltWorkerFile } from "../flt-collector.ts";
import type { FltRecord } from "../flt-runtime.ts";
import { writeFltWrapperConfig } from "../flt-wrapper-config.ts";
import { applyConfigArgument } from "../wrapper-config.ts";

export interface FltEnvelope {
  type: "envelope";
  schema_version: number;
  code_state: CodeState;
  command: string[];
  exit_status: number | null;
  limits: Limits;
  /** The `#k` the caller asked for. */
  target_index: number;
  /** How many times the target function ran, summed across every worker. */
  observed_calls: number;
  traced: boolean;
}

export interface FltTarget extends ParsedFid {
  call: number;
}

export interface RunFltInput {
  command: string[];
  cwd: string;
  target: FltTarget;
  /** A `frames` index whose code_state must match this run's, or refuse. */
  indexPath?: string;
  fltDir?: string;
  timeoutMs?: number;
}

export interface FltResult {
  files: string[];
  records: FltRecord[];
  envelope: FltEnvelope;
  stdout: string;
  stderr: string;
  /** Set instead of running the child, when --index's code state does not match. */
  refused?: string;
  /** Set when --index's comparison could not be made at all (git unavailable on either side). */
  codeStateWarning?: string;
}

export function freshFltDir(cwd: string): string {
  const base = process.env.DEPUG_OUTPUT_DIR ?? join(cwd, "tmp", "depug");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "flt-"));
}

/**
 * Reads the code_state off a frames index's own envelope, scanning from
 * the end: the envelope is always the last record `frames` appends, but
 * scanning backward also copes with a trailing blank line or, harmlessly,
 * a second envelope appended by a later run reusing the same file.
 */
function readIndexCodeState(path: string): CodeState | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && parsed.type === "envelope" && parsed.code_state) return parsed.code_state as CodeState;
    } catch {
      // Not JSON, or not the shape expected: keep scanning backward.
    }
  }
  return undefined;
}

function emptyEnvelope(input: RunFltInput, codeState: CodeState, exitStatus: number | null): FltEnvelope {
  return {
    type: "envelope",
    schema_version: SCHEMA_VERSION,
    code_state: codeState,
    command: input.command,
    exit_status: exitStatus,
    limits: DEFAULT_LIMITS,
    target_index: input.target.call,
    observed_calls: 0,
    traced: false,
  };
}

export function runFlt(input: RunFltInput): FltResult {
  const codeState = readCodeState(input.cwd);
  let codeStateWarning: string | undefined;

  if (input.indexPath) {
    const indexState = readIndexCodeState(input.indexPath);
    const comparison = indexState ? compareCodeState(indexState, codeState) : "unknown";
    if (comparison === "mismatch") {
      return {
        files: [],
        records: [],
        envelope: emptyEnvelope(input, codeState, null),
        stdout: "",
        stderr: "",
        refused: `the code state in ${input.indexPath} does not match this run's working tree`,
      };
    }
    if (comparison === "unknown") {
      codeStateWarning = `the code state in ${input.indexPath} or this run could not be read; continuing without comparing them`;
    }
  }

  const fltDir = input.fltDir ?? freshFltDir(input.cwd);
  const wrapper = writeFltWrapperConfig({
    cwd: input.cwd,
    target: {
      path: input.target.path,
      name: input.target.name,
      line: input.target.line,
      column: input.target.column,
    },
  });

  const [bin, ...rest] = input.command;
  const { args } = applyConfigArgument(rest, wrapper.configPath);

  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // A verb spawns a fresh top-level vitest; see runFrames for why
    // inherited pool variables have to be stripped first.
    if (key.startsWith("VITEST") || key.startsWith("TINYPOOL")) continue;
    env[key] = value;
  }
  env.DEPUG_FLT_DIR = fltDir;
  env.DEPUG_FLT_TARGET_K = String(input.target.call);
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
    wrapper.cleanup();
  }

  const workerFiles = readFltWorkerFiles(fltDir);
  const records = workerFiles.flatMap((file) => file.records);
  const traced = records.some((record) => record.type === "call");
  const observedCalls = sumObservedCalls(workerFiles, traced, input.target.call);

  const envelope: FltEnvelope = {
    type: "envelope",
    schema_version: SCHEMA_VERSION,
    code_state: codeState,
    command: input.command,
    exit_status: child.status,
    limits: DEFAULT_LIMITS,
    target_index: input.target.call,
    observed_calls: observedCalls,
    traced,
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
    codeStateWarning,
  };
}

/**
 * A worker that traced the target contributes at least `targetCall` (it
 * proved that many calls happened by reaching the one asked for); every
 * other worker contributes its own target_summary count, or 0 where the
 * target file never even loaded there. Two workers both reaching the same
 * #k independently is not expected -- see flt.md -- but summing rather
 * than picking one keeps this total honest if it ever happens.
 */
function sumObservedCalls(files: readonly FltWorkerFile[], traced: boolean, targetCall: number): number {
  let total = traced ? targetCall : 0;
  for (const file of files) {
    const fileTraced = file.records.some((record) => record.type === "call");
    if (!fileTraced) total += file.observedCalls;
  }
  return total;
}
