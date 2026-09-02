// Two ways a test fails. In the first, the function that produced the
// wrong value has already returned before the assertion runs, so its
// frame is gone. In the second, the error propagates out of app code and
// that frame is still on the stack.
export function total(rows: number[]): number {
  return rows.length;
}

export function explode(): never {
  throw new Error("boom from app code");
}
