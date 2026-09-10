// Runs one rerun command under a clock, so a test that never returns
// does not outlive the agent that started it.
//
// The failure output prints a command and an agent runs it. A test that
// spins takes a core with it, and nothing in either runner stops that:
// `--test-timeout` cannot fire, because the timer it needs lives on the
// worker's event loop and the worker is the thing that is blocked
// (measured on Node v26.7.0: 40 s past a 2 s timeout, worker at 100 %).
// One machine carried three such runs for 8 to 12 days at a load average
// of 4-5, all of them started by a command of this shape.
//
// What does work is SIGTERM to the runner: the runner's own loop is free
// -- it sits at 0 % while its worker spins -- so it handles the signal
// and takes its workers down with it. SIGKILL does not, which is how a
// worker ends up orphaned at PPID 1 and still spinning. So this verb
// signals rather than kills, and only escalates when the signal is
// ignored.
//
// It does not put the child in its own process group. Sharing the
// group is what lets a terminal or a session tearing down take the whole
// run with it, which is the other half of the problem and the half a
// timer cannot reach.
import { spawn } from "node:child_process";

/** The exit status of a run this verb stopped, following `timeout(1)`. */
export const TIMED_OUT = 124;

/** How long a stopped child gets to leave before it is killed outright. */
export const GRACE_MS = 5_000;

export interface RunRerunInput {
  /** The command to run, already split. */
  command: string[];
  cwd: string;
  /** Default 120 s, the same budget the re-execution verbs give a run. */
  timeoutMs?: number;
  /** Signals that mean the caller is going away. */
  forward?: readonly NodeJS.Signals[];
}

export interface RerunResult {
  /** The child's exit status, or `TIMED_OUT` where the clock stopped it. */
  exitCode: number;
  timedOut: boolean;
  /** True where the child ignored the signal and had to be killed. */
  killed: boolean;
}

const DEFAULT_FORWARD: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Runs the command, and stops it if it does not finish in time.
 *
 * The child inherits stdio: this verb wraps a command a reader chose to
 * run and should not stand between them and its output.
 */
export function runRerun(input: RunRerunInput): Promise<RerunResult> {
  const timeoutMs = input.timeoutMs ?? 120_000;
  const [bin, ...args] = input.command;

  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: input.cwd, stdio: "inherit" });

    let timedOut = false;
    let killed = false;
    let settled = false;

    const stop = (reason: string) => {
      if (settled) return;
      process.stderr.write(`\ndepug rerun: ${reason}\n`);
      child.kill("SIGTERM");
      // A runner that handles SIGTERM takes its workers with it. One that
      // does not leaves them orphaned, so the escalation is not optional.
      const hard = setTimeout(() => {
        if (settled) return;
        killed = true;
        process.stderr.write(`depug rerun: it did not stop; killing it\n`);
        child.kill("SIGKILL");
      }, GRACE_MS);
      hard.unref();
    };

    const clock = setTimeout(() => {
      timedOut = true;
      stop(`no result after ${Math.round(timeoutMs / 1000)} s; stopping the run`);
    }, timeoutMs);

    const forwarded = new Map<NodeJS.Signals, () => void>();
    for (const signal of input.forward ?? DEFAULT_FORWARD) {
      const handler = () => stop(`received ${signal}; stopping the run`);
      forwarded.set(signal, handler);
      process.on(signal, handler);
    }

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(clock);
      for (const [signal, handler] of forwarded) process.off(signal, handler);
      resolve({ exitCode, timedOut, killed });
    };

    child.on("error", (error) => {
      process.stderr.write(`depug rerun: could not run the command: ${error.message}\n`);
      finish(127);
    });
    child.on("exit", (code, signal) => {
      if (timedOut) return finish(TIMED_OUT);
      // A child that a signal ended has no exit code of its own. 128 plus
      // the signal number is what a shell reports, and 1 is the honest
      // fallback where the number is not known here.
      if (code === null) return finish(signal ? 143 : 1);
      finish(code);
    });
  });
}

/**
 * The command a reader should actually run, given the plain one.
 *
 * Kept beside the supervisor because the two have to agree: the prefix
 * this writes is the prefix the re-execution verbs strip back off.
 */
export const RERUN_PREFIX = ["npx", "depug", "rerun", "--"] as const;

/** Wraps a plain command in the guarded form. */
export function guardedCommand(command: string): string {
  return `${RERUN_PREFIX.join(" ")} ${command}`;
}

/**
 * Removes a guard prefix from a command, if one is there.
 *
 * A verb supplies its own clock, so a rerun line pasted after one would
 * otherwise run two supervisors deep for no gain. This lets the printed
 * line serve both uses unchanged: run it, or paste it after a verb.
 */
export function withoutGuard(command: readonly string[]): string[] {
  const rest = [...command];
  if (rest[0] === "npx") rest.shift();
  if (rest[0] !== "depug" && !rest[0]?.endsWith("/depug")) return [...command];
  if (rest[1] !== "rerun") return [...command];
  rest.splice(0, 2);
  // `--` is optional here: the caller may have dropped it while editing.
  if (rest[0] === "--") rest.shift();
  return rest.length > 0 ? rest : [...command];
}
