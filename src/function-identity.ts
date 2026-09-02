// How a function gets its name and its position.
//
// Two rewrites need this and they must agree exactly: the call index names
// a function, and a verb addresses that same function by the id the index
// printed. If one of them anchored an anonymous arrow at the arrow and the
// other at the variable holding it, the two would produce different ids
// for one function, and a verb would report that a function the index just
// listed does not exist. Keeping the rule in one place is what stops that
// from being possible.
import ts from "typescript";

export type NamedFunction =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

/**
 * The identifier that names a function, walking up to the variable or
 * property it is assigned to when the function itself is anonymous
 * (`const f = () => {}`). The position of this identifier is also the
 * position the id carries, so a reader who opens the file at that line
 * lands on the name rather than on a bare arrow.
 */
export function findNameNode(node: NamedFunction): ts.Identifier | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
    return node.name;
  }
  if (
    (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) &&
    ts.isIdentifier(node.name)
  ) {
    return node.name;
  }
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name;
  }
  if (
    parent &&
    (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name;
  }
  return undefined;
}

export function displayName(node: NamedFunction, nameNode: ts.Identifier | undefined): string {
  if (nameNode) return nameNode.text;
  // A constructor has no name of its own, but "constructor" reads better
  // in an index than the fallback, and the class it belongs to is already
  // visible from the path and line.
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (
    (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) &&
    !ts.isIdentifier(node.name)
  ) {
    return "<computed>";
  }
  return "<anonymous>";
}

export interface FunctionIdentity {
  name: string;
  /** 1-based, matching what an editor shows. */
  line: number;
  column: number;
  /** `path:name@line:column`, with no call index. */
  id: string;
}

export function functionIdentity(
  node: NamedFunction,
  sourceFile: ts.SourceFile,
  fileId: string,
): FunctionIdentity {
  const nameNode = findNameNode(node);
  const name = displayName(node, nameNode);
  const anchor: ts.Node = nameNode ?? node;
  const position = sourceFile.getLineAndCharacterOfPosition(anchor.getStart(sourceFile));
  const line = position.line + 1;
  const column = position.character + 1;
  return { name, line, column, id: `${fileId}:${name}@${line}:${column}` };
}
