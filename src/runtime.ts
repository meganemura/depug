// The object instrumented code calls as `__depug`. This collector only
// needs to answer two questions: did entry and exit events pair up, and
// did each event land on the TypeScript position the transform recorded.
// The public event schema is a separate, later concern.
export type ExitKind = "return" | "throw";

export interface DepugEvent {
  kind: "enter" | "exit" | "suspend" | "resume";
  fn: string;
  line: number;
  column: number;
  exitKind?: ExitKind;
  test: string | null;
}

export interface DepugRuntime {
  enter(idPrefix: string, line: number, column: number): number;
  exit(idPrefix: string, line: number, column: number, exitKind: ExitKind, callId: number): void;
  suspend(idPrefix: string, line: number, column: number, callId: number): void;
  // Returns `value` unchanged: the transform wraps an `await`'s own value
  // through this call so recording the resume event does not change what
  // the wrapped expression evaluates to (see transform.ts).
  resume<T>(idPrefix: string, line: number, column: number, callId: number, value: T): T;
  setCurrentTest(name: string | null): void;
  dump(): DepugEvent[];
  reset(): void;
}

export function createRuntime(): DepugRuntime {
  const events: DepugEvent[] = [];
  const callCounts = new Map<string, number>();
  let currentTest: string | null = null;

  function enter(idPrefix: string, line: number, column: number): number {
    const callId = (callCounts.get(idPrefix) ?? 0) + 1;
    callCounts.set(idPrefix, callId);
    events.push({ kind: "enter", fn: `${idPrefix}${callId}`, line, column, test: currentTest });
    return callId;
  }

  function exit(
    idPrefix: string,
    line: number,
    column: number,
    exitKind: ExitKind,
    callId: number,
  ): void {
    events.push({ kind: "exit", fn: `${idPrefix}${callId}`, line, column, exitKind, test: currentTest });
  }

  function suspend(idPrefix: string, line: number, column: number, callId: number): void {
    events.push({ kind: "suspend", fn: `${idPrefix}${callId}`, line, column, test: currentTest });
  }

  function resume<T>(idPrefix: string, line: number, column: number, callId: number, value: T): T {
    events.push({ kind: "resume", fn: `${idPrefix}${callId}`, line, column, test: currentTest });
    return value;
  }

  function setCurrentTest(name: string | null): void {
    currentTest = name;
  }

  function dump(): DepugEvent[] {
    return events.slice();
  }

  function reset(): void {
    events.length = 0;
    callCounts.clear();
    currentTest = null;
  }

  return { enter, exit, suspend, resume, setCurrentTest, dump, reset };
}

declare global {
  // eslint-disable-next-line no-var
  var __depug: DepugRuntime;
}

/** Installs a fresh runtime as the global `__depug` instrumented code calls. */
export function installGlobalRuntime(): DepugRuntime {
  const runtime = createRuntime();
  globalThis.__depug = runtime;
  return runtime;
}
