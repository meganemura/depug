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
// transform's own corpus test: it samples where that one is exhaustive.
//
// See test/support/corpus.ts for where the corpus comes from and how to
// point this at one.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { instrumentTarget, listInstrumentableFunctions } from "../src/flt-transform.ts";
import { EXPECTED_FILE_COUNT, corpusAvailable, loadCorpus } from "./support/corpus.ts";

type SourceFileWithParseDiagnostics = ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };


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
      const files = loadCorpus();
      expect(files).toHaveLength(EXPECTED_FILE_COUNT);

      const lineCountMismatches: string[] = [];
      const newSyntaxErrors: string[] = [];
      const notFound: string[] = [];
      let sampledFunctions = 0;

      for (const { path, source: original } of files) {
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
