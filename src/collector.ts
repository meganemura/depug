// Writes what a worker observed to a file the parent process can read.
//
// A verb runs in the parent, and the events happen in a worker: the
// runtime lives in the worker's own globals, and a reporter, which runs in
// the parent, cannot see it. The file is the only way across that
// boundary, which is also why the file format is the contract rather than
// an internal detail.
//
// Each worker writes its own file, named with its process id, because the
// default pool runs several. A verb reads whichever files appeared.
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFid } from "./fid.ts";
import type { DepugEvent, DepugRuntime } from "./runtime.ts";

export interface FrameRecord {
  type: "call" | "return" | "suspend" | "resume";
  fid: string;
  parent?: string | null;
  path: string;
  line: number;
  column: number;
  app: boolean;
  test: string | null;
  exit_kind?: "return" | "throw";
}

const TYPE_OF_KIND = {
  enter: "call",
  exit: "return",
  suspend: "suspend",
  resume: "resume",
} as const;

/**
 * Projects one runtime event into the record the index holds.
 *
 * `app` is decided by the transform, not here: a module reaches the
 * runtime only when the plugin chose to instrument it, and the plugin's
 * own include predicate is what draws the application boundary. Every
 * recorded event therefore comes from application code.
 */
export function toFrameRecord(event: DepugEvent): FrameRecord | undefined {
  const parsed = parseFid(event.fn);
  if (!parsed) return undefined;
  const record: FrameRecord = {
    type: TYPE_OF_KIND[event.kind],
    fid: event.fn,
    path: parsed.path,
    line: event.line,
    column: event.column,
    app: true,
    test: event.test,
  };
  if (event.kind === "enter") record.parent = event.parent ?? null;
  if (event.kind === "exit" && event.exitKind) record.exit_kind = event.exitKind;
  return record;
}

export function eventsToJsonl(events: readonly DepugEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    const record = toFrameRecord(event);
    if (record) lines.push(JSON.stringify(record));
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** The file this worker writes into `dir`. */
export function workerFilePath(dir: string, pid: number = process.pid): string {
  return join(dir, `frames-${pid}.jsonl`);
}

/**
 * Writes this worker's events. Called once, when the worker finishes: the
 * verb reads the file only after the child process exits, so there is
 * nothing to gain from writing a line at a time and a per-write syscall to
 * lose.
 */
export function flushWorker(dir: string, runtime: DepugRuntime): string {
  mkdirSync(dir, { recursive: true });
  const path = workerFilePath(dir);
  appendFileSync(path, eventsToJsonl(runtime.dump()));
  return path;
}

export function readWorkerFiles(dir: string): { path: string; records: FrameRecord[] }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith("frames-") && name.endsWith(".jsonl"))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const records = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as FrameRecord);
      return { path, records };
    });
}
