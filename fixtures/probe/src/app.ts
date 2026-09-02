// Correctly typed, compiles clean, and still hands its caller the wrong
// shape: JSON.parse returns any, and the cast asserts without testing.
export interface User {
  email: string;
  id: number;
}

export function parseUser(raw: string): User {
  return JSON.parse(raw) as User;
}

export function idOf(user: User): number {
  return user.id;
}
