// Which function holds a given line.
//
// This answers the question that kept costing whole re-runs. A reader
// starts from a line: a failure names one, a diff changes one, a trace is
// missing one. A verb wants a function id. Turning the first into the
// second by eye means opening the file and matching braces, and getting it
// wrong costs a process each time -- measured on one real bug, seven
// traces to find which of seven calls to one function was the wrong one,
// and on a run of 25, four cases aimed at an enclosing function rather
// than the one holding the line.
//
// The innermost function wins, because that is the one whose locals the
// line actually touched.
import ts from "typescript";
import { forEachNode } from "./ast-walk.ts";
import { functionIdentity, type FunctionIdentity, type NamedFunction } from "./function-identity.ts";

export interface FunctionRange extends FunctionIdentity {
  startLine: number;
  endLine: number;
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

/** Every function with a body, and the lines its whole declaration spans. */
export function functionRanges(source: string, fileId: string): FunctionRange[] {
  const sourceFile = ts.createSourceFile(fileId, source, ts.ScriptTarget.Latest, true);
  const found: FunctionRange[] = [];

  forEachNode(sourceFile, (node) => {
    if (!isFunctionLike(node)) return;
    const identity = functionIdentity(node, sourceFile, fileId);
    found.push({
      ...identity,
      startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      endLine: sourceFile.getLineAndCharacterOfPosition(node.end).line + 1,
    });
  });
  return found;
}

/**
 * The functions whose declaration spans `line`, innermost first.
 *
 * "Innermost" is decided by how few lines a function spans, which orders a
 * nested function ahead of the one holding it without needing the tree
 * again.
 */
export function functionsContaining(source: string, fileId: string, line: number): FunctionRange[] {
  return functionRanges(source, fileId)
    .filter((range) => range.startLine <= line && line <= range.endLine)
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine));
}
