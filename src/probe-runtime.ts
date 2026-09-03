// Accumulates what one named function actually received and returned.
//
// This runs inside the application's own process, so it imports no
// compiler: the declared side of the comparison is read separately, at
// transform time, and the two meet after the run. observed-shape.ts
// records the same split and the measurement behind it.
//
// The record holds shapes and counts for every call, and a few rendered
// values beside them.
//
// The shapes alone were not enough in practice. Chasing a real failure
// through seven calls to one function, the shapes agreed with each other
// and with the declaration; only the values differed, so finding the wrong
// call meant tracing all seven one at a time. A handful of samples turns
// that into one run.
//
// Counts still cover every call. Sampling those would let a later null
// hide and support a claim that it never happened, which is the opposite
// of what this tool is for. Samples are capped; counts are not.
import { emptyShape, observe, type ObservedShape } from "./observed-shape.ts";
import { isSecretName, renderValue, type FltLimits } from "./flt-render.ts";

export const PROBE_LIMITS: FltLimits = {
  max_value_length: 200,
  max_elements: 10,
};

/** How many values are rendered for one position before counting only. */
export const MAX_SAMPLES = 10;

export interface ProbePosition {
  observed: ObservedShape;
  /** The first values seen, rendered. A name that reads as a secret is withheld. */
  samples: string[];
  samples_omitted: number;
}

export interface ProbeFunctionRecord {
  calls: number;
  /** Calls that left through an exception rather than a return. */
  threw: number;
  parameters: ({ name: string } & ProbePosition)[];
  returns: ProbePosition;
}

export interface ProbeRuntime {
  enter(target: string, parameterNames: readonly string[], args: readonly unknown[]): void;
  exitReturn(target: string, value: unknown): void;
  exitThrow(target: string): void;
  dump(): Record<string, ProbeFunctionRecord>;
  reset(): void;
}

function emptyPosition(): ProbePosition {
  return { observed: emptyShape(), samples: [], samples_omitted: 0 };
}

function record(position: ProbePosition, value: unknown, secret: boolean): void {
  observe(position.observed, value);
  if (secret) return;
  if (position.samples.length < MAX_SAMPLES) {
    const rendered = renderValue(value, PROBE_LIMITS);
    position.samples.push("value" in rendered ? rendered.value : "[REDACTED]");
  } else {
    position.samples_omitted += 1;
  }
}

export function createProbeRuntime(): ProbeRuntime {
  const byTarget = new Map<string, ProbeFunctionRecord>();

  function forTarget(target: string): ProbeFunctionRecord {
    let found = byTarget.get(target);
    if (!found) {
      found = { calls: 0, threw: 0, parameters: [], returns: emptyPosition() };
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
          slot = { name, ...emptyPosition() };
          entry.parameters[index] = slot;
        }
        // A parameter whose name reads as a secret is counted but never
        // rendered, so a probe cannot be the thing that writes one down.
        record(slot, args[index], isSecretName(name));
      });
    },
    exitReturn(target, value) {
      record(forTarget(target).returns, value, false);
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
