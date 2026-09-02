// The commit and working-tree state a run happened under.
//
// Every artifact carries this so a later verb can refuse an index that was
// built from code the working tree no longer holds. Without it, an agent
// follows a line number into a file that has since been edited and reads
// the wrong statement, with nothing to signal the mismatch.
//
// Both commands are read once for a process and cached: `git rev-parse`
// and `git status --porcelain` each cost on the order of ten milliseconds,
// which is worth paying once and not once for each failed test.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export interface CodeState {
  /** The commit at the start of the run, or null where git cannot answer. */
  git_sha: string | null;
  /** `clean`, or a digest of the porcelain status, or null. */
  dirty_digest: string | null;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    // No git, no repository, or a git that refused: all three mean the
    // same thing to a reader, which is that this run carries no marker.
    return null;
  }
}

const cache = new Map<string, CodeState>();

export function readCodeState(cwd: string): CodeState {
  const cached = cache.get(cwd);
  if (cached) return cached;

  const sha = git(cwd, ["rev-parse", "HEAD"])?.trim() ?? null;
  const porcelain = git(cwd, ["status", "--porcelain"]);
  const dirty =
    porcelain === null
      ? null
      : porcelain.trim() === ""
        ? "clean"
        : createHash("sha256").update(porcelain).digest("hex");

  const state: CodeState = { git_sha: sha, dirty_digest: dirty };
  cache.set(cwd, state);
  return state;
}

/**
 * Compares two markers. A null on either side means one of the two runs
 * could not read its own state, so the answer is `unknown` rather than a
 * match or a mismatch: a verb should warn on it, and refuse only on a
 * genuine `mismatch`.
 */
export function compareCodeState(a: CodeState, b: CodeState): "match" | "mismatch" | "unknown" {
  if (a.git_sha === null || b.git_sha === null) return "unknown";
  if (a.dirty_digest === null || b.dirty_digest === null) return "unknown";
  return a.git_sha === b.git_sha && a.dirty_digest === b.dirty_digest ? "match" : "mismatch";
}
