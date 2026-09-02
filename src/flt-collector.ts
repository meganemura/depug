// Writes what one worker's flt runtime observed to a file the parent
// process can read, and reads those files back.
//
// The split mirrors collector.ts's own reasoning for `frames`: the runtime
// lives inside a worker process's globals, a verb runs in the parent, and
// a file is the only way across that boundary. `flt` gets its own file
// name (`flt-<pid>.jsonl`, not `frames-<pid>.jsonl`) so the two verbs'
// directories never collide when DEPUG_OUTPUT_DIR points them at the same
// parent, and its own reader, because its record shape (FltRecord, not
// FrameRecord) is different.
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FltRecord, FltRuntime } from "./flt-runtime.ts";

/** The file this worker writes into `dir`. */
export function fltWorkerFilePath(dir: string, pid: number = process.pid): string {
  return join(dir, `flt-${pid}.jsonl`);
}

export interface FltWorkerFile {
  path: string;
  records: FltRecord[];
  observedCalls: number;
}

/**
 * Writes this worker's records, called once at the end of the run. A
 * worker whose target function never ran here at all writes nothing: the
 * runtime's own `dump()` already turned "ran, but never reached #k" into a
 * `target_summary` record, so an empty `records` array here means the
 * target module was never even reached by this worker.
 */
export function flushFltWorker(dir: string, runtime: FltRuntime): string {
  mkdirSync(dir, { recursive: true });
  const path = fltWorkerFilePath(dir);
  const { records } = runtime.dump();
  const lines = records.map((record) => JSON.stringify(record));
  appendFileSync(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  return path;
}

export function readFltWorkerFiles(dir: string): FltWorkerFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith("flt-") && name.endsWith(".jsonl"))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const records = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as FltRecord);
      const summary = records.find((r): r is Extract<FltRecord, { type: "target_summary" }> => r.type === "target_summary");
      return { path, records, observedCalls: summary?.observed_calls ?? 0 };
    });
}
