// Materializes the real-world corpus once for the whole test process.
//
// Each corpus test used to read every file with its own `git show`, which
// is one subprocess per file. At 188 files and two such tests, that
// dominated the run and eventually pushed it past its timeout. One
// `git archive` extracts the whole tree in a single call, and the files
// are then ordinary reads.
//
// The clone is not fetched here, so a caller checks `corpusAvailable()`
// and skips when nobody asked for it. When somebody did ask -- the
// variable is set -- an unusable clone raises instead of skipping. A
// skip reads as a pass, and the difference is easy to miss: a clone under
// `/tmp` disappeared on this machine and two runs were reported as
// "green with the corpus" before the skipped count gave it away.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/**
 * Point this at a clone of honojs/hono to run the corpus checks.
 *
 * Put it somewhere that survives a reboot. `tmp/corpus/hono` under this
 * repository is ignored by git and is the path the maintenance notes use.
 */
export const CLONE_DIR = process.env.DEPUG_CORPUS_DIR ?? "";
export const COMMIT_SHA = "e2740d5a1bd0b4254e517e3af8b60789284bc7bd";

/** 289 `.ts` files under `src/` at COMMIT_SHA, minus 101 tests. */
export const EXPECTED_FILE_COUNT = 188;

export interface CorpusFile {
  path: string;
  source: string;
}

/**
 * Whether the corpus checks can run, raising where they were asked for
 * and cannot.
 *
 * An empty variable means nobody asked, and the checks skip. A variable
 * pointing at something unusable means somebody asked and will otherwise
 * read the skip as a pass, so it says what is wrong with the path they
 * gave.
 */
let announced = false;

export function corpusAvailable(dir: string = CLONE_DIR): boolean {
  if (dir === "") {
    // A bare "2 skipped" does not say which two, or what would run them.
    // Borrowed from a sibling project, whose browser tests name the thing
    // they could not find rather than skipping without a word.
    if (!announced) {
      announced = true;
      // Written to the stream rather than through `console`, which the
      // runner intercepts during collection and never prints -- where
      // this decision is made.
      // One line, because the runner gives each test file its own worker
      // and the flag above is per-worker: this prints once per corpus
      // file, not once per run.
      process.stderr.write(
        "corpus tests skipped: DEPUG_CORPUS_DIR is unset (docs/maintenance.md)\n",
      );
    }
    return false;
  }

  const reason = corpusProblem(dir);
  if (reason !== undefined) {
    throw new Error(
      `DEPUG_CORPUS_DIR points at ${dir}, and ${reason}.\n` +
        "The corpus checks were asked for and cannot run. Clone it with\n" +
        `  git clone --filter=blob:none https://github.com/honojs/hono.git ${dir}\n` +
        "or unset DEPUG_CORPUS_DIR to skip them.",
    );
  }
  return true;
}

/** What is wrong with a corpus path, or undefined where nothing is. */
export function corpusProblem(dir: string): string | undefined {
  if (!existsSync(dir)) return "there is nothing there";
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--git-dir"], { stdio: "ignore" });
  } catch {
    // The usual cause is a clone under /tmp that the system cleared,
    // leaving the directory but not the repository.
    return "it is not a git repository";
  }
  try {
    execFileSync("git", ["-C", dir, "cat-file", "-e", COMMIT_SHA], { stdio: "ignore" });
  } catch {
    // A clone can exist without this commit, after a shallow re-clone or
    // a prune; either way there is nothing to read it from.
    return `it does not hold commit ${COMMIT_SHA.slice(0, 12)}`;
  }
  return undefined;
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
