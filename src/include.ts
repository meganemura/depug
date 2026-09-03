// Where the application boundary comes from, and what sits inside it.
//
// A verb instruments the files under one or more path prefixes and calls
// everything else "not the application". The prefix decides what a frames
// index holds, so a wrong one produces an index of nothing, and an index
// of nothing reads the same as a test that called nothing. Two projects
// hit that on their first day: one keeps its code in `cli/` rather than
// `src/`, and one wrote the function it wanted to watch inside the test
// file, which no prefix reaches because test files are never
// instrumented.
//
// The default therefore lives in the one file every project already has,
// `package.json`, under a `depug.include` field, and the flag on the
// command line overrides it. This module also counts what a prefix holds,
// so that "0 calls" can say whether depug was watching anything at all.
//
// It does not decide what counts as a test file; the predicate here
// mirrors the one the plugin and the node:test hook apply, and a change
// to one must reach the others.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type IncludeSource = "flag" | "package.json" | "default";

export interface IncludeResolution {
  /** Absolute paths. Files under any of them are instrumented. */
  prefixes: string[];
  source: IncludeSource;
}

/**
 * The prefixes a run instruments, absolute, and where they came from.
 *
 * Precedence: the flag, then `package.json`, then `src`. The flag wins
 * because it is what a reader types to correct the other two.
 */
export function resolveIncludes(cwd: string, flags: readonly string[]): IncludeResolution {
  if (flags.length > 0) {
    return { prefixes: flags.map((p) => resolve(cwd, p)), source: "flag" };
  }
  const declared = readPackageInclude(cwd);
  if (declared.length > 0) {
    return { prefixes: declared.map((p) => resolve(cwd, p)), source: "package.json" };
  }
  return { prefixes: [resolve(cwd, "src")], source: "default" };
}

/**
 * The `depug.include` field of `<cwd>/package.json`: a path or a list of
 * paths, relative to that file. Anything else, including a missing or
 * unreadable manifest, is an empty list rather than an error, because a
 * project without the field is the common case and not a broken one.
 */
export function readPackageInclude(cwd: string): string[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  } catch {
    return [];
  }
  const field = (manifest as { depug?: { include?: unknown } })?.depug?.include;
  if (typeof field === "string") return field === "" ? [] : [field];
  if (Array.isArray(field)) return field.filter((p): p is string => typeof p === "string" && p !== "");
  return [];
}

/** Whether `path` sits under any of the prefixes. Both sides absolute. */
export function isUnderAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep));
}

/**
 * How many files under `prefix` depug would instrument if the run loaded
 * them: TypeScript, not a test file, not under `node_modules`.
 *
 * A count of candidates, not of files the run reached. It separates "the
 * prefix holds nothing" from "the prefix holds code this test never
 * imported", which is the distinction a reader of `calls: 0` needs.
 */
export function countCandidates(prefix: string): number {
  if (!existsSync(prefix)) return 0;
  let count = 0;
  const pending = [prefix];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === "node_modules") continue;
      const path = join(dir, name);
      let isDirectory: boolean;
      try {
        isDirectory = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) pending.push(path);
      else if (isCandidateFile(path)) count++;
    }
  }
  return count;
}

/** The same shape the plugin and the node:test hook accept. */
export function isCandidateFile(path: string): boolean {
  return /\.tsx?$/.test(path) && !/\.(test|spec)\.tsx?$/.test(path);
}

/**
 * The test file a rerun command names, absolute, or undefined where none
 * of its arguments is a TypeScript file that exists under `cwd`.
 */
export function testFileIn(command: readonly string[], cwd: string): string | undefined {
  for (const arg of command) {
    if (!/\.tsx?$/.test(arg)) continue;
    const path = isAbsolute(arg) ? arg : resolve(cwd, arg);
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      // Not a file; the next argument may be.
    }
  }
  return undefined;
}

/** A prefix as a reader would type it: relative to `cwd`, `.` for `cwd` itself. */
export function displayPrefix(prefix: string, cwd: string): string {
  const rel = relative(cwd, prefix);
  return rel === "" ? "." : rel;
}
