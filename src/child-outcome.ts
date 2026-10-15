// How the command a verb ran ended, in the words every verb prints.
//
// A command that never started has no outcome at all. spawnSync reports
// it as a null status, the same as a child it killed on timeout, so the
// two read alike unless the start failure is told apart first.
import type { SpawnSyncReturns } from "node:child_process";

/**
 * Why the command never started, as `could not start <program>: <code>`,
 * or undefined when it ran. A timeout and a full output buffer also set
 * `error`, but on a child that had a pid.
 */
export function startFailure(child: SpawnSyncReturns<string>, program: string): string | undefined {
  if (!child.error || child.pid !== 0) return undefined;
  const code = (child.error as NodeJS.ErrnoException).code ?? child.error.message;
  return `could not start ${program}: ${code}`;
}

export function describeExit(status: number | null): string {
  if (status === 0) return "pass (exit 0)";
  if (status === null) return "no exit status (the child was killed or timed out)";
  return `fail (exit ${status})`;
}
