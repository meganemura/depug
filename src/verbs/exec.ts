// `exec`: evaluate one expression inside one call, at one line, on one
// visit.
//
// Every other verb observes. This one changes what the program computes,
// which makes it the answer to a question the others cannot reach: not
// "what was this value", but "what would happen if it were something
// else". A caller who has read a trace and formed a hypothesis tests it
// here instead of editing the source and remembering to put it back.
//
// The launcher sets the token that arms the injection. Nothing else does,
// so an instrumented file left behind by a crashed run evaluates nothing
// on the next ordinary test run.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readCodeState, type CodeState } from "../code-state.ts";
import { SCHEMA_VERSION } from "../evidence.ts";
import { parseFid } from "../fid.ts";
import { EXEC_TOKEN, type ExecRecord } from "../exec-runtime.ts";
import { writeExecWrapperConfig } from "../exec-wrapper-config.ts";
import { applyConfigArgument } from "../wrapper-config.ts";
import { detectRunner, withNodeTestHook, type Runner } from "../runner.ts";

export interface ExecEnvelope {
  type: "envelope";
  schema_version: number;
  code_state: CodeState;
  command: string[];
  exit_status: number | null;
}

export interface ExecResult {
  file: string | null;
  records: ExecRecord[];
  envelope: ExecEnvelope;
  stdout: string;
  stderr: string;
  /** Set when the id could not be read, before anything was run. */
  error?: string;
}

export interface RunExecInput {
  /** A complete id, including `#k`. */
  fid: string;
  atLine: number;
  visit: number;
  expression: string;
  command: string[];
  cwd: string;
  /** Detected from the command when not given. */
  runner?: Runner;
  timeoutMs?: number;
}

export function runExec(input: RunExecInput): ExecResult {
  const parsed = parseFid(input.fid);
  const empty: ExecEnvelope = {
    type: "envelope",
    schema_version: SCHEMA_VERSION,
    code_state: readCodeState(input.cwd),
    command: input.command,
    exit_status: null,
  };
  if (!parsed || parsed.call === undefined) {
    return {
      file: null,
      records: [],
      envelope: empty,
      stdout: "",
      stderr: "",
      error: "exec needs a complete function id, including #k",
    };
  }

  const base = process.env.DEPUG_OUTPUT_DIR ?? join(input.cwd, "tmp", "depug");
  mkdirSync(base, { recursive: true });
  const execDir = mkdtempSync(join(base, "exec-"));

  const runner = input.runner ?? detectRunner(input.command);
  const wrapper =
    runner === "vitest"
      ? writeExecWrapperConfig({
          cwd: input.cwd,
          targetPath: parsed.path,
          targetName: parsed.name,
          targetLine: parsed.line,
          targetColumn: parsed.column,
          atLine: input.atLine,
          expression: input.expression,
        })
      : undefined;

  const [bin, ...rest] = input.command;
  const args = wrapper ? applyConfigArgument(rest, wrapper.configPath).args : [...rest];

  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("VITEST") || key.startsWith("TINYPOOL")) continue;
    env[key] = value;
  }
  env.DEPUG_EXEC_DIR = execDir;
  env.DEPUG_EXEC_FID_PREFIX = `${parsed.path}:${parsed.name}@${parsed.line}:${parsed.column}#`;
  env.DEPUG_EXEC_CALL = String(parsed.call);
  env.DEPUG_EXEC_LINE = String(input.atLine);
  env.DEPUG_EXEC_VISIT = String(input.visit);
  env.DEPUG_DISABLE = "1";
  // The one place the injection is armed.
  env[EXEC_TOKEN] = "1";
  if (runner === "node") {
    env.NODE_OPTIONS = withNodeTestHook(env.NODE_OPTIONS);
    env.DEPUG_ROOT = input.cwd;
    env.DEPUG_EXEC_STATEMENT = input.expression;
  }

  let child;
  try {
    child = spawnSync(bin, args, {
      cwd: input.cwd,
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: input.timeoutMs ?? 120_000,
    });
  } finally {
    wrapper?.cleanup();
  }

  let file: string | null = null;
  const records: ExecRecord[] = [];
  for (const name of readdirSync(execDir)) {
    if (!name.startsWith("exec-")) continue;
    const path = join(execDir, name);
    const text = readFileSync(path, "utf8");
    if (text.trim() === "") continue;
    file = path;
    for (const line of text.split("\n")) {
      if (line.trim() !== "") records.push(JSON.parse(line) as ExecRecord);
    }
  }

  return {
    file,
    records,
    envelope: { ...empty, exit_status: child.status },
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
  };
}

/** The report a reader sees, in the same shape whichever way it went. */
export function formatExec(result: ExecResult): string {
  if (result.error) return `depug: ${result.error}`;
  const lines: string[] = [];
  if (result.file) lines.push(`depug exec: ${result.file}`);

  for (const record of result.records) {
    if (record.type === "evaluation") {
      if (record.value !== undefined) lines.push(`depug value: ${record.value}`);
      else lines.push(`depug raised: ${record.name}: ${record.message}`);
    } else if (record.type === "evaluation_summary") {
      lines.push(
        `depug note: line ${record.line} was visited ${record.line_visits_observed} time(s);` +
          ` visit ${record.target_visit} never happened`,
      );
    } else {
      lines.push(
        `depug note: call #${record.target_index} did not happen;` +
          ` observed ${record.observed_calls} call(s) of this function`,
      );
    }
  }

  if (result.records.length === 0) {
    // Nothing was recorded at all, which means the rewrite never reached
    // the target. Saying that plainly beats an empty file.
    lines.push("depug note: nothing was evaluated; check the id and the line against a frames index");
  }
  // The injected expression can change what the test does, so the child's
  // own outcome is part of the result rather than a footnote.
  lines.push(`depug result: ${describeExit(result.envelope.exit_status)}`);
  return lines.join("\n");
}

function describeExit(status: number | null): string {
  if (status === 0) return "pass (exit 0)";
  if (status === null) return "no exit status (the child was killed or timed out)";
  return `fail (exit ${status})`;
}
