// Projects a TypeScript declared type down to the few facts depug puts
// next to an observed runtime value: which properties a type promises,
// which primitive kinds each one allows, and whether it allows absence.
//
// This module runs at transform time, where the compiler is available. It
// stays separate from observed-shape.ts on purpose: that module runs
// inside the application's own process, where loading the compiler would
// cost more than everything else depug does (measured on hono at one
// pinned commit: 158.57 ms for createProgram plus 64.51 ms for
// getTypeChecker, n=5 medians).
//
// The projection is deliberately shallow. depug reports what a value
// looks like beside what it was declared to be; it is not a validator, so
// it never recurses into a nested object's own properties. A nested
// object reports as the kind "object" and nothing more.
import ts from "typescript";

/** A primitive kind name, or "object"/"array"/"function" for the rest. */
export type Kind =
  | "string"
  | "number"
  | "boolean"
  | "bigint"
  | "symbol"
  | "null"
  | "undefined"
  | "object"
  | "array"
  | "function"
  | "any"
  | "unknown"
  | "never";

export interface DeclaredProperty {
  name: string;
  kinds: Kind[];
  /** The property is declared with `?`, so a missing value satisfies it. */
  optional: boolean;
}

export type DeclaredType =
  | { form: "primitive"; kinds: Kind[] }
  | { form: "object"; kinds: Kind[]; properties: DeclaredProperty[] };

export interface DeclaredSignature {
  name: string;
  parameters: { name: string; type: DeclaredType }[];
  returnType: DeclaredType;
}

// A union is the only place a declared type carries more than one kind, so
// flattening it here is what lets the rest of the module treat every type
// as a set of kinds.
function unionParts(type: ts.Type): ts.Type[] {
  return type.isUnion() ? type.types : [type];
}

function kindOf(checker: ts.TypeChecker, type: ts.Type): Kind {
  const f = type.flags;
  if (f & ts.TypeFlags.StringLike) return "string";
  if (f & ts.TypeFlags.NumberLike) return "number";
  if (f & ts.TypeFlags.BooleanLike) return "boolean";
  if (f & ts.TypeFlags.BigIntLike) return "bigint";
  if (f & ts.TypeFlags.ESSymbolLike) return "symbol";
  if (f & ts.TypeFlags.Null) return "null";
  if (f & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return "undefined";
  if (f & ts.TypeFlags.Any) return "any";
  if (f & ts.TypeFlags.Unknown) return "unknown";
  if (f & ts.TypeFlags.Never) return "never";
  if (checker.isArrayType(type) || checker.isTupleType(type)) return "array";
  if (type.getCallSignatures().length > 0) return "function";
  return "object";
}

function uniqueKinds(kinds: Kind[]): Kind[] {
  return [...new Set(kinds)];
}

/**
 * Projects one type. `location` is the node the type was read at, which
 * the checker needs to resolve a property's own type in the right scope.
 */
export function projectType(
  checker: ts.TypeChecker,
  type: ts.Type,
  location: ts.Node,
): DeclaredType {
  const parts = unionParts(type);
  const kinds = uniqueKinds(parts.map((part) => kindOf(checker, part)));

  // Properties come from the object members of the union only: a
  // `{a: string} | null` promises `a` when it is not null, and reporting
  // that is more useful than reporting no properties at all.
  const objectParts = parts.filter((part) => kindOf(checker, part) === "object");
  if (objectParts.length === 0) {
    return { form: "primitive", kinds };
  }

  const seen = new Map<string, DeclaredProperty>();
  for (const part of objectParts) {
    for (const symbol of checker.getPropertiesOfType(part)) {
      const propType = checker.getTypeOfSymbolAtLocation(symbol, location);
      const propKinds = uniqueKinds(
        unionParts(propType).map((p) => kindOf(checker, p)),
      );
      const optional = (symbol.flags & ts.SymbolFlags.Optional) !== 0;
      const existing = seen.get(symbol.name);
      if (existing) {
        existing.kinds = uniqueKinds([...existing.kinds, ...propKinds]);
        existing.optional = existing.optional || optional;
      } else {
        seen.set(symbol.name, { name: symbol.name, kinds: propKinds, optional });
      }
    }
  }

  return { form: "object", kinds, properties: [...seen.values()] };
}

/**
 * Reads the declared parameter and return types of one named function in
 * one file. `fileName` must be inside `program`.
 *
 * Returns undefined when the file holds no function of that name, rather
 * than throwing: a caller asking about a function that a later edit
 * removed should get an absence it can report, not an exception.
 */
export function declaredSignatureOf(
  program: ts.Program,
  fileName: string,
  functionName: string,
): DeclaredSignature | undefined {
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) return undefined;
  const checker = program.getTypeChecker();

  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) return undefined;

  const signature = checker.getSignatureFromDeclaration(found);
  if (!signature) return undefined;

  return {
    name: functionName,
    parameters: found.parameters.map((parameter) => ({
      name: parameter.name.getText(sourceFile),
      type: projectType(checker, checker.getTypeAtLocation(parameter), parameter),
    })),
    returnType: projectType(checker, signature.getReturnType(), found),
  };
}
