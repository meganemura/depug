// Four places where a TypeScript annotation stops being a claim about the
// value that actually arrives: JSON.parse, an `as` cast, process.env, and
// an `any` parameter. Each function below is correctly typed and compiles
// clean; each one can still hand its caller a value of a different shape.
// The fixture exists so a test can run these paths and compare what came
// through against what the declaration promised.

export interface User {
  email: string;
  id: number;
}

/** `JSON.parse` returns `any`, so the cast is unchecked at runtime. */
export function parseUser(raw: string): User {
  return JSON.parse(raw) as User;
}

/**
 * `process.env.X` is `string | undefined`; the cast erases the undefined
 * half, and an unset variable then flows on as if it were a string.
 */
export function envValue(name: string): string {
  return process.env[name] as string;
}

/** An `any` parameter lets any value through to a typed return. */
export function fromAny(value: any): User {
  return value;
}

/** The consumer. Its parameter is where the wrong shape lands. */
export function greetUser(user: User): string {
  return `hello, ${user.email}`;
}
