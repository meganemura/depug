// Rewrites a TypeScript source file so every function reports its own entry
// and exit to a runtime collector. The rewrite is a text splice over byte
// offsets taken from the TypeScript AST, not a print of a transformed tree:
// ts.createPrinter re-emits the whole tree and does not preserve the
// original line breaks or columns, which breaks the literal-position
// contract the rest of depug depends on (see AGENTS.md, "Positions are
// literals"). Every inserted string is newline-free, so splicing can only
// lengthen a line, never add or remove one.
import ts from "typescript";
import { forEachNode } from "./ast-walk.ts";
import { functionIdentity, type NamedFunction } from "./function-identity.ts";

export interface InstrumentedFunction {
  name: string;
  idPrefix: string;
  line: number;
  column: number;
}

export interface InstrumentResult {
  code: string;
  functions: InstrumentedFunction[];
}

// `boundary` and `order` exist only to break ties between two insertions
// that land on the same offset (see the comment on the sort below for why
// that happens and why the two boundary kinds need opposite tie-break
// directions).
interface Insertion {
  offset: number;
  text: string;
  boundary: "start" | "end";
  order: number;
}

// The nearest enclosing instrumented function an `await` inside its body
// should report through: the `const <callVar>` its entry insertion
// declares, and the id literal that names it. Each instrumented function
// pushes its own frame while its body is visited and pops it on the way
// out, so a nested instrumented function's own `await`s see their own
// frame, per the "innermost" rule this transform follows.
interface CallFrame {
  callVar: string;
  idLiteral: string;
}

// The naming and position rule lives in function-identity.ts, shared with
// the probe rewrite, so the two cannot drift into disagreeing about what
// one function is called.
type InstrumentableNode = NamedFunction;

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
  // An overload signature and an abstract method have no body, so there is
  // nothing to report from. Everything else that reaches here does: an
  // arrow with an expression body (`() => x`) is handled by rewriting it
  // into a block, which the caller below does.
  return node.body !== undefined;
}

/** True for an arrow written as `() => x`, which has no block to splice into. */
function hasExpressionBody(node: InstrumentableNode): node is ts.ArrowFunction {
  return ts.isArrowFunction(node) && !ts.isBlock(node.body);
}

// depug records 1-based line and column, matching the position an editor
// shows a human. TypeScript's own API is 0-based for both.
function toLineColumn(sourceFile: ts.SourceFile, pos: number): { line: number; column: number } {
  const lc = sourceFile.getLineAndCharacterOfPosition(pos);
  return { line: lc.line + 1, column: lc.character + 1 };
}

let counter = 0;
function freshId(): string {
  counter += 1;
  return `d${counter}`;
}

/**
 * Rewrites `source` so every function with a body reports its entry
 * and exit through the global `__depug` collector, and every `await`
 * inside such a function reports suspend before it and resume after it,
 * through the same collector. `fileId` becomes the path component of each
 * function's id (`fileId:name@line:col#`); the runtime collector appends
 * the call count to form `path:name@line:col#k`.
 *
 * The declaration position belongs in the id because a name does not tell
 * two JavaScript functions apart. Instrumenting one real codebase
 * (honojs/hono at one pinned commit) found 1159 functions, 407 of them
 * anonymous; under a name-only id, 513 of them -- 44.3% -- would have
 * shared an id with at least one other function, the worst case being 28
 * functions on one id. A shared id means a shared call counter, so `#k`
 * would address a different call on a rerun. The position costs nothing
 * extra: the transform already measures it for the event payload.
 *
 * The exit report fires through a try/catch/finally wrapped around the
 * function's original body, not one insertion per `return`/`throw`
 * statement. A per-statement insertion would miss an exception thrown by a
 * callee (no `throw` statement of the function's own to attach to), which
 * would leave an entry event with no matching exit. finally always runs
 * exactly once, whichever of return, throw, or fall-through the body took,
 * so entry and exit stay 1:1 without control-flow analysis.
 *
 * An `await` reports through the call id of the nearest enclosing
 * instrumented function: the `const <callVar>` that function's own entry
 * insertion declares is visible, lexically, to every `await` its body's
 * try-block wraps, including one inside a nested expression, so no
 * separate mechanism is needed to carry that id down to the `await`. An
 * `await` with no enclosing instrumented function at all (module
 * top-level `await`) is left untouched: there is no call id to report it
 * against.
 */
export function instrumentSource(source: string, fileId: string): InstrumentResult {
  const sourceFile = ts.createSourceFile(fileId, source, ts.ScriptTarget.Latest, true);
  const insertions: Insertion[] = [];
  const functions: InstrumentedFunction[] = [];
  const callStack: CallFrame[] = [];

  function visit(node: ts.Node): void {
    if (isInstrumentableFunction(node)) {
      const { name, line, column, id } = functionIdentity(node, sourceFile, fileId);
      const idPrefix = `${id}#`;
      functions.push({ name, idPrefix, line, column });

      const idLiteral = JSON.stringify(idPrefix);
      const callVar = `__depug_call_${freshId()}`;
      const kindVar = `__depug_kind_${freshId()}`;
      const errVar = `__depug_err_${freshId()}`;

      const enterText = `const ${callVar}=__depug.enter(${idLiteral},${line},${column});let ${kindVar}="return";try{`;
      const exitText = `}catch(${errVar}){${kindVar}="throw";throw ${errVar};}finally{__depug.exit(${idLiteral},${line},${column},${kindVar},${callVar});}`;

      if (hasExpressionBody(node)) {
        // `(p) => expr` becomes `(p) => {<enter>return expr<exit>}`. The
        // arrow keeps its own line breaks, because the expression itself
        // is not moved and both inserted strings are newline-free. An
        // arrow written this way is 316 of hono's 1191 function-like
        // nodes at one pinned commit, so leaving it out would drop more
        // than a quarter of that codebase's functions from every index.
        const body = node.body as ts.Expression;
        insertions.push({
          offset: body.getStart(sourceFile),
          text: `{${enterText}return `,
          boundary: "start",
          order: insertions.length,
        });
        insertions.push({
          offset: body.end,
          text: `${exitText}}`,
          boundary: "end",
          order: insertions.length,
        });
      } else {
        const body = node.body as ts.Block;
        const openBrace = body.getStart(sourceFile);
        const closeBrace = body.end - 1;
        // A body with nothing between its braces (`{}`) puts the entry and
        // exit insertion points at the same offset: `openBrace + 1` and
        // `body.end - 1` both land on the sole position between the two
        // braces. Two insertions at one offset make their relative order
        // depend on how the array is sorted before splicing, which is not
        // an invariant this code should lean on. A single merged insertion
        // at that one offset sidesteps the ordering question entirely:
        // there is only one string to place, so there is nothing left to
        // order. An empty body has no `await` in it, so this case never
        // competes with one of the ties the sort below resolves.
        if (closeBrace === openBrace + 1) {
          insertions.push({ offset: openBrace + 1, text: enterText + exitText, boundary: "start", order: insertions.length });
        } else {
          insertions.push({ offset: openBrace + 1, text: enterText, boundary: "start", order: insertions.length });
          insertions.push({ offset: closeBrace, text: exitText, boundary: "end", order: insertions.length });
        }
      }

      callStack.push({ callVar, idLiteral });
      return;
    }

    if (ts.isAwaitExpression(node)) {
      const frame = callStack[callStack.length - 1];
      if (frame !== undefined) {
        const { line, column } = toLineColumn(sourceFile, node.getStart(sourceFile));
        // Wraps `await x` as `resume(id,line,col,call,(suspend(id,line,col,call),await x))`,
        // never `(suspend(...),resume(...,await x))`: a leading `(` at the
        // start of a statement can re-parse the previous line's expression
        // as a call on it when that line has no trailing semicolon
        // (`f()\nawait g()` becomes `f()(...)`, still valid syntax, so the
        // corpus test's parse-diagnostic count would not catch it). A
        // leading identifier cannot extend a previous statement this way,
        // so `resume` goes first. Argument evaluation order (left to
        // right) keeps the effect identical: `suspend` still fires before
        // `await x` runs, and `resume` still fires, with `x`'s resolved
        // value, only after it resumes -- `resume` returns that value
        // unchanged, so wrapping `await x` this way does not change what
        // the expression evaluates to.
        const prefix = `__depug.resume(${frame.idLiteral},${line},${column},${frame.callVar},(__depug.suspend(${frame.idLiteral},${line},${column},${frame.callVar}),`;
        insertions.push({ offset: node.getStart(sourceFile), text: prefix, boundary: "start", order: insertions.length });
        insertions.push({ offset: node.end, text: "))", boundary: "end", order: insertions.length });
      }
    }

  }

  // The frame an instrumented function pushed is popped once its own
  // children have been walked, which is what the recursion used to do on
  // the way back out.
  forEachNode(
    sourceFile,
    visit,
    (node) => {
      if (isInstrumentableFunction(node)) callStack.pop();
    },
  );

  // Apply from the highest offset down so an earlier insertion never shifts
  // the offset a later insertion targets. Nested functions and `await`s
  // are always fully contained inside their enclosing function's body, so
  // this single global sort is enough regardless of nesting depth.
  //
  // Two insertions can still land on the very same offset: a function
  // whose body's first character is `await`, with no space in between
  // (`{await x}`), puts its own entry insertion and that `await`'s prefix
  // insertion at the same offset; the mirror case (`await x}`, nothing
  // between the operand and the closing brace) does the same for the exit
  // insertion and the `await`'s suffix; and `await await x`, nothing after
  // the inner `await`'s operand, gives both `await`s the same end offset.
  // Splicing applies the highest offset first, so within one offset the
  // *last*-processed insertion ends up leftmost in the final text (each
  // later splice at that same offset lands right where the previous one
  // started, pushing it rightward). A "start" pair (an entry insertion, or
  // an await-wrapper's prefix) needs the *outer* construct leftmost -- its
  // ties sort by descending `order`, so the inner one (pushed later, in
  // this walk's pre-order) is processed first and the outer one last. An
  // "end" pair needs the *inner* construct leftmost, closed before its
  // enclosing one -- its ties sort by ascending `order`, the reverse
  // direction. Getting the "start" case wrong is not a syntax error (the
  // corpus test's diagnostic count cannot see it): it reorders a `const`
  // declaration after code that reads it, a TDZ error only a run of the
  // instrumented code itself would catch.
  //
  // A "start" insertion and an "end" insertion never tie at the same
  // offset for the two node kinds this transform inserts around: an
  // `await`'s own start can only coincide with an enclosing function's
  // open-brace offset (both "start"), and its own end can only coincide
  // with an enclosing function's close-brace offset or another `await`'s
  // end (both "end").
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

  return { code, functions };
}
