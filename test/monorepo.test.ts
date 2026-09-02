// A repository split into vitest projects.
//
// This is the shape that silently produced nothing. vitest does not apply
// a root config's `plugins` to a project's own config, so a wrapper that
// merged into the root reached none of the code under test, and depug
// reported it as an include path matching no files -- sending a reader to
// fix the one thing that was not wrong.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { declaresProjects, findEnclosingProjectConfig } from "../src/wrapper-config.ts";
import { runFrames } from "../src/verbs/frames.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/monorepo", import.meta.url));
const VITEST_BIN = fileURLToPath(new URL("../node_modules/.bin/vitest", import.meta.url));

describe("finding the project that owns the code", () => {
  it("recognises a config that splits the run into projects", () => {
    expect(declaresProjects(`${FIXTURE}/vitest.config.ts`)).toBe(true);
    expect(declaresProjects(`${FIXTURE}/packages/app/vitest.config.ts`)).toBe(false);
  });

  it("finds the package's own config, not the root's", () => {
    const found = findEnclosingProjectConfig(`${FIXTURE}/packages/app/src`, FIXTURE);
    expect(found?.configPath).toBe(`${FIXTURE}/packages/app/vitest.config.ts`);
    // The project's root has to be its own directory, or every relative
    // path in its config resolves from the wrong place.
    expect(found?.root).toBe(`${FIXTURE}/packages/app`);
  });

  it("stops at the working directory rather than escaping it", () => {
    expect(findEnclosingProjectConfig(FIXTURE, FIXTURE)).toBeUndefined();
  });
});

describe("a verb against a project-split repository", () => {
  it("reaches the code, and leaves the project's own settings working", () => {
    const result = runFrames({
      command: [VITEST_BIN, "run"],
      cwd: FIXTURE,
      includePathPrefix: `${FIXTURE}/packages/app/src`,
    });

    const records = readFileSync(result.files[0], "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));

    const calls = records.filter((r) => r.type === "call");
    expect(calls.map((c) => c.fid)).toEqual(["packages/app/src/app.ts:total@1:17#1"]);
    expect(calls[0].test).toBe("counts rows inside a project");

    // The fixture's own test asserts that its project config's relative
    // setupFiles entry ran, so a passing child means the wrapper did not
    // move the project out from under its own paths.
    expect(result.envelope.exit_status).toBe(0);
  }, 120_000);
});

describe("projects written inline in the root config", () => {
  // The other shape. There is no per-package config to extend, so the
  // wrapper rewrites each inline project to carry the plugin instead.
  const INLINE = fileURLToPath(new URL("../fixtures/monorepo-inline", import.meta.url));

  it("reaches code in a project that has no config file of its own", () => {
    expect(findEnclosingProjectConfig(`${INLINE}/packages/app/src`, INLINE)).toBeUndefined();

    const result = runFrames({
      command: [VITEST_BIN, "run"],
      cwd: INLINE,
      includePathPrefix: `${INLINE}/packages/app/src`,
    });

    const calls = readFileSync(result.files[0], "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line))
      .filter((r) => r.type === "call");

    expect(calls.map((c) => c.fid)).toEqual(["packages/app/src/app.ts:double@1:17#1"]);
    expect(result.envelope.exit_status).toBe(0);
  }, 120_000);
});
