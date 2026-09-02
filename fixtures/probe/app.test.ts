import { expect, it } from "vitest";
import { idOf, parseUser } from "./src/app.ts";

// Three of the five payloads omit email, and every id arrives as a string.
// The test passes: nothing here checks the shape, which is the point.
const PAYLOADS = [
  '{"id": "1"}',
  '{"email": "a@example.com", "id": "2"}',
  '{"id": "3"}',
  '{"email": "b@example.com", "id": "4"}',
  '{"id": "5"}',
];

it("parses every payload without noticing the shape", () => {
  const users = PAYLOADS.map((raw) => parseUser(raw));
  expect(users).toHaveLength(5);
  expect(idOf(users[0])).toBe("1");
});
