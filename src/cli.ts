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
import { renderDeclared, renderObserved } from "./shape-report.ts";
import { runFrames } from "./verbs/frames.ts";
import { formatPreflight, runPreflight } from "./verbs/preflight.ts";
import { runProbe } from "./verbs/probe.ts";

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

Options:
  --include <path>   Instrument files under this path (default: <cwd>/src)
  --cwd <path>       Run the command here (default: the current directory)

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
    }
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

  return { exitCode: 2, stdout: `depug: unknown verb: ${parsed.verb}\n\n${USAGE}` };
}

function describeExit(status: number | null): string {
  if (status === 0) return "pass (exit 0)";
  if (status === null) return "no exit status (the child was killed or timed out)";
  return `fail (exit ${status})`;
}
