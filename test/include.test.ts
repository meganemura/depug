// Checks where the application boundary comes from and what it counts.
//
// The precedence and the count both decide what a reader sees on `calls:
// 0`, so each case builds its own directory rather than trusting the one
// this file sits in. The prefix-boundary case exists because `src` and
// `srcx` share a prefix as strings and not as directories.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  countCandidates,
  isUnderAny,
  readPackageInclude,
  resolveIncludes,
  testFileIn,
} from "../src/include.ts";

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "depug-include-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe("resolveIncludes", () => {
  it("falls back to src when nothing names a boundary", () => {
    const root = project({ "package.json": JSON.stringify({ name: "x" }) });
    try {
      expect(resolveIncludes(root, [])).toEqual({ prefixes: [resolve(root, "src")], source: "default" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads depug.include from package.json as one path or a list", () => {
    const one = project({ "package.json": JSON.stringify({ depug: { include: "cli" } }) });
    const many = project({ "package.json": JSON.stringify({ depug: { include: ["cli", "viewer/lib"] } }) });
    try {
      expect(resolveIncludes(one, [])).toEqual({ prefixes: [resolve(one, "cli")], source: "package.json" });
      expect(resolveIncludes(many, [])).toEqual({
        prefixes: [resolve(many, "cli"), resolve(many, "viewer/lib")],
        source: "package.json",
      });
    } finally {
      rmSync(one, { recursive: true, force: true });
      rmSync(many, { recursive: true, force: true });
    }
  });

  it("lets the flag win over package.json, keeping every occurrence", () => {
    const root = project({ "package.json": JSON.stringify({ depug: { include: ["cli"] } }) });
    try {
      expect(resolveIncludes(root, ["a", "b/c"])).toEqual({
        prefixes: [resolve(root, "a"), resolve(root, "b/c")],
        source: "flag",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a missing, unreadable, or malformed field as absent", () => {
    const none = project({});
    const broken = project({ "package.json": "{not json" });
    const wrongType = project({ "package.json": JSON.stringify({ depug: { include: 42 } }) });
    const empties = project({ "package.json": JSON.stringify({ depug: { include: ["", 3, "ok"] } }) });
    try {
      expect(readPackageInclude(none)).toEqual([]);
      expect(readPackageInclude(broken)).toEqual([]);
      expect(readPackageInclude(wrongType)).toEqual([]);
      expect(readPackageInclude(empties)).toEqual(["ok"]);
    } finally {
      for (const r of [none, broken, wrongType, empties]) rmSync(r, { recursive: true, force: true });
    }
  });
});

describe("countCandidates", () => {
  it("counts TypeScript files that are not tests, skipping node_modules", () => {
    const root = project({
      "src/a.ts": "",
      "src/deep/b.tsx": "",
      "src/a.test.ts": "",
      "src/b.spec.tsx": "",
      "src/c.js": "",
      "src/node_modules/dep/index.ts": "",
    });
    try {
      expect(countCandidates(join(root, "src"))).toBe(2);
      expect(countCandidates(join(root, "nowhere"))).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isUnderAny", () => {
  it("matches on directory boundaries, not on string prefixes", () => {
    expect(isUnderAny("/p/src/a.ts", ["/p/src"])).toBe(true);
    expect(isUnderAny("/p/src", ["/p/src"])).toBe(true);
    expect(isUnderAny("/p/srcx/a.ts", ["/p/src"])).toBe(false);
    expect(isUnderAny("/p/lib/a.ts", ["/p/src", "/p/lib"])).toBe(true);
  });
});

describe("testFileIn", () => {
  it("returns the first argument that is an existing TypeScript file", () => {
    const root = project({ "tests/x.test.ts": "", "src/a.ts": "" });
    try {
      const command = ["npx", "vitest", "run", "tests/x.test.ts", "-t", "^name$"];
      expect(testFileIn(command, root)).toBe(resolve(root, "tests/x.test.ts"));
      expect(testFileIn(["node", "--test"], root)).toBeUndefined();
      expect(testFileIn(["vitest", "run", "missing.ts"], root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
