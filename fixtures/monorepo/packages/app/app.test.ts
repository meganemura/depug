import { expect, it } from "vitest";
import { total } from "./src/app.ts";

it("counts rows inside a project", () => {
  expect((globalThis as { __APP_SETUP_RAN__?: boolean }).__APP_SETUP_RAN__).toBe(true);
  expect(total([1, 2, 3])).toBe(3);
});
