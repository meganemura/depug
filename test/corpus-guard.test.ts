// Checks that asking for the corpus and not getting it is an error.
//
// The corpus checks skip when nobody asked, which is right: the clone is
// not fetched by the suite. But a skip reads as a pass, and a clone that
// has gone missing looks exactly like one that was never wanted. That
// happened here -- a clone under /tmp was cleared by the system, and two
// runs were reported as green with the corpus before the skipped count
// gave it away.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMIT_SHA, corpusAvailable, corpusProblem } from "./support/corpus.ts";

describe("corpusProblem", () => {
  it("names a path that holds nothing", () => {
    expect(corpusProblem(join(tmpdir(), "depug-corpus-absent-nothing-here"))).toBe(
      "there is nothing there",
    );
  });

  it("names a directory that is not a repository", () => {
    // The shape a cleared /tmp leaves behind: the directory is recreated
    // by something else, or survives while its contents do not.
    const dir = mkdtempSync(join(tmpdir(), "depug-corpus-bare-"));
    try {
      expect(corpusProblem(dir)).toBe("it is not a git repository");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names a repository that does not hold the pinned commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "depug-corpus-empty-repo-"));
    try {
      execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
      expect(corpusProblem(dir)).toBe(`it does not hold commit ${COMMIT_SHA.slice(0, 12)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("corpusAvailable", () => {
  it("skips when nobody asked, and says which variable would run it", () => {
    // A bare "2 skipped" in the summary names neither the tests nor the
    // way to run them, and a reader who wanted the corpus reads it as a
    // pass. The warning is the only thing standing between those.
    const said: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    // The stream, not `console`: a `console.warn` from where this runs
    // printed nothing in the real suite, though the same call elsewhere
    // during collection does print.
    process.stderr.write = ((chunk: string | Uint8Array) => {
      said.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(corpusAvailable("")).toBe(false);
    } finally {
      process.stderr.write = write;
    }
    expect(said.join("")).toContain("DEPUG_CORPUS_DIR");
  });

  it("raises when the corpus was asked for and cannot be read", () => {
    const dir = mkdtempSync(join(tmpdir(), "depug-corpus-bare-"));
    try {
      // The message has to carry the path and the reason: the reader is
      // someone who believes the corpus checks just ran.
      expect(() => corpusAvailable(dir)).toThrowError(/not a git repository/);
      expect(() => corpusAvailable(dir)).toThrowError(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
