// The command line: `depug <verb> -- <command...>`.
//
// Every verb takes the command that runs one test, because that command is
// what the failure output already printed. An agent copies the rerun line
// it was given and puts a verb in front of it; nothing has to be
// translated between the two.
//
// depug never runs a test command on its own initiative. Each verb starts
// a process only when invoked, which is what keeps the always-on layer
// free of the cost.
import { resolve } from "node:path";
import { writeJson } from "./evidence.ts";
import { parseFid } from "./fid.ts";
import { renderDeclared, renderObserved } from "./shape-report.ts";
import { readFileSync } from "node:fs";
import { functionsContaining } from "./function-range.ts";
import { declaresProjects, findProjectConfig } from "./wrapper-config.ts";
import { runFrames } from "./verbs/frames.ts";
import { runFlt } from "./verbs/flt.ts";
import { formatPreflight, runPreflight } from "./verbs/preflight.ts";
import { runProbe } from "./verbs/probe.ts";
import { formatExec, runExec } from "./verbs/exec.ts";

export interface CliResult {
  exitCode: number;
  stdout: string;
}

const USAGE = `depug <verb> [options] -- <command...>

Verbs:
  frames     -- <command>   Index every application call one test makes
  preflight  -- <command>   Run the command twice and compare the calls
  probe <fid> -- <command>  Record what one function received and returned,
                            beside what it was declared to
  flt <fid> -- <command>    Follow one call, named with its #k, and show how
                            its locals changed statement by statement
  exec <fid> --line N --statement <expr> -- <command...>
                            Evaluate an expression inside one call, at one
                            line, in that line's own scope

Options:
  --include <path>   Instrument files under this path (default: <cwd>/src)
  --cwd <path>       Run the command here (default: the current directory)
  --index <path>     flt only: refuse if this frames index's code state
                      does not match the working tree this run starts from
  --at <file>:<n>    frames only: name the calls whose function holds that
                      line, innermost first
  --line <n>         exec only: the line to evaluate at
  --visit <k>        exec only: which visit to that line (default: 1)
  --statement <expr> exec only: the expression to evaluate

The command is the rerun line a failure printed, for example:
  depug frames -- npx vitest run "test/user.test.ts" -t "parses a user"
`;

interface ParsedArgs {
  verb: string;
  command: string[];
  /** Positional arguments the verb takes before its options. */
  operands: string[];
  include?: string;
  cwd?: string;
  line?: number;
  visit?: number;
  statement?: string;
  at?: string;
  index?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  const separator = argv.indexOf("--");
  if (separator === -1) return { error: "the command must follow `--`" };

  const before = argv.slice(0, separator);
  const command = argv.slice(separator + 1);
  if (before.length === 0) return { error: "no verb was given" };
  if (command.length === 0) return { error: "no command followed `--`" };

  const parsed: ParsedArgs = { verb: before[0], command, operands: [] };
  for (let i = 1; i < before.length; i++) {
    const arg = before[i];
    if (arg === "--include") parsed.include = before[++i];
    else if (arg === "--cwd") parsed.cwd = before[++i];
    else if (arg === "--line") parsed.line = Number(before[++i]);
    else if (arg === "--visit") parsed.visit = Number(before[++i]);
    else if (arg === "--statement") parsed.statement = before[++i];
    else if (arg === "--at") parsed.at = before[++i];
    else if (arg === "--index") parsed.index = before[++i];
    else if (arg.startsWith("--")) return { error: `unknown option: ${arg}` };
    else parsed.operands.push(arg);
  }
  return parsed;
}

export function run(argv: readonly string[]): CliResult {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { exitCode: 0, stdout: USAGE };
  }

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    return { exitCode: 2, stdout: `depug: ${parsed.error}\n\n${USAGE}` };
  }

  const cwd = resolve(parsed.cwd ?? process.cwd());
  // `src` is the default because that is where a project's own code
  // usually sits, and instrumenting a dependency would put calls in the
  // index that no verb can address anyway.
  const includePathPrefix = resolve(cwd, parsed.include ?? "src");
  const input = { command: [...parsed.command], cwd, includePathPrefix };

  if (parsed.verb === "frames") {
    const result = runFrames(input);
    const calls = result.records.filter((r) => r.type === "call").length;
    const lines: string[] = [];
    for (const file of result.files) lines.push(`depug frames: ${file}`);
    lines.push(`depug calls: ${calls}`);
    if (calls === 0) {
      // An index of nothing and an index that was never built read the
      // same to someone scanning output, and the difference decides what
      // they do next. The usual cause is an include path the test never
      // reaches, so the note names that before anything else.
      lines.push("depug note: no application calls were recorded");
      lines.push(`depug note: nothing under ${includePathPrefix} ran; use --include to point elsewhere`);
      const config = findProjectConfig(cwd);
      if (declaresProjects(config)) {
        // The include path is also what locates the project holding the
        // code, so in a project-split repository a wrong one fails twice
        // over and the second way is not obvious.
        lines.push(
          `depug note: ${config} splits the run into vitest projects, so --include also has to` +
            " point inside the project whose code you want",
        );
      }
    }
    if (parsed.at) lines.push(...describeAt(parsed.at, cwd, result.records));
    lines.push(`depug result: ${describeExit(result.envelope.exit_status)}`);
    return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
  }

  if (parsed.verb === "preflight") {
    const result = runPreflight(input);
    return { exitCode: 0, stdout: `${formatPreflight(result)}\n` };
  }

  if (parsed.verb === "probe") {
    if (parsed.operands.length === 0) {
      return { exitCode: 2, stdout: `depug: probe needs a function id\n\n${USAGE}` };
    }
    const result = runProbe({ command: [...parsed.command], cwd, targets: parsed.operands });
    const path = resolve(cwd, "tmp", "depug", `probe-${process.pid}.json`);
    writeJson(path, result.output);

    const lines = [`depug probe: ${path}`];
    for (const id of result.output.targets_not_found) {
      // An id that matched nothing is the one failure a reader cannot see
      // from the file alone, because the file then has nothing in it.
      lines.push(`depug note: no function in the source has the id ${id}`);
    }
    for (const [id, fn] of Object.entries(result.output.functions)) {
      lines.push(`${id}  calls: ${fn.calls}, threw: ${fn.threw}`);
      // The values come before the shapes: chasing a wrong value among
      // several calls is what a reader most often opens a probe for, and
      // the shapes can agree while the values differ.
      for (const parameter of fn.parameters) {
        lines.push(`  ${parameter.name}: ${formatSamples(parameter.samples, parameter.samples_omitted)}`);
      }
      lines.push(`  returns: ${formatSamples(fn.returns.samples, fn.returns.samples_omitted)}`);
      lines.push(`  observed: ${renderObserved(fn.returns.observed)}`);
      lines.push(
        `  declared: ${fn.returns.declared ? renderDeclared(fn.returns.declared) : "(not read)"}`,
      );
      for (const mismatch of fn.returns.mismatches) {
        const where = mismatch.property === "" ? "return value" : mismatch.property;
        lines.push(
          `  mismatch: ${where} was ${mismatch.observed}, declared ${mismatch.declared}` +
            ` (${mismatch.occurrences} of ${mismatch.samples} calls)`,
        );
      }
    }
    lines.push(`depug result: ${describeExit(result.exitStatus)}`);
    return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
  }

  if (parsed.verb === "flt") {
    if (parsed.operands.length === 0) {
      return { exitCode: 2, stdout: `depug: flt needs a function id\n\n${USAGE}` };
    }
    const fidArg = parsed.operands[0];
    const target = parseFid(fidArg);
    if (!target || target.call === undefined) {
      return {
        exitCode: 2,
        stdout: `depug: flt needs a complete function id, including #k (got ${fidArg})\n\n${USAGE}`,
      };
    }

    const result = runFlt({
      command: [...parsed.command],
      cwd,
      target: { ...target, call: target.call },
      indexPath: parsed.index ? resolve(cwd, parsed.index) : undefined,
    });

    if (result.refused) {
      const lines = ["depug flt: refused", `depug note: ${result.refused}`, "depug result: refused"];
      return { exitCode: 1, stdout: `${lines.join("\n")}\n` };
    }

    const lines: string[] = [];
    for (const file of result.files) lines.push(`depug flt: ${file}`);
    if (result.codeStateWarning) lines.push(`depug note: ${result.codeStateWarning}`);
    if (!result.envelope.traced) {
      // A trace with no `call` record reads the same as one that never
      // ran at all, unless the note says which #k was asked for and how
      // many calls actually happened.
      lines.push(
        `depug note: call #${result.envelope.target_index} did not happen; ` +
          `observed ${result.envelope.observed_calls} call(s) of this function`,
      );
    } else if (result.records.every((record) => record.type !== "line")) {
      // The call happened and produced no statement records, which reads
      // like a function that did nothing. It usually means the body is a
      // single expression -- an arrow returning a call, say -- so the work
      // is in a function this one returns or hands off to, and that
      // function is a frame of its own.
      lines.push(
        "depug note: this call has no statements of its own to follow; " +
          "its body is a single expression, so the work is in a function it calls",
      );
      lines.push("depug note: find that call in a frames index and trace it instead");
    }
    lines.push(`depug result: ${describeExit(result.envelope.exit_status)}`);
    return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
  }

  if (parsed.verb === "exec") {
    if (parsed.operands.length === 0) {
      return { exitCode: 2, stdout: `depug: exec needs a function id\n\n${USAGE}` };
    }
    if (parsed.line === undefined || !Number.isFinite(parsed.line)) {
      return { exitCode: 2, stdout: `depug: exec needs --line\n\n${USAGE}` };
    }
    if (parsed.statement === undefined || parsed.statement === "") {
      return { exitCode: 2, stdout: `depug: exec needs --statement\n\n${USAGE}` };
    }
    const result = runExec({
      fid: parsed.operands[0],
      atLine: parsed.line,
      visit: parsed.visit ?? 1,
      expression: parsed.statement,
      command: [...parsed.command],
      cwd,
    });
    return { exitCode: result.error ? 2 : 0, stdout: `${formatExec(result)}\n` };
  }

  return { exitCode: 2, stdout: `depug: unknown verb: ${parsed.verb}\n\n${USAGE}` };
}

/** A short list of values, with a count of the ones past the cap. */
function formatSamples(samples: readonly string[], omitted: number): string {
  if (samples.length === 0) return "(none)";
  const shown = samples.join(", ");
  return omitted > 0 ? `${shown}, … (${omitted} more)` : shown;
}

/**
 * Names the calls whose function holds one line, innermost first.
 *
 * A reader starts from a line and a verb wants a function id, and doing
 * that conversion by eye costs a whole re-run when it goes wrong. Only
 * calls the index actually recorded are listed: a function that holds the
 * line but never ran is not something to trace.
 */
function describeAt(at: string, cwd: string, records: readonly { type: string; fid: string }[]): string[] {
  const separator = at.lastIndexOf(":");
  const path = at.slice(0, separator);
  const line = Number(at.slice(separator + 1));
  if (separator === -1 || !Number.isFinite(line)) {
    return [`depug note: --at wants <file>:<line>, and got ${at}`];
  }

  let source: string;
  try {
    source = readFileSync(resolve(cwd, path), "utf8");
  } catch {
    return [`depug note: --at names a file depug could not read: ${path}`];
  }

  const holders = functionsContaining(source, path, line);
  if (holders.length === 0) return [`depug note: no function in ${path} holds line ${line}`];

  const ran = new Map<string, string[]>();
  for (const record of records) {
    if (record.type !== "call") continue;
    const withoutCall = record.fid.slice(0, record.fid.lastIndexOf("#"));
    const list = ran.get(withoutCall) ?? [];
    list.push(record.fid);
    ran.set(withoutCall, list);
  }

  const lines = [`depug at ${path}:${line}, innermost first:`];
  for (const holder of holders) {
    const calls = ran.get(holder.id);
    lines.push(
      calls
        ? `  ${calls.join(", ")}`
        : `  ${holder.id}  (holds the line, but no call was recorded)`,
    );
  }
  return lines;
}

function describeExit(status: number | null): string {
  if (status === 0) return "pass (exit 0)";
  if (status === null) return "no exit status (the child was killed or timed out)";
  return `fail (exit ${status})`;
}
