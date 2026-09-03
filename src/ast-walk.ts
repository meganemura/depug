// Walking a TypeScript AST without spending a JavaScript frame per level.
//
// Every rewrite here walks the tree, and each one used to do it by
// recursion. A recursive descent costs one frame per AST level, and a long
// binary expression is one level per term: measured on this machine, a
// chain of about 3000 terms exhausted the stack and took the whole run
// down with it. That shape is rare in code a person writes and ordinary in
// code a program wrote, and the always-on rewrite meets every file in a
// project.
//
// The walk lives here rather than in each rewrite for the reason the
// naming rule does: five copies of a traversal are five places for one of
// them to stop matching the others.
import ts from "typescript";

/** Returned from `visit` to leave a node's children unvisited. */
export const SKIP = "skip" as const;

type Work = { node: ts.Node; entered: boolean };

/**
 * Visits every node under `root`, in source order, parents before
 * children.
 *
 * `visit` returning `SKIP` leaves that node's children alone, which is how
 * a walk stops at a nested function's boundary. `leave` runs after a
 * node's children, and only for a node whose children were visited, so a
 * caller can keep a stack in step with the descent.
 */
export function forEachNode(
  root: ts.Node,
  visit: (node: ts.Node) => typeof SKIP | void,
  leave?: (node: ts.Node) => void,
): void {
  const pending: Work[] = [{ node: root, entered: false }];

  while (pending.length > 0) {
    const item = pending.pop()!;
    if (item.entered) {
      leave?.(item.node);
      continue;
    }

    if (visit(item.node) === SKIP) continue;
    if (leave) pending.push({ node: item.node, entered: true });

    const children: ts.Node[] = [];
    ts.forEachChild(item.node, (child) => {
      children.push(child);
    });
    // Reversed, so popping yields them in source order: several rewrites
    // number their insertions by the order the walk produced them.
    for (let i = children.length - 1; i >= 0; i--) {
      pending.push({ node: children[i], entered: false });
    }
  }
}
