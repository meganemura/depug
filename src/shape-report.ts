// Puts an observed shape next to a declared type and names where they
// disagree.
//
// This is the column AGENTS.md settles as part of v0.1: `probe` and `flt`
// show what a value was beside what it was declared to be. The point is
// the gap between the two. A type annotation is a claim about runtime
// values that nothing checks at a boundary where data enters the program
// -- `JSON.parse`, an `as` cast, `process.env`, an `any` parameter -- and
// depug reports the value that got in.
//
// This is not a validator. It compares the shallow projection against the
// shallow observation and stops there: no nested properties, no
// structural subtyping, no literal types.
import type { DeclaredType, Kind } from "./declared-type.ts";
import type { ObservedShape } from "./observed-shape.ts";

export type MismatchReason =
  /** The value held a kind the declared type does not allow. */
  | "kind-not-declared"
  /** A required property was missing from at least one observed value. */
  | "required-property-absent"
  /** The value carried a property the declared type does not mention. */
  | "property-not-declared";

export interface Mismatch {
  /** Property name, or "" when the mismatch is about the value itself. */
  property: string;
  reason: MismatchReason;
  observed: string;
  declared: string;
  /** Calls this mismatch was seen in, out of the total observed. */
  occurrences: number;
  samples: number;
}

/**
 * `any` and `unknown` accept every runtime kind, so a declared type that
 * reaches either one can never disagree with what was observed. That is
 * exactly why they are the shapes depug is most useful around: the
 * annotation stopped making a claim, and only the run can say what came
 * through.
 */
function acceptsEverything(kinds: readonly Kind[]): boolean {
  return kinds.includes("any") || kinds.includes("unknown");
}

function renderObservedKinds(kinds: Record<string, number>, samples: number): string {
  const entries = Object.entries(kinds).sort((a, b) => b[1] - a[1]);
  if (entries.length === 1 && entries[0][1] === samples) return entries[0][0];
  return entries.map(([kind, count]) => `${kind} (${count} / ${samples} calls)`).join(" | ");
}

/** Renders an observed shape in the form the evidence column prints. */
export function renderObserved(shape: ObservedShape): string {
  const properties = Object.values(shape.properties);
  if (properties.length === 0) return renderObservedKinds(shape.kinds, shape.samples);

  const parts = properties.map((property) => {
    const kinds = { ...property.kinds };
    // An absent property reads as `undefined` to anyone reading the value,
    // so it joins the kind counts rather than hiding in a separate field.
    if (property.absent > 0) kinds["undefined"] = (kinds["undefined"] ?? 0) + property.absent;
    return `${property.name}: ${renderObservedKinds(kinds, shape.samples)}`;
  });
  return `{${parts.join(", ")}}`;
}

/** Renders a declared type in the same form, for the line below. */
export function renderDeclared(type: DeclaredType): string {
  if (type.form === "primitive") return type.kinds.join(" | ");
  const parts = type.properties.map(
    (property) => `${property.name}${property.optional ? "?" : ""}: ${property.kinds.join(" | ")}`,
  );
  return `{${parts.join(", ")}}`;
}

/**
 * Names every disagreement between one observed shape and one declared
 * type. An empty result means the two agreed on everything this shallow
 * comparison looks at -- not that the value was correct.
 */
export function compareShape(shape: ObservedShape, declared: DeclaredType): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const declaredRendered = renderDeclared(declared);

  if (!acceptsEverything(declared.kinds)) {
    for (const [kind, count] of Object.entries(shape.kinds)) {
      if (!declared.kinds.includes(kind as Kind)) {
        mismatches.push({
          property: "",
          reason: "kind-not-declared",
          observed: kind,
          declared: declared.kinds.join(" | "),
          occurrences: count,
          samples: shape.samples,
        });
      }
    }
  }

  if (declared.form !== "object") return mismatches;

  const declaredByName = new Map(declared.properties.map((p) => [p.name, p]));

  for (const property of Object.values(shape.properties)) {
    const declaredProperty = declaredByName.get(property.name);
    if (!declaredProperty) {
      mismatches.push({
        property: property.name,
        reason: "property-not-declared",
        observed: renderObservedKinds(property.kinds, shape.samples),
        declared: declaredRendered,
        occurrences: shape.samples - property.absent,
        samples: shape.samples,
      });
      continue;
    }

    if (property.absent > 0 && !declaredProperty.optional) {
      mismatches.push({
        property: property.name,
        reason: "required-property-absent",
        observed: "absent",
        declared: declaredProperty.kinds.join(" | "),
        occurrences: property.absent,
        samples: shape.samples,
      });
    }

    if (acceptsEverything(declaredProperty.kinds)) continue;
    for (const [kind, count] of Object.entries(property.kinds)) {
      if (!declaredProperty.kinds.includes(kind as Kind)) {
        mismatches.push({
          property: property.name,
          reason: "kind-not-declared",
          observed: kind,
          declared: declaredProperty.kinds.join(" | "),
          occurrences: count,
          samples: shape.samples,
        });
      }
    }
  }

  // A property the declared type requires and no observed value ever
  // carried never reaches the loop above, because nothing created an
  // observation for it.
  for (const declaredProperty of declared.properties) {
    if (declaredProperty.optional) continue;
    if (shape.properties[declaredProperty.name]) continue;
    if (shape.samples === 0) continue;
    mismatches.push({
      property: declaredProperty.name,
      reason: "required-property-absent",
      observed: "absent",
      declared: declaredProperty.kinds.join(" | "),
      occurrences: shape.samples,
      samples: shape.samples,
    });
  }

  return mismatches;
}
