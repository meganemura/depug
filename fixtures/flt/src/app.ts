// Exercises the three shapes test/flt.test.ts checks against a real
// vitest run: branches with a block-scoped local that must go out of
// scope, a loop long enough to fold, and a function that always throws.
export function classify(n: number): string {
  let label = "unknown";
  if (n > 0) {
    const sign = "positive";
    label = sign;
  } else if (n < 0) {
    const sign = "negative";
    label = sign;
  } else {
    label = "zero";
  }
  return label;
}

export function sumUntil(limit: number): number {
  let total = 0;
  for (let i = 0; i < limit; i++) {
    total += i;
  }
  return total;
}

export function explode(): never {
  throw new Error("boom");
}

// try and switch bodies. A trace that skipped these would look complete
// while saying nothing about what the function did between the braces.
export function guarded(n: number): string {
  let label = "start";
  try {
    label = "in-try";
    if (n < 0) {
      throw new Error("negative");
    }
  } catch {
    label = "in-catch";
  } finally {
    label = `${label}+finally`;
  }
  switch (n) {
    case 1:
      label = `${label}+one`;
      break;
    default:
      label = `${label}+other`;
  }
  return label;
}
