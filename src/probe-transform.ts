// Rewrites one named function so it reports its arguments and its return
// value.
//
// This is separate from transform.ts, which instruments every function in
// a file for the call index. A probe targets one function per run, and the
// two jobs want different insertions: the index needs entry and exit, a
// probe needs the values that crossed them. Keeping them apart means the
// always-on path never carries the cost of capturing a value.
//
// The same splice rules hold: offsets come from the AST, no inserted
// string contains a newline, and the line count cannot change.
import ts from "typescript";
import { fidWithoutCall } from "./fid.ts";
import { functionIdentity } from "./function-identity.ts";

export interface UnobservedParameter {
  position: number;
  reason: "destructured";
}

export interface ProbeTarget {
  id: string;
  parameters: string[];
  parameters_not_observed: UnobservedParameter[];
}

export interface ProbeTransformResult {
  code: string;
  targets: ProbeTarget[];
}

interface Insertion {
  offset: number;
  text: string;
  boundary: "start" | "end";
  order: number;
}

let counter = 0;
const fresh = (): string => `p${(counter += 1)}`;

type Targetable =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration
  | ts.ArrowFunction;

function isTargetable(node: ts.Node): node is Targetable {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node)) &&
    node.body !== undefined
  );
}

/**
 * Splits parameters into the ones a probe can read and the ones it cannot.
 *
 * A destructured parameter (`function f({a, b})`) has no single binding to
 * read, so this rewrite cannot observe the value that arrived. It is left
 * out of the record rather than reported as `undefined`: a file saying a
 * value was undefined, where it was an object nobody looked at, is worse
 * than a file saying it was not observed.
 */
function splitParameters(node: Targetable): {
  observed: { index: number; name: string }[];
  unobserved: UnobservedParameter[];
} {
  const observed: { index: number; name: string }[] = [];
  const unobserved: UnobservedParameter[] = [];
  node.parameters.forEach((parameter, index) => {
    if (ts.isIdentifier(parameter.name)) observed.push({ index, name: parameter.name.text });
    else unobserved.push({ position: index, reason: "destructured" });
  });
  return { observed, unobserved };
}

/**
 * The `return` statements that belong to `fn` itself. A return inside a
 * nested function belongs to that function, so the walk stops at a
 * function boundary rather than capturing a value this probe never sees.
 */
function ownReturns(fn: Targetable): ts.ReturnStatement[] {
  const found: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (isTargetable(node)) return;
    if (ts.isReturnStatement(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return found;
}

/**
 * Rewrites every function in `source` whose id, without its call index,
 * appears in `targets`.
 *
 * The captured return value travels through a variable the entry
 * insertion declares. A `finally` clause is the only place that runs for
 * every exit, and it cannot see the value a `return` produced, so each of
 * the function's own return expressions is wrapped to assign it on the way
 * past. A function that falls off its end leaves the variable undefined,
 * which is what it returned.
 */
export function instrumentProbes(
  source: string,
  fileId: string,
  targets: readonly string[],
): ProbeTransformResult {
  const wanted = new Set(targets.map(fidWithoutCall));
  const sourceFile = ts.createSourceFile(fileId, source, ts.ScriptTarget.Latest, true);
  const insertions: Insertion[] = [];
  const hit: ProbeTarget[] = [];

  const visit = (node: ts.Node): void => {
    if (isTargetable(node)) {
      // The same rule the call index uses, so an id printed by `frames`
      // addresses the same function here.
      const { id } = functionIdentity(node, sourceFile, fileId);

      if (wanted.has(id)) {
        const { observed, unobserved } = splitParameters(node);
        hit.push({ id, parameters: observed.map((p) => p.name), parameters_not_observed: unobserved });

        const idLiteral = JSON.stringify(id);
        const namesLiteral = JSON.stringify(observed.map((p) => p.name));
        const argsLiteral = `[${observed.map((p) => p.name).join(",")}]`;
        const valueVar = `__depug_ret_${fresh()}`;
        const threwVar = `__depug_threw_${fresh()}`;
        const errVar = `__depug_perr_${fresh()}`;

        // Reading the named bindings rather than `arguments` keeps one
        // shape for every function kind: an arrow has no `arguments`.
        const enter =
          `__depugProbe.enter(${idLiteral},${namesLiteral},${argsLiteral});` +
          `let ${valueVar};let ${threwVar}=false;try{`;
        const exit =
          `}catch(${errVar}){${threwVar}=true;__depugProbe.exitThrow(${idLiteral});throw ${errVar};}` +
          `finally{if(!${threwVar})__depugProbe.exitReturn(${idLiteral},${valueVar});}`;

        if (ts.isBlock(node.body!)) {
          const open = node.body.getStart(sourceFile);
          const close = node.body.end - 1;
          if (close === open + 1) {
            insertions.push({ offset: open + 1, text: enter + exit, boundary: "start", order: insertions.length });
          } else {
            insertions.push({ offset: open + 1, text: enter, boundary: "start", order: insertions.length });
            insertions.push({ offset: close, text: exit, boundary: "end", order: insertions.length });
          }
          for (const statement of ownReturns(node)) {
            if (!statement.expression) continue;
            insertions.push({
              offset: statement.expression.getStart(sourceFile),
              text: `(${valueVar}=`,
              boundary: "start",
              order: insertions.length,
            });
            insertions.push({
              offset: statement.expression.end,
              text: ")",
              boundary: "end",
              order: insertions.length,
            });
          }
        } else {
          const body = node.body as ts.Expression;
          insertions.push({
            offset: body.getStart(sourceFile),
            text: `{${enter}return (${valueVar}=`,
            boundary: "start",
            order: insertions.length,
          });
          insertions.push({ offset: body.end, text: `)${exit}}`, boundary: "end", order: insertions.length });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  insertions.sort((a, b) => {
    if (a.offset !== b.offset) return b.offset - a.offset;
    if (a.boundary === "start" && b.boundary === "start") return b.order - a.order;
    if (a.boundary === "end" && b.boundary === "end") return a.order - b.order;
    return a.boundary === "end" ? -1 : 1;
  });

  let code = source;
  for (const insertion of insertions) {
    code = code.slice(0, insertion.offset) + insertion.text + code.slice(insertion.offset);
  }
  return { code, targets: hit };
}
