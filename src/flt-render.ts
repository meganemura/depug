// Renders one captured local into the JSON shape `flt` writes, and decides
// when a name's value must not be rendered at all.
//
// This module owns the "Rendered values" and "Secrets" contract from
// docs/evidence-schema.md for the `flt` verb specifically. It does not
// import from probe-runtime.ts, which renders values for the `probe` verb:
// the two verbs were built by separate workers in the same iteration, and
// importing across that boundary would let an edit to one break the
// other's build silently. The redaction pattern below is therefore a
// second copy of probe-runtime.ts's `REDACTED` pattern, chosen so the two
// verbs redact the same names by default; see flt.md for the duplication.
export interface FltLimits {
  max_value_length: number;
  max_elements: number;
}

export type RenderedValue =
  | { value: string }
  | { value: string; truncated: true; original_length: number }
  | { redacted: true; reason: "name" };

const SECRET_NAME = /pass(word|wd)?|secret|token|api[-_]?key|key|credential|auth|session|cookie/i;

/** True where a name suggests the value behind it should not be written. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

function renderScalar(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.toString();
  return String(value);
}

/**
 * Renders a value one level deep: a nested array or object shows as `[…]`
 * or `{…}` rather than recursing further. This matches probe's own
 * rendering depth (see docs/evidence-schema.md, "Rendered values"), which
 * exists because a snapshot answers what a value was at this statement,
 * and a nested structure's own shape is a question a narrower probe or a
 * later `line` record answers instead.
 */
function renderDeep(value: unknown, limits: FltLimits): string {
  if (value === null || typeof value !== "object") return renderScalar(value);
  if (Array.isArray(value)) {
    const parts = value
      .slice(0, limits.max_elements)
      .map((item) => (item !== null && typeof item === "object" ? (Array.isArray(item) ? "[…]" : "{…}") : renderScalar(item)));
    if (value.length > limits.max_elements) parts.push("…");
    return `[${parts.join(", ")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const parts = entries.slice(0, limits.max_elements).map(([key, item]) => {
    if (isSecretName(key)) return `${key}: "[REDACTED]"`;
    const rendered =
      item !== null && typeof item === "object" ? (Array.isArray(item) ? "[…]" : "{…}") : renderScalar(item);
    return `${key}: ${rendered}`;
  });
  if (entries.length > limits.max_elements) parts.push("…");
  return `{${parts.join(", ")}}`;
}

/**
 * Renders one value, applying `max_value_length` and reporting a render
 * that throws rather than losing the entry, both per the schema's
 * "Rendered values" section.
 */
export function renderValue(value: unknown, limits: FltLimits): RenderedValue {
  let text: string;
  try {
    text = renderDeep(value, limits);
  } catch (error) {
    const name = error instanceof Error ? error.constructor.name : "Error";
    return { value: `<render threw ${name}>` };
  }
  if (text.length > limits.max_value_length) {
    return { value: `${text.slice(0, limits.max_value_length)}…`, truncated: true, original_length: text.length };
  }
  return { value: text };
}

/**
 * Renders a value that is bound to a name (a local, a parameter), checking
 * the name against the secret pattern first. A matching name is withheld
 * before the value is ever touched, so a secret can never leak through a
 * render that would otherwise succeed.
 */
export function renderNamed(name: string, value: unknown, limits: FltLimits): RenderedValue {
  if (isSecretName(name)) return { redacted: true, reason: "name" };
  return renderValue(value, limits);
}

/** Structural equality on two rendered values, used to detect a "changed" entry. */
export function renderedEqual(a: RenderedValue, b: RenderedValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
