// Runs the flt transform against a real-world TypeScript corpus, the same
// one test/corpus-regression.test.ts checks the always-on transform
// against, and for the same reason: a hand-written fixture only covers
// the shapes its author thought of. This test additionally has to pick
// which function each file to instrument as -- the always-on transform
// rewrites every function in one pass, but flt targets exactly one -- so
// it uses listInstrumentableFunctions to find every candidate and
// instruments each one in turn.
//
// Instrumenting once per function, per file, costs far more than the
// always-on transform's single pass over the same file, so this samples
// up to 3 functions per file (first, middle, last) rather than every one
// of the corpus's ~1159. That is a narrower check than the always-on
// transform's own corpus test; see flt.md for what it does and does not
// cover, and for whether it was actually run in this environment (no
// DEPUG_CORPUS_DIR clone was available here, so it was not).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { instrumentTarget, listInstrumentableFunctions } from "../src/flt-transform.ts";

type SourceFileWithParseDiagnostics = ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };

const CLONE_DIR = process.env.DEPUG_CORPUS_DIR ?? "";
const COMMIT_SHA = "e2740d5a1bd0b4254e517e3af8b60789284bc7bd";
const EXCLUDED_SUFFIXES = [".test.ts", ".spec.ts"];
const EXPECTED_FILE_COUNT = 188;

function corpusAvailable(): boolean {
  if (CLONE_DIR === "" || !existsSync(CLONE_DIR)) return false;
  try {
    execFileSync("git", ["-C", CLONE_DIR, "cat-file", "-e", COMMIT_SHA], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function listCorpusFiles(): string[] {
  const out = execFileSync("git", ["-C", CLONE_DIR, "ls-tree", "-r", "--name-only", COMMIT_SHA, "--", "src"], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter((path) => path.endsWith(".ts"))
    .filter((path) => !EXCLUDED_SUFFIXES.some((suffix) => path.endsWith(suffix)));
}

function readCorpusFile(path: string): string {
  return execFileSync("git", ["-C", CLONE_DIR, "show", `${COMMIT_SHA}:${path}`], { encoding: "utf8" });
}

function countParseDiagnostics(fileName: string, source: string): number {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true) as SourceFileWithParseDiagnostics;
  return sourceFile.parseDiagnostics?.length ?? 0;
}

/** First, middle, and last, de-duplicated -- a spread across the file rather than a run of similarly-shaped neighbors. */
function sample<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const indices = new Set<number>([0, items.length - 1, Math.floor(items.length / 2)]);
  return [...indices].sort((a, b) => a - b).map((i) => items[i]);
}

describe.skipIf(!corpusAvailable())("flt transform against a real-world TypeScript corpus", () => {
  it(
    "preserves line count and introduces no new syntax errors for a sample of each file's functions",
    () => {
      const paths = listCorpusFiles();
      expect(paths.length).toBe(EXPECTED_FILE_COUNT);

      const lineCountMismatches: string[] = [];
      const newSyntaxErrors: string[] = [];
      const notFound: string[] = [];
      let sampledFunctions = 0;

      for (const path of paths) {
        const original = readCorpusFile(path);
        const targets = sample(listInstrumentableFunctions(original, path), 3);
        const before = countParseDiagnostics(path, original);

        for (const target of targets) {
          sampledFunctions += 1;
          const { code, found } = instrumentTarget(original, path, target);
          if (!found) {
            notFound.push(`${path}:${target.name}@${target.line}:${target.column}`);
            continue;
          }
          if (code.split("\n").length !== original.split("\n").length) {
            lineCountMismatches.push(`${path}:${target.name}@${target.line}:${target.column}`);
          }
          const after = countParseDiagnostics(path, code);
          if (after > before) {
            newSyntaxErrors.push(`${path}:${target.name}@${target.line}:${target.column} (${before} -> ${after})`);
          }
        }
      }

      expect(sampledFunctions).toBeGreaterThan(0);
      expect(notFound, "targets listInstrumentableFunctions found but instrumentTarget could not match").toEqual([]);
      expect(lineCountMismatches, "targets with a changed line count").toEqual([]);
      expect(newSyntaxErrors, "targets with new syntax errors").toEqual([]);
    },
    180_000,
  );
});
