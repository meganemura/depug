// Reads a V8 stack string into the entries the evidence frames are built
// from.
//
// vitest hands a reporter a stack it has already parsed and source-mapped.
// Node's test runner hands over the string, so depug parses it here. That
// turns out to need no source map: Node's type stripping replaces type
// annotations with spaces rather than removing them, so a stack from a
// stripped `.ts` file already carries the line and column the author
// wrote. Measured on Node v26.7.0, an assertion on line 7 of a `.ts` test
// reported line 7.
//
// Frames inside Node itself are dropped. They can never be application
// code, and a reader scanning for the call that produced a value should
// not have to step over the test runner's own internals to find it.
import { fileURLToPath } from "node:url";
import type { RunnerStackEntry } from "./stack.ts";

// `at name (file:line:column)` or `at file:line:column`. The location is
// captured as one piece and split afterwards, because a path can hold a
// colon and only the last two are the position.
const FRAME = /^\s*at\s+(?:(.+?)\s+\((.+)\)|(.+))$/;
const POSITION = /^(.*):(\d+):(\d+)$/;

function toPath(location: string): string | undefined {
  if (location.startsWith("file://")) {
    try {
      return fileURLToPath(location);
    } catch {
      return undefined;
    }
  }
  // A bare `node:internal/...` specifier, or a relative path.
  return location.startsWith("node:") ? undefined : location;
}

/**
 * Parses a stack string. The first line is the error's own message and is
 * skipped; a line that does not look like a frame is skipped too, rather
 * than becoming a frame with no position.
 */
export function parseStack(stack: string | undefined): RunnerStackEntry[] {
  if (!stack) return [];
  const entries: RunnerStackEntry[] = [];

  for (const line of stack.split("\n").slice(1)) {
    const frame = FRAME.exec(line);
    if (!frame) continue;

    const method = frame[1];
    const location = frame[2] ?? frame[3];
    if (!location) continue;

    const position = POSITION.exec(location);
    if (!position) continue;

    const path = toPath(position[1]);
    if (path === undefined) continue;

    entries.push({
      method: method && method !== "<anonymous>" ? method : "",
      file: path,
      line: Number(position[2]),
      column: Number(position[3]),
    });
  }

  return entries;
}
