// Turns a runner's parsed stack into the frames the evidence file holds.
//
// vitest hands a reporter an already-parsed, already-source-mapped stack:
// each entry names a file, a line, a column, and a method, in TypeScript
// coordinates. depug adds the one judgement a reader needs first, which is
// whether a frame belongs to the project's own code.
//
// That judgement decides whether a snapshot can answer at all. Where no
// application frame outside the test file remains, the function that
// produced the wrong value had already returned before the error was
// built, so its values are not in the stack and no deeper capture would
// find them. Measured across 155 real failures from one project, that is
// the shape 94.2% of the time.
import { relative, sep } from "node:path";

export interface RunnerStackEntry {
  method?: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface EvidenceFrame {
  index: number;
  path: string | null;
  line: number | null;
  column: number | null;
  name: string | null;
  app: boolean;
}

function isInside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
}

/** True for a file inside the project and outside its dependencies. */
export function isAppFile(root: string, file: string | undefined): boolean {
  if (!file) return false;
  if (file.includes(`${sep}node_modules${sep}`)) return false;
  return isInside(root, file);
}

/**
 * Projects a runner stack into evidence frames. Paths come out relative to
 * `root` so an evidence file stays readable when the checkout moves.
 */
export function toEvidenceFrames(
  stack: readonly RunnerStackEntry[] | undefined,
  root: string,
  limit: number,
): EvidenceFrame[] {
  if (!stack) return [];
  return stack.slice(0, limit).map((entry, index) => ({
    index,
    path: entry.file ? relative(root, entry.file) : null,
    line: entry.line ?? null,
    column: entry.column ?? null,
    // An anonymous frame reports an empty method, which reads better as an
    // absence than as an empty string a caller has to test for.
    name: entry.method ? entry.method : null,
    app: isAppFile(root, entry.file),
  }));
}

/**
 * True where the stack still holds a frame from the project's own code,
 * outside the failing test file itself. This is the question that decides
 * which of the two lines the failure output prints.
 */
export function hasProducerFrame(frames: readonly EvidenceFrame[], testFile: string | null): boolean {
  return frames.some((frame) => frame.app && frame.path !== null && frame.path !== testFile);
}
