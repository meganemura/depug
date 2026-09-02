// Records what a value actually was at runtime, in the same vocabulary
// declared-type.ts projects a declared type into.
//
// This module runs inside the application's own process, so it must not
// import the TypeScript compiler. It observes; it does not judge. The
// comparison between what was observed and what was declared happens in
// shape-report.ts, after the run.
//
// Observation is shallow for the same reason the projection is: depug
// reports the shape of a value beside its declared type, and a nested
// object's own properties are a question for a second, narrower probe.
import type { Kind } from "./declared-type.ts";

export interface ObservedProperty {
  name: string;
  /** Every kind this property held, with how many times each occurred. */
  kinds: Record<string, number>;
  /** Calls where the property was absent from the value entirely. */
  absent: number;
}

export interface ObservedShape {
  /** Values observed for this position, counting every call. */
  samples: number;
  kinds: Record<string, number>;
  properties: Record<string, ObservedProperty>;
}

/** The runtime kind of one value, using declared-type.ts's vocabulary. */
export function kindOfValue(value: unknown): Kind {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "function":
      return "function";
    default:
      return "object";
  }
}

function emptyShape(): ObservedShape {
  return { samples: 0, kinds: {}, properties: {} };
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Folds one more observed value into `shape`, mutating it.
 *
 * A property that some calls carry and others omit is the case this
 * function exists to make visible, so absence is counted per property
 * rather than left as a gap: a property seen once in five calls reports
 * `absent: 4`, not four missing records.
 */
export function observe(shape: ObservedShape, value: unknown): ObservedShape {
  shape.samples += 1;
  bump(shape.kinds, kindOfValue(value));

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    // A non-object still counts against every property seen so far: those
    // properties were absent from this value.
    for (const property of Object.values(shape.properties)) {
      property.absent += 1;
    }
    return shape;
  }

  const record = value as Record<string, unknown>;
  const present = new Set(Object.keys(record));

  for (const name of present) {
    let property = shape.properties[name];
    if (!property) {
      // First sight of this property: every earlier sample lacked it.
      property = { name, kinds: {}, absent: shape.samples - 1 };
      shape.properties[name] = property;
    }
    bump(property.kinds, kindOfValue(record[name]));
  }

  for (const property of Object.values(shape.properties)) {
    if (!present.has(property.name)) property.absent += 1;
  }

  return shape;
}

export function observeAll(values: readonly unknown[]): ObservedShape {
  const shape = emptyShape();
  for (const value of values) observe(shape, value);
  return shape;
}

export { emptyShape };
