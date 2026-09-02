// Runs the transform against a real-world TypeScript corpus, not just
// hand-written fixtures. Fixtures cover the shapes an author remembers to
// think of; a large corpus finds the shapes nobody thought to write down.
// Running the transform over this corpus is how the empty-body offset
// collision transform.ts now handles came to light: every hand-written
// fixture passed while six real files produced unparseable output.
//
// The corpus is honojs/hono's `src/**/*.ts` at one pinned commit, excluding
// `*.test.ts` and `*.spec.ts`. The clone lives outside this repository and
// is not fetched here, so the test skips, rather than fails, where it is
// absent. Point DEPUG_CORPUS_DIR at a clone to run it:
//
//   git clone https://github.com/honojs/hono.git /tmp/hono
//   DEPUG_CORPUS_DIR=/tmp/hono npm test
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { instrumentSource } from "../src/transform.ts";

// A TypeScript SourceFile carries its parser's diagnostics on this field.
// It is not part of the public d.ts, so this type only asserts the one
// property this file reads from it.
type SourceFileWithParseDiagnostics = ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };

// Read from the environment rather than written here: the clone's location
// differs per machine, and a path baked into this file would make the test
// dead for everyone but its author.
const CLONE_DIR = process.env.DEPUG_CORPUS_DIR ?? "";
const COMMIT_SHA = "e2740d5a1bd0b4254e517e3af8b60789284bc7bd";

// Excludes only `.test.ts` and `.spec.ts`, matching the corpus description
// above; a `.d.ts` file has no runnable function bodies but is still valid
// input to a text-splice transform, so it stays in scope.
const EXCLUDED_SUFFIXES = [".test.ts", ".spec.ts"];

// 289 `.ts` files under `src/` at COMMIT_SHA, minus 101 `.test.ts` and 0
// `.spec.ts`. Asserted explicitly so a broken path filter that matches 0
// files fails loudly instead of letting the loop below pass on nothing.
const EXPECTED_FILE_COUNT = 188;

function corpusAvailable(): boolean {
  if (CLONE_DIR === "" || !existsSync(CLONE_DIR)) return false;
  try {
    execFileSync("git", ["-C", CLONE_DIR, "cat-file", "-e", COMMIT_SHA], { stdio: "ignore" });
    return true;
  } catch {
    // A clone can exist without this commit, e.g. after a shallow re-clone
    // or a prune; either way there is nothing to read it from.
    return false;
  }
}

function listCorpusFiles(): string[] {
  const out = execFileSync(
    "git",
    ["-C", CLONE_DIR, "ls-tree", "-r", "--name-only", COMMIT_SHA, "--", "src"],
    { encoding: "utf8" },
  );
  return out
    .split("\n")
    .filter((path) => path.endsWith(".ts"))
    .filter((path) => !EXCLUDED_SUFFIXES.some((suffix) => path.endsWith(suffix)));
}

function readCorpusFile(path: string): string {
  return execFileSync("git", ["-C", CLONE_DIR, "show", `${COMMIT_SHA}:${path}`], { encoding: "utf8" });
}

function countParseDiagnostics(fileName: string, source: string): number {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  ) as SourceFileWithParseDiagnostics;
  return sourceFile.parseDiagnostics?.length ?? 0;
}

describe.skipIf(!corpusAvailable())("transform against a real-world TypeScript corpus", () => {
  it(
    "preserves line count and introduces no new syntax errors across every corpus file",
    () => {
      const paths = listCorpusFiles();
      expect(paths.length).toBe(EXPECTED_FILE_COUNT);

      const lineCountMismatches: string[] = [];
      const newSyntaxErrors: string[] = [];

      for (const path of paths) {
        const original = readCorpusFile(path);
        const { code } = instrumentSource(original, path);

        if (code.split("\n").length !== original.split("\n").length) {
          lineCountMismatches.push(path);
        }

        const before = countParseDiagnostics(path, original);
        const after = countParseDiagnostics(path, code);
        if (after > before) {
          newSyntaxErrors.push(`${path} (${before} -> ${after})`);
        }
      }

      expect(lineCountMismatches, "files with a changed line count").toEqual([]);
      expect(newSyntaxErrors, "files with new syntax errors").toEqual([]);
    },
    // 30s was enough before this transform also walked every `await`; on
    // this machine, under background load from an unrelated process, a
    // full run of this one test alone was observed to take up to ~25s
    // (188 files, 792 functions, 242 awaits at the pinned commit), close
    // enough to 30s to flake. 90s keeps headroom without hiding a real
    // hang.
    90_000,
  );
});
