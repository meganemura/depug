// The object flt-instrumented code calls as `__depug_flt`. It answers one
// question per call to the target function: is this the k-th entry the
// caller asked to trace, and if so, what did each recorded statement see.
//
// A call counter here is never reset between tests, matching runtime.ts's
// own `callCounts` map (see src/runtime.ts): `#k` in a function id is
// documented as counting entries "since the current test began", but the
// always-on runtime counts cumulatively for the whole worker process
// instead. flt counts the same way on purpose, because a `k` read from a
// `frames` index has to land on the same call here that it named there.
import { renderNamed, renderValue, renderedEqual, type FltLimits, type RenderedValue } from "./flt-render.ts";

export type FltExitKind = "return" | "throw";

export interface FltCallRecord {
  type: "call";
  fid: string;
  path: string;
  line: number;
  column: number;
  test: string | null;
  locals: Record<string, RenderedValue>;
}

export interface FltLineRecord {
  type: "line";
  fid: string;
  line: number;
  column: number;
  new: Record<string, RenderedValue>;
  changed: Record<string, { old: RenderedValue; new: RenderedValue }>;
  out_of_scope: string[];
}

export interface FltSkippedIterationsRecord {
  type: "skipped_iterations";
  fid: string;
  count: number;
}

export interface FltReturnRecord {
  type: "return";
  fid: string;
  value: RenderedValue;
}

export interface FltThrowRecord {
  type: "throw";
  fid: string;
  name: string;
  message: RenderedValue;
}

/**
 * Written in place of a `call` record when the requested call never
 * happened in this worker, per docs/evidence-schema.md ("Frame lifetime
 * trace"). `observed_calls` is this worker's own count, so a reader can
 * pick a `#k` that exists even where the schema documents the field only
 * at the envelope level (see flt.md).
 */
export interface FltTargetSummaryRecord {
  type: "target_summary";
  fid: string;
  observed_calls: number;
}

export type FltRecord =
  | FltCallRecord
  | FltLineRecord
  | FltSkippedIterationsRecord
  | FltReturnRecord
  | FltThrowRecord
  | FltTargetSummaryRecord;

// A raw event carries a full, already-rendered snapshot rather than a
// pre-computed diff. Diffing happens once, in `emit`, at the moment a
// record is actually written -- never when it is captured. A loop's
// folded middle discards its raw events outright, and its kept last
// iteration replays them later, against whatever `lastEmitted` was at
// replay time (the end of the kept first iteration, since nothing in
// between was ever written); computing the diff eagerly, at capture time,
// would instead diff each folded iteration against its own immediate
// predecessor, which the reader never sees, and reconstruction from the
// visible records would not match the true history.
type RawEvent =
  | { kind: "line"; line: number; column: number; capture: Map<string, RenderedValue> }
  | { kind: "skipped_iterations"; count: number };

interface LoopFrame {
  iterationIndex: number;
  foldedCount: number;
  sinkMode: "live" | "buffer";
  /** The one buffered iteration not yet known to be the last. Null in "live" mode. */
  pending: RawEvent[] | null;
}

export interface FltCallHandle {
  /** True only for the one call whose index matches what the caller asked to trace. */
  readonly tracing: boolean;
  line(line: number, column: number, capture: Record<string, unknown>): void;
  loopEnter(): void;
  loopIterStart(): void;
  loopExit(): void;
  /** Wraps a `return <expr>` so the value is known before the value leaves the frame. */
  ret<T>(value: T): T;
  /** Called from the function's own finally clause. A no-op once `ret` already settled the call. */
  exit(kind: FltExitKind, error: unknown): void;
}

export interface FltRuntime {
  enter(idPrefix: string, path: string, line: number, column: number, args: Record<string, unknown>): FltCallHandle;
  setCurrentTest(name: string | null): void;
  dump(): { records: FltRecord[]; observedCalls: number };
  reset(): void;
}

/**
 * `targetK` names the one call this run should record in full; every other
 * call to the same function still increments the counter (so a later call
 * can still be the target) but produces no records at all, which keeps the
 * cost of an untargeted call to one comparison.
 */
export function createFltRuntime(targetK: number, limits: FltLimits): FltRuntime {
  let currentTest: string | null = null;
  let callCount = 0;
  let lastIdPrefix: string | null = null;
  const records: FltRecord[] = [];

  function renderCapture(capture: Record<string, unknown>): Map<string, RenderedValue> {
    const map = new Map<string, RenderedValue>();
    for (const [name, value] of Object.entries(capture)) map.set(name, renderNamed(name, value, limits));
    return map;
  }

  function enter(
    idPrefix: string,
    path: string,
    line: number,
    column: number,
    args: Record<string, unknown>,
  ): FltCallHandle {
    callCount += 1;
    lastIdPrefix = idPrefix;
    const fid = `${idPrefix}${callCount}`;
    const tracing = callCount === targetK;

    const loopStack: LoopFrame[] = [];
    let lastEmitted = new Map<string, RenderedValue>();
    let settled = false;

    // The single choke point every recorded event passes through. A loop
    // frame currently folding its middle absorbs the event instead of
    // writing it; walking from the innermost frame outward finds the
    // nearest one still deciding, so a loop nested inside another loop's
    // undecided iteration buffers correctly into that outer iteration too.
    function route(event: RawEvent): void {
      for (let i = loopStack.length - 1; i >= 0; i--) {
        const frame = loopStack[i];
        if (frame.sinkMode === "buffer") {
          frame.pending!.push(event);
          return;
        }
      }
      if (event.kind === "line") {
        const diff = diffLocals(lastEmitted, event.capture);
        records.push({ type: "line", fid, line: event.line, column: event.column, ...diff });
        lastEmitted = event.capture;
      } else {
        records.push({ type: "skipped_iterations", fid, count: event.count });
      }
    }

    // Decides a loop frame's fate once its last iteration is known: fold
    // and drop the buffer's contents were never a decision here (`route`
    // already discarded them the moment a following iteration started),
    // so this only ever replays a kept iteration or does nothing.
    function resolveFrame(frame: LoopFrame): void {
      if (frame.iterationIndex === 0) return; // the loop body never ran
      if (frame.sinkMode === "buffer" && frame.pending) {
        if (frame.foldedCount > 0) route({ kind: "skipped_iterations", count: frame.foldedCount });
        for (const raw of frame.pending) route(raw);
      }
    }

    function flushLoops(): void {
      while (loopStack.length > 0) resolveFrame(loopStack.pop()!);
    }

    if (tracing) {
      const initial = renderCapture(args);
      lastEmitted = initial;
      records.push({ type: "call", fid, path, line, column, test: currentTest, locals: Object.fromEntries(initial) });
    }

    return {
      tracing,
      line(l, c, capture) {
        if (!tracing) return;
        route({ kind: "line", line: l, column: c, capture: renderCapture(capture) });
      },
      loopEnter() {
        if (!tracing) return;
        loopStack.push({ iterationIndex: 0, foldedCount: 0, sinkMode: "live", pending: null });
      },
      loopIterStart() {
        if (!tracing) return;
        const frame = loopStack[loopStack.length - 1];
        frame.iterationIndex += 1;
        if (frame.iterationIndex >= 3) {
          // The previous iteration was itself pending (buffered, not yet
          // decided); this one starting proves the previous was not last.
          frame.foldedCount += 1;
          frame.pending = null;
        }
        if (frame.iterationIndex >= 2) {
          frame.pending = [];
          frame.sinkMode = "buffer";
        } else {
          frame.sinkMode = "live";
        }
      },
      loopExit() {
        if (!tracing) return;
        resolveFrame(loopStack.pop()!);
      },
      ret(value) {
        if (!tracing) return value;
        // A `return` inside a loop leaves before that loop's own loopExit
        // marker runs, so whatever iteration was still pending there has
        // to be settled here, as "the last one after all", before the
        // return record is written.
        flushLoops();
        settled = true;
        records.push({ type: "return", fid, value: renderValue(value, limits) });
        return value;
      },
      exit(kind, error) {
        if (!tracing || settled) return;
        flushLoops();
        settled = true;
        if (kind === "throw") {
          const name = error instanceof Error ? error.name : "Error";
          const message = error instanceof Error ? error.message : String(error);
          records.push({ type: "throw", fid, name, message: renderValue(message, limits) });
        } else {
          // Falling off the end with no `return` statement returns
          // undefined; `ret` never ran, so this is the only place that
          // reports it.
          records.push({ type: "return", fid, value: renderValue(undefined, limits) });
        }
      },
    };
  }

  return {
    enter,
    setCurrentTest(name) {
      currentTest = name;
    },
    dump() {
      const traced = records.some((record) => record.type === "call");
      if (!traced && callCount > 0 && lastIdPrefix) {
        // The requested #k never happened in this worker, but the
        // function ran here at least once: a target_summary record
        // stands in for the call record the reader would otherwise be
        // looking for (see docs/evidence-schema.md, "Frame lifetime
        // trace"), naming the #k that was asked for and how many did run.
        const fid = `${lastIdPrefix}${targetK}`;
        return {
          records: [...records, { type: "target_summary", fid, observed_calls: callCount }],
          observedCalls: callCount,
        };
      }
      return { records: records.slice(), observedCalls: callCount };
    },
    reset() {
      records.length = 0;
      callCount = 0;
      currentTest = null;
    },
  };
}

function diffLocals(
  previous: Map<string, RenderedValue>,
  current: Map<string, RenderedValue>,
): Pick<FltLineRecord, "new" | "changed" | "out_of_scope"> {
  const added: Record<string, RenderedValue> = {};
  const changed: Record<string, { old: RenderedValue; new: RenderedValue }> = {};
  const outOfScope: string[] = [];

  for (const [name, value] of current) {
    const before = previous.get(name);
    if (before === undefined) added[name] = value;
    else if (!renderedEqual(before, value)) changed[name] = { old: before, new: value };
  }
  for (const name of previous.keys()) {
    if (!current.has(name)) outOfScope.push(name);
  }

  return { new: added, changed, out_of_scope: outOfScope };
}

declare global {
  // eslint-disable-next-line no-var
  var __depug_flt: FltRuntime;
}

/** Installs a fresh runtime as the global `__depug_flt` instrumented code calls. */
export function installGlobalFltRuntime(targetK: number, limits: FltLimits): FltRuntime {
  const runtime = createFltRuntime(targetK, limits);
  globalThis.__depug_flt = runtime;
  return runtime;
}
