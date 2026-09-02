// Runs the transform against a real-world TypeScript corpus, not just
// hand-written fixtures. Fixtures cover the shapes an author remembers to
// think of; a large corpus finds the shapes nobody thought to write down.
// Running the transform over this corpus is how the empty-body offset
// collision transform.ts now handles came to light: every hand-written
// fixture passed while six real files produced unparseable output.
//
// See test/support/corpus.ts for where the corpus comes from and how to
// point this at one.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { instrumentSource } from "../src/transform.ts";
import { EXPECTED_FILE_COUNT, corpusAvailable, loadCorpus } from "./support/corpus.ts";

// A TypeScript SourceFile carries its parser's diagnostics on this field.
// It is not part of the public d.ts, so this type only asserts the one
// property this file reads from it.
type SourceFileWithParseDiagnostics = ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };

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
  it("preserves line count and introduces no new syntax errors across every corpus file", () => {
    const files = loadCorpus();
    // Asserted so a broken path filter that matches nothing fails loudly
    // instead of letting the loop below pass on an empty list.
    expect(files).toHaveLength(EXPECTED_FILE_COUNT);

    const lineCountMismatches: string[] = [];
    const newSyntaxErrors: string[] = [];

    for (const { path, source } of files) {
      const { code } = instrumentSource(source, path);
      if (code.split("\n").length !== source.split("\n").length) lineCountMismatches.push(path);

      const before = countParseDiagnostics(path, source);
      const after = countParseDiagnostics(path, code);
      if (after > before) newSyntaxErrors.push(`${path} (${before} -> ${after})`);
    }

    expect(lineCountMismatches, "files with a changed line count").toEqual([]);
    expect(newSyntaxErrors, "files with new syntax errors").toEqual([]);
  }, 120_000);
});
