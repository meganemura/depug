// Rewrites one function so a caller's expression runs inside it, at one
// line, on one visit.
//
// This is the fourth rewrite, and the only one that changes what the
// program computes. It stays separate from the others for that reason as
// much as any: an injection path should be easy to read in full and easy
// to confirm is not reachable from the always-on layer.
//
// The expression is spliced into the source at the target line, so it
// runs in that scope with no closure or eval between it and the locals.
// `total = 10` there assigns the function's own `total`.
//
// The splice rules are the same as everywhere else: offsets from the AST,
// no newline in an inserted string, and the line count cannot change.
import ts from "typescript";
import { SKIP, forEachNode } from "./ast-walk.ts";
import { functionIdentity, type NamedFunction } from "./function-identity.ts";

/**
 * Why nothing was injected. A launcher that only saw `injected: false`
 * could not tell a wrong id from a right id aimed where no statement is,
 * and reported both as a call that never happened.
 */
export type ExecMiss =
  | { kind: "no-function" }
  /** The nearest enclosing function with statements, where there is one. */
  | { kind: "expression-body"; enclosing?: { id: string; statementLines: number[] } }
  | { kind: "no-statement"; statementLines: number[] };

export interface ExecTransformResult {
  code: string;
  injected: boolean;
  /** Set exactly when `injected` is false. */
  miss?: ExecMiss;
}

export interface ExecTarget {
  name: string;
  line: number;
  column: number;
  /** The line to evaluate at. */
  targetLine: number;
  /** The expression, as the caller wrote it. */
  expression: string;
}

interface Insertion {
  offset: number;
  text: string;
  order: number;
}

function isFunctionLike(node: ts.Node): node is NamedFunction {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node)) &&
    node.body !== undefined
  );
}

/**
 * Every statement belonging to `fn` itself, paired with its line. A
 * statement inside a nested function belongs to that function, and
 * evaluating there would read a different scope than the caller named.
 */
function ownStatements(fn: NamedFunction, sourceFile: ts.SourceFile): { node: ts.Statement; line: number }[] {
  const found: { node: ts.Statement; line: number }[] = [];
  ts.forEachChild(fn, (child) => {
    forEachNode(child, (node) => {
      // A statement inside a nested function reads a different scope than
      // the caller named.
      if (isFunctionLike(node)) return SKIP;
      if (ts.isStatement(node) && !ts.isBlock(node)) {
        found.push({
          node,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        });
      }
    });
  });
  return found;
}

function statementLines(fn: NamedFunction, sourceFile: ts.SourceFile): number[] {
  return [...new Set(ownStatements(fn, sourceFile).map((s) => s.line))].sort((a, b) => a - b);
}

function enclosingWithStatements(fn: NamedFunction, sourceFile: ts.SourceFile, fileId: string) {
  for (let node = fn.parent; node; node = node.parent) {
    if (isFunctionLike(node) && ts.isBlock(node.body!)) {
      return {
        id: functionIdentity(node, sourceFile, fileId).id,
        statementLines: statementLines(node, sourceFile),
      };
    }
  }
  return undefined;
}

/**
 * Splices the guarded evaluation into `source`.
 *
 * The guard asks the runtime rather than deciding locally, because the
 * runtime is where the launcher's token is checked. Injected code that ran
 * without asking would fire in an ordinary test run.
 */
export function instrumentExec(
  source: string,
  fileId: string,
  target: ExecTarget,
): ExecTransformResult {
  const sourceFile = ts.createSourceFile(fileId, source, ts.ScriptTarget.Latest, true);
  let fn: NamedFunction | undefined;

  forEachNode(sourceFile, (node) => {
    if (fn) return SKIP;
    if (!isFunctionLike(node)) return;
    const identity = functionIdentity(node, sourceFile, fileId);
    if (
      identity.name === target.name &&
      identity.line === target.line &&
      identity.column === target.column
    ) {
      fn = node;
      return SKIP;
    }
  });
  if (!fn) return { code: source, injected: false, miss: { kind: "no-function" } };
  if (!ts.isBlock(fn.body!)) {
    // An expression-bodied arrow holds one expression and no statement to
    // evaluate before, so there is nothing to inject at.
    return {
      code: source,
      injected: false,
      miss: { kind: "expression-body", enclosing: enclosingWithStatements(fn, sourceFile, fileId) },
    };
  }

  const at = ownStatements(fn, sourceFile).find((statement) => statement.line === target.targetLine);
  if (!at) {
    return {
      code: source,
      injected: false,
      miss: { kind: "no-statement", statementLines: statementLines(fn, sourceFile) },
    };
  }

  const insertions: Insertion[] = [];
  const callVar = "__depug_exec_call";

  // The call counter lives at the function's entry, so a target naming
  // `#2` evaluates on the second call and not on the first.
  insertions.push({
    offset: fn.body.getStart(sourceFile) + 1,
    text: `const ${callVar}=__depugExec.enter();`,
    order: 0,
  });

  // The expression is evaluated inside a guard, and both outcomes are
  // recorded: an expression that throws is an observation, not a crash to
  // hide.
  const guard =
    `if(__depugExec.shouldRun(${callVar},${target.targetLine})){` +
    `try{__depugExec.value(${target.targetLine},__depugExecRender((${target.expression})));}` +
    `catch(__depug_exec_err){__depugExec.threw(${target.targetLine},` +
    `String(__depug_exec_err&&__depug_exec_err.name||"Error"),` +
    `String(__depug_exec_err&&__depug_exec_err.message||__depug_exec_err));}}`;

  insertions.push({ offset: at.node.getStart(sourceFile), text: guard, order: 1 });

  insertions.sort((a, b) => (a.offset !== b.offset ? b.offset - a.offset : b.order - a.order));
  let code = source;
  for (const insertion of insertions) {
    code = code.slice(0, insertion.offset) + insertion.text + code.slice(insertion.offset);
  }
  return { code, injected: true };
}
