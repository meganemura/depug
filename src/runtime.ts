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
  /**
   * The call that was executing when this one was entered, present on
   * `enter` only.
   *
   * JavaScript runs one call chain at a time, so the executing call is the
   * top of a stack that entry pushes and exit pops. An `await` moves the
   * boundary: a suspended call is not executing, so `suspend` pops it and
   * `resume` pushes it back. What this does not rebuild is a resumed
   * call's own ancestors, which left the stack when it suspended; a call
   * entered after a resume names its immediate caller correctly, and the
   * chain above that caller is only as deep as the resume restored.
   */
  parent?: string | null;
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
  const executing: string[] = [];
  let currentTest: string | null = null;

  function enter(idPrefix: string, line: number, column: number): number {
    const callId = (callCounts.get(idPrefix) ?? 0) + 1;
    callCounts.set(idPrefix, callId);
    const fn = `${idPrefix}${callId}`;
    events.push({
      kind: "enter",
      fn,
      line,
      column,
      test: currentTest,
      parent: executing.length === 0 ? null : executing[executing.length - 1],
    });
    executing.push(fn);
    return callId;
  }

  function exit(
    idPrefix: string,
    line: number,
    column: number,
    exitKind: ExitKind,
    callId: number,
  ): void {
    const fn = `${idPrefix}${callId}`;
    pop(fn);
    events.push({ kind: "exit", fn, line, column, exitKind, test: currentTest });
  }

  // Removes one call from the executing stack. It is usually the top, but
  // a rejected await leaves its own frame behind (the resume that would
  // have popped it never ran), so this searches from the top rather than
  // assuming.
  function pop(fn: string): void {
    for (let i = executing.length - 1; i >= 0; i--) {
      if (executing[i] === fn) {
        executing.splice(i, 1);
        return;
      }
    }
  }

  function suspend(idPrefix: string, line: number, column: number, callId: number): void {
    const fn = `${idPrefix}${callId}`;
    pop(fn);
    events.push({ kind: "suspend", fn, line, column, test: currentTest });
  }

  function resume<T>(idPrefix: string, line: number, column: number, callId: number, value: T): T {
    const fn = `${idPrefix}${callId}`;
    executing.push(fn);
    events.push({ kind: "resume", fn, line, column, test: currentTest });
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
    executing.length = 0;
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
