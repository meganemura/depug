// Accumulates what one named function actually received and returned.
//
// This runs inside the application's own process, so it imports no
// compiler: the declared side of the comparison is read separately, at
// transform time, and the two meet after the run. observed-shape.ts
// records the same split and the measurement behind it.
//
// The record holds shapes and counts, not values. A probe answers "what
// arrived here", and the shape answers it without writing anything a
// reader did not ask for; a captured value can carry a secret, and this
// module never has to decide whether one did.
//
// Counts cover every call. Sampling them would let a later null hide and
// support a claim that it never happened, which is the opposite of what
// this tool is for.
import { emptyShape, observe, type ObservedShape } from "./observed-shape.ts";

export interface ProbeFunctionRecord {
  calls: number;
  /** Calls that left through an exception rather than a return. */
  threw: number;
  parameters: { name: string; observed: ObservedShape }[];
  returns: ObservedShape;
}

export interface ProbeRuntime {
  enter(target: string, parameterNames: readonly string[], args: readonly unknown[]): void;
  exitReturn(target: string, value: unknown): void;
  exitThrow(target: string): void;
  dump(): Record<string, ProbeFunctionRecord>;
  reset(): void;
}

export function createProbeRuntime(): ProbeRuntime {
  const byTarget = new Map<string, ProbeFunctionRecord>();

  function forTarget(target: string): ProbeFunctionRecord {
    let found = byTarget.get(target);
    if (!found) {
      found = { calls: 0, threw: 0, parameters: [], returns: emptyShape() };
      byTarget.set(target, found);
    }
    return found;
  }

  return {
    enter(target, parameterNames, args) {
      const entry = forTarget(target);
      entry.calls += 1;
      parameterNames.forEach((name, index) => {
        let slot = entry.parameters[index];
        if (!slot) {
          slot = { name, observed: emptyShape() };
          entry.parameters[index] = slot;
        }
        observe(slot.observed, args[index]);
      });
    },
    exitReturn(target, value) {
      observe(forTarget(target).returns, value);
    },
    exitThrow(target) {
      // A throw is not a return of undefined. Counting it apart is what
      // lets a reader tell "this sometimes returns nothing" from "this
      // sometimes fails".
      forTarget(target).threw += 1;
    },
    dump() {
      return Object.fromEntries(byTarget);
    },
    reset() {
      byTarget.clear();
    },
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __depugProbe: ProbeRuntime;
}

export function installGlobalProbeRuntime(): ProbeRuntime {
  const runtime = createProbeRuntime();
  globalThis.__depugProbe = runtime;
  return runtime;
}
