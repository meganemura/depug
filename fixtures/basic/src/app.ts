export function addOne(x: number): number {
  return x + 1;
}

export function greet(name: string): string {
  if (name.length === 0) {
    throw new Error("empty name");
  }
  return `hello, ${name}`;
}

// Padding so the next function declares past line 10, on purpose: it
// checks a position measured far from the top of the file, not just line 1.
export function withCleanup(value: number): number {
  let doubled = 0;
  try {
    doubled = value * 2;
    return doubled;
  } finally {
    doubled = -1;
  }
}

// Empty bodies: an arrow, a function, and a method, each with nothing
// between its braces. That makes the enter and exit insertion points land
// on the same offset, a case the transform must still produce valid,
// runnable code for.
export const emptyArrow = () => {};

export function emptyFunction() {}

export class EmptyMethodHolder {
  emptyMethod() {}
}

// A class, an expression-bodied arrow, and an accessor: each has a body
// that runs, and each reports under its own name.
export const double = (n: number): number => n * 2;

export class Counter {
  #value: number;
  constructor(start: number) {
    this.#value = start;
  }
  get value(): number {
    return this.#value;
  }
  set value(next: number) {
    this.#value = next;
  }
}
