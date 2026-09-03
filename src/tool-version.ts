// The version depug stamps on every evidence file.
//
// The number is read from the package manifest rather than written here,
// because one version in two places drifts.
//
// Finding that manifest means walking up rather than counting directories.
// The build moves every module one level deeper -- `src/reporter.ts`
// becomes `dist/src/reporter.js` -- so a relative path with the right
// number of `..` in the source tree has one too few in the package that
// ships. That failure is silent: the manifest is simply not there, the
// read throws, and the caller reports a version nobody released. Measured
// on 0.1.1 before release, every evidence file written by an installed
// copy carried `0.0.0` while the same code in a checkout carried the real
// version, which is why no test caught it.
//
// This module does not decide what to do when the manifest is missing for
// a real reason. It reports `UNKNOWN`, and the evidence carries that
// rather than a number that would be a guess.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** What the version is when no manifest was found above the caller. */
export const UNKNOWN = "0.0.0";

/**
 * The version in the nearest `package.json` at or above `from`.
 *
 * The limit stops a walk that would otherwise reach the filesystem root
 * on a machine where depug lives somewhere unexpected. Eight levels
 * covers both layouts with room to spare: the deepest module ships at
 * `dist/src/verbs/probe.js`, three below the manifest.
 */
export function toolVersion(from: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(from));

  for (let level = 0; level < 8; level++) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const version = (manifest as { version?: unknown }).version;
      if (typeof version === "string") return version;
    } catch {
      // No manifest here, or one that cannot be read. Keep walking: a
      // build directory holds no manifest and is not an error.
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return UNKNOWN;
}
