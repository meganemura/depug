// Materializes the real-world corpus once for the whole test process.
//
// Each corpus test used to read every file with its own `git show`, which
// is one subprocess per file. At 188 files and two such tests, that
// dominated the run and eventually pushed it past its timeout. One
// `git archive` extracts the whole tree in a single call, and the files
// are then ordinary reads.
//
// The clone lives outside this repository and is not fetched here, so a
// caller checks `corpusAvailable()` and skips rather than fails.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/** Point this at a clone of honojs/hono to run the corpus checks. */
export const CLONE_DIR = process.env.DEPUG_CORPUS_DIR ?? "";
export const COMMIT_SHA = "e2740d5a1bd0b4254e517e3af8b60789284bc7bd";

/** 289 `.ts` files under `src/` at COMMIT_SHA, minus 101 tests. */
export const EXPECTED_FILE_COUNT = 188;

export interface CorpusFile {
  path: string;
  source: string;
}

export function corpusAvailable(): boolean {
  if (CLONE_DIR === "" || !existsSync(CLONE_DIR)) return false;
  try {
    execFileSync("git", ["-C", CLONE_DIR, "cat-file", "-e", COMMIT_SHA], { stdio: "ignore" });
    return true;
  } catch {
    // A clone can exist without this commit, after a shallow re-clone or a
    // prune; either way there is nothing to read it from.
    return false;
  }
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
}

let cached: CorpusFile[] | undefined;

/**
 * Every non-test TypeScript file under `src/` at the pinned commit.
 *
 * The result is cached for the process: both corpus tests want the same
 * bytes, and extracting them twice would put back the cost this module
 * exists to remove.
 */
export function loadCorpus(): CorpusFile[] {
  if (cached) return cached;

  const dir = mkdtempSync(join(tmpdir(), "depug-corpus-"));
  const archive = execFileSync("git", ["-C", CLONE_DIR, "archive", COMMIT_SHA, "src"], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", dir], { input: archive, maxBuffer: 256 * 1024 * 1024 });

  const files: string[] = [];
  walk(join(dir, "src"), files);

  cached = files
    .map((full) => relative(dir, full))
    .filter((path) => path.endsWith(".ts"))
    .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".spec.ts"))
    .sort()
    .map((path) => ({ path, source: readFileSync(join(dir, path), "utf8") }));
  return cached;
}
