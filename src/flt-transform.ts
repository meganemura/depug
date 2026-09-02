// Rewrites one target function's own source so each of its statements
// reports the locals visible at that point to a runtime collector, and its
// return value or thrown error is captured on the way out.
//
// This does not touch src/transform.ts. That transform runs on every file
// application code holds and every function inside it, because the
// always-on layer has to answer "did this call happen" for anything a
// suite might do. This one runs on one file, and inside it, on one
// function: `flt` already knows which call it wants (a caller names it by
// fid), so nothing here needs to instrument a function it was not asked
// about. Mixing the two would put flt's heavier per-statement cost on
// every function the always-on layer already covers.
//
// The splice strategy is the same as transform.ts's, for the same reason
// (see its own header comment): read offsets from the AST, insert
// newline-free strings into the original text, never print a tree. Some
// helpers below (toLineColumn, findNameNode, functionDisplayName,
// isInstrumentableFunction, hasExpressionBody) are copies of
// transform.ts's own private functions rather than imports, because
// transform.ts exports none of them; see flt.md for that choice.
//
// Where transform.ts resolves same-offset insertions with a boundary/order
// tie-break (needed because its insertions come in nested start/end pairs
// that can reorder relative to each other), this transform's insertions
// are single points, generated in the exact order they must run: the walk
// below finishes a statement's own inner insertions before adding the
// generic capture that follows it, and finishes a loop's own loopExit
// before the capture that follows the whole loop. Concatenating by offset
// in generation order is therefore already correct wherever two insertions
// land on one character; see flt.md for the cases this was checked
// against.
import ts from "typescript";

export interface FltTarget {
  name: string;
  line: number;
  column: number;
}

export interface FltInstrumentResult {
  code: string;
  /** False when no function in this file starts at the target's position. */
  found: boolean;
}

type InstrumentableNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isInstrumentableFunction(node: ts.Node): node is InstrumentableNode {
  if (
    !ts.isFunctionDeclaration(node) &&
    !ts.isFunctionExpression(node) &&
    !ts.isMethodDeclaration(node) &&
    !ts.isArrowFunction(node) &&
    !ts.isConstructorDeclaration(node) &&
    !ts.isGetAccessor(node) &&
    !ts.isSetAccessor(node)
  ) {
    return false;
  }
  return node.body !== undefined;
}

function hasExpressionBody(node: InstrumentableNode): node is ts.ArrowFunction {
  return ts.isArrowFunction(node) && !ts.isBlock(node.body);
}

function findNameNode(node: InstrumentableNode): ts.Identifier | undefined {
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

function functionDisplayName(node: InstrumentableNode, nameNode: ts.Identifier | undefined): string {
  if (nameNode) return nameNode.text;
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (
    (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) &&
    !ts.isIdentifier(node.name)
  ) {
    return "<computed>";
  }
  return "<anonymous>";
}

function toLineColumn(sourceFile: ts.SourceFile, pos: number): { line: number; column: number } {
  const lc = sourceFile.getLineAndCharacterOfPosition(pos);
  return { line: lc.line + 1, column: lc.character + 1 };
}

let counter = 0;
function freshId(): string {
  counter += 1;
  return `t${counter}`;
}

/** Every identifier a binding pattern introduces: a plain name, or every leaf of `{a,[b,c]}`. */
function collectBoundNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    collectBoundNames(element.name, out);
  }
}

/**
 * True for TypeScript's own `this` parameter (`function f(this: R, ...)`),
 * which exists only to type-check the function's call sites and vanishes
 * at runtime: `this` is a reserved word, and putting it in a captured
 * object's shorthand syntax (`{this, method, path}`) is a syntax error,
 * not a value worth showing anyway.
 */
function isThisParameter(param: ts.ParameterDeclaration): boolean {
  return ts.isIdentifier(param.name) && param.name.text === "this";
}

/** Every name bound by a function's own parameter list, `this` excluded. */
function collectParamNames(params: readonly ts.ParameterDeclaration[]): string[] {
  const names: string[] = [];
  for (const param of params) {
    if (isThisParameter(param)) continue;
    collectBoundNames(param.name, names);
  }
  return names;
}

type LoopStatement = ts.ForStatement | ts.WhileStatement | ts.DoStatement | ts.ForOfStatement | ts.ForInStatement;

function isLoopStatement(node: ts.Statement): node is LoopStatement {
  return (
    ts.isForStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node)
  );
}

/**
 * True for a statement whose completion never falls through to whatever
 * text follows it: a trailing capture inserted after one of these would be
 * dead code, since nothing runs there. This is a syntactic check on four
 * statement kinds, not real control-flow analysis, so an `if` that returns
 * on every branch still gets a (harmless, always-executed) capture after
 * it -- accepted for simplicity; see flt.md.
 */
function fallsThroughUnconditionally(stmt: ts.Statement): boolean {
  return (
    ts.isReturnStatement(stmt) ||
    ts.isThrowStatement(stmt) ||
    ts.isBreakStatement(stmt) ||
    ts.isContinueStatement(stmt)
  );
}

/**
 * Every function in `source` that `instrumentTarget` could address, with
 * the same name/line/column it would match on. Used by the corpus
 * regression test to exercise every function a real file holds, not only
 * the hand-written fixture; not needed by the transform itself, which
 * only ever looks for one match and stops.
 */
export function listInstrumentableFunctions(source: string, fileId: string): FltTarget[] {
  const sourceFile = ts.createSourceFile(fileId, source, ts.ScriptTarget.Latest, true);
  const targets: FltTarget[] = [];

  function visit(node: ts.Node): void {
    if (isInstrumentableFunction(node)) {
      const nameNode = findNameNode(node);
      const name = functionDisplayName(node, nameNode);
      const posNode: ts.Node = nameNode ?? node;
      const { line, column } = toLineColumn(sourceFile, posNode.getStart(sourceFile));
      targets.push({ name, line, column });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return targets;
}

/**
 * Rewrites `source` so the one function at `target`'s position reports its
 * entry arguments, its per-statement locals, and its exit, through the
 * global `__depug_flt` collector. Every other function in the file, and
 * every nested function inside the target's own body, is left untouched:
 * flt traces one call, and a nested function's own statements belong to a
 * different frame (see the module header for why this is a separate
 * concern from src/transform.ts).
 */
export function instrumentTarget(source: string, fileId: string, target: FltTarget): FltInstrumentResult {
  const sourceFile = ts.createSourceFile(fileId, source, ts.ScriptTarget.Latest, true);

  let targetNode: InstrumentableNode | undefined;
  let targetLine = 0;
  let targetColumn = 0;

  function findTarget(node: ts.Node): void {
    if (targetNode) return;
    if (isInstrumentableFunction(node)) {
      const nameNode = findNameNode(node);
      const name = functionDisplayName(node, nameNode);
      const posNode: ts.Node = nameNode ?? node;
      const { line, column } = toLineColumn(sourceFile, posNode.getStart(sourceFile));
      if (line === target.line && column === target.column && name === target.name) {
        targetNode = node;
        targetLine = line;
        targetColumn = column;
        return;
      }
    }
    ts.forEachChild(node, findTarget);
  }
  findTarget(sourceFile);

  if (!targetNode) return { code: source, found: false };

  const idPrefix = `${fileId}:${target.name}@${targetLine}:${targetColumn}#`;
  const idLiteral = JSON.stringify(idPrefix);
  const pathLiteral = JSON.stringify(fileId);
  const callVar = `__depug_flt_call_${freshId()}`;
  const kindVar = `__depug_flt_kind_${freshId()}`;
  const errVar = `__depug_flt_err_${freshId()}`;

  // Insertions are keyed by character offset and concatenated in the
  // order this walk generates them (see the module header for why that is
  // enough, unlike transform.ts's boundary/order sort).
  const insertionsByOffset = new Map<number, string>();
  function insertAt(offset: number, text: string): void {
    insertionsByOffset.set(offset, (insertionsByOffset.get(offset) ?? "") + text);
  }

  // Every name visible at the current point, grouped into frames that
  // open and close with a block or a loop's own binding. Frame 0 holds
  // the target function's parameters, visible for the whole body.
  const scopeStack: string[][] = [[]];
  function pushScope(initial: readonly string[] = []): void {
    scopeStack.push([...initial]);
  }
  function popScope(): void {
    scopeStack.pop();
  }
  function addVisible(name: string): void {
    scopeStack[scopeStack.length - 1].push(name);
  }
  /** Every visible name, outermost frame first, each name once (the innermost declaration wins on a shadow). */
  function visibleNames(): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const frame of scopeStack) {
      for (const name of frame) {
        if (!seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
      }
    }
    return names;
  }
  function captureLiteral(): string {
    const names = visibleNames();
    return names.length === 0 ? "{}" : `{${names.join(",")}}`;
  }

  function insertCaptureAfter(node: ts.Node): void {
    const { line, column } = toLineColumn(sourceFile, node.getStart(sourceFile));
    insertAt(node.end, `;${callVar}.line(${line},${column},${captureLiteral()});`);
  }

  function processReturn(stmt: ts.ReturnStatement): void {
    // `return expr;` becomes `return <call>.ret((expr));`; bare `return;`
    // becomes `return <call>.ret(undefined);`. Either way the value is
    // known before it leaves the frame, which the function's own
    // finally/catch, wrapped around the whole body, cannot see on its own.
    if (stmt.expression) {
      insertAt(stmt.expression.getStart(sourceFile), `${callVar}.ret((`);
      insertAt(stmt.expression.end, `))`);
    } else {
      // "return" is always exactly 6 characters; a leading space keeps the
      // inserted identifier from fusing with the keyword.
      insertAt(stmt.getStart(sourceFile) + "return".length, ` ${callVar}.ret(undefined)`);
    }
  }

  function processLoop(stmt: LoopStatement): void {
    insertAt(stmt.getStart(sourceFile), `;${callVar}.loopEnter();`);

    const boundInInit: string[] = [];
    if ("initializer" in stmt && stmt.initializer && ts.isVariableDeclarationList(stmt.initializer)) {
      for (const decl of stmt.initializer.declarations) collectBoundNames(decl.name, boundInInit);
    }
    pushScope(boundInInit);

    const body = stmt.statement;
    if (ts.isBlock(body)) {
      insertAt(body.getStart(sourceFile) + 1, `;${callVar}.loopIterStart();`);
      pushScope();
      for (const child of body.statements) processStatement(child);
      popScope();
    } else {
      // A braceless body is exactly one statement, and `while (x) STATEMENT`
      // takes only that one statement as its body: a `;`-led insertion
      // placed before it (the way a block body's insertion is led) would
      // itself become a separate statement sitting between `while (x)` and
      // the original body, leaving the body empty and pushing the original
      // statement outside the loop entirely. Wrapping the body in a
      // synthetic block, the same way transform.ts rewrites an
      // expression-bodied arrow, keeps it one statement and keeps
      // everything inside it repeating.
      insertAt(body.getStart(sourceFile), `{${callVar}.loopIterStart();`);
      processStatement(body);
      insertAt(body.end, `}`);
    }

    popScope();
    // loopExit must land after the whole loop statement, not after the
    // body: the body finishes once per iteration, but the loop itself
    // ends exactly once, however many iterations it took.
    insertAt(stmt.end, `;${callVar}.loopExit();`);
  }

  /**
   * An `if`/`else` branch: recurses for its own per-statement detail, but
   * never inserts a trailing capture at the branch's own end. The
   * character right after a `then` branch (or a non-final `else if`
   * branch) can be the `else` keyword itself, and a capture written there
   * would parse as a dangling `else` with no `if`; see flt.md for the
   * fixture that failed on this. The whole `if` statement still gets one
   * trailing capture, from the generic rule in `processStatement`, once
   * every branch has been visited.
   */
  function processBranch(branch: ts.Statement): void {
    if (ts.isBlock(branch)) {
      pushScope();
      for (const child of branch.statements) processStatement(child);
      popScope();
    } else if (ts.isIfStatement(branch)) {
      processBranch(branch.thenStatement);
      if (branch.elseStatement) processBranch(branch.elseStatement);
    } else {
      processStatementBody(branch);
    }
  }

  /** The recursion and visible-name bookkeeping for one statement, without its trailing capture. */
  function processStatementBody(stmt: ts.Statement): void {
    if (ts.isBlock(stmt)) {
      pushScope();
      for (const child of stmt.statements) processStatement(child);
      popScope();
    } else if (ts.isIfStatement(stmt)) {
      processBranch(stmt.thenStatement);
      if (stmt.elseStatement) processBranch(stmt.elseStatement);
    } else if (isLoopStatement(stmt)) {
      processLoop(stmt);
    } else if (ts.isReturnStatement(stmt)) {
      processReturn(stmt);
    } else if (ts.isVariableStatement(stmt)) {
      const bound: string[] = [];
      for (const decl of stmt.declarationList.declarations) collectBoundNames(decl.name, bound);
      for (const name of bound) addVisible(name);
    } else if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
      // Its own name is excluded from the visible set (a captured function
      // or class value is not a statement-lifetime local worth showing),
      // and its body is not walked: a different frame, per the module
      // header.
    }
    // Every other statement kind -- an expression statement, a `try`, a
    // `switch`, a labeled statement -- is left as an opaque leaf: no
    // per-statement detail inside it. See flt.md for what this leaves out.
  }

  /**
   * The entry point for a statement that is a direct child of a block (the
   * target's own body, a nested block, or a loop's block body): runs its
   * recursion, then adds the one capture that follows it, unless the
   * statement's own completion can never fall through to that point.
   */
  function processStatement(stmt: ts.Statement): void {
    processStatementBody(stmt);
    if (!fallsThroughUnconditionally(stmt)) insertCaptureAfter(stmt);
  }

  if (hasExpressionBody(targetNode)) {
    const paramNames = collectParamNames(targetNode.parameters);
    scopeStack[0] = paramNames;
    const paramLiteral = paramNames.length === 0 ? "{}" : `{${paramNames.join(",")}}`;

    const enterText = `const ${callVar}=__depug_flt.enter(${idLiteral},${pathLiteral},${targetLine},${targetColumn},${paramLiteral});`;
    const body = targetNode.body as ts.Expression;
    insertAt(body.getStart(sourceFile), `{${enterText}return ${callVar}.ret((`);
    insertAt(body.end, `))}`);
  } else {
    const paramNames = collectParamNames(targetNode.parameters);
    scopeStack[0] = paramNames;
    const paramLiteral = paramNames.length === 0 ? "{}" : `{${paramNames.join(",")}}`;

    const enterText =
      `const ${callVar}=__depug_flt.enter(${idLiteral},${pathLiteral},${targetLine},${targetColumn},${paramLiteral});` +
      `let ${kindVar}="return";let ${errVar};try{`;
    const exitText =
      `}catch(${errVar}0){${kindVar}="throw";${errVar}=${errVar}0;throw ${errVar}0;}` +
      `finally{${callVar}.exit(${kindVar},${errVar});}`;

    const body = targetNode.body as ts.Block;
    const openBrace = body.getStart(sourceFile);
    const closeBrace = body.end - 1;
    insertAt(openBrace + 1, enterText);
    for (const child of body.statements) processStatement(child);
    insertAt(closeBrace, exitText);
  }

  const offsets = [...insertionsByOffset.keys()].sort((a, b) => b - a);
  let code = source;
  for (const offset of offsets) {
    code = code.slice(0, offset) + insertionsByOffset.get(offset) + code.slice(offset);
  }

  return { code, found: true };
}
