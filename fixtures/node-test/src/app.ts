// A project using Node's own test runner, with no vitest anywhere. The
// same instrumentation reaches it, because depug rewrites TypeScript
// before it runs and Node owns that step through module.registerHooks.
export function total(rows: number[]): number {
  return rows.length;
}

export function explode(): never {
  throw new Error("boom from app code");
}
