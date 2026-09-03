// Checks the version depug stamps on evidence, from both layouts it runs
// in.
//
// The layouts are the whole point. depug runs from `src/` in a checkout
// and from `dist/src/` in an installed package, one level deeper, and the
// implementation this replaced counted `..` from the source layout. The
// installed copy then found no manifest, swallowed the read error, and
// reported a version nobody released. A test that only exercises the
// checkout passes on both the broken and the fixed code, so every case
// here builds the directory shape rather than trusting the one the test
// file happens to sit in.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { UNKNOWN, toolVersion } from "../src/tool-version.ts";
import packageManifest from "../package.json" with { type: "json" };

/** Builds `<root>/package.json` plus an empty module at `<root>/<depth>`. */
function layout(version: string | undefined, modulePath: string): { root: string; module: string } {
  const root = mkdtempSync(join(tmpdir(), "depug-version-"));
  if (version !== undefined) {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "host", version }));
  }
  const module = join(root, modulePath);
  mkdirSync(join(module, ".."), { recursive: true });
  writeFileSync(module, "");
  return { root, module };
}

describe("toolVersion", () => {
  it("reads the manifest beside a module in the source layout", () => {
    const { root, module } = layout("1.2.3", "src/reporter.ts");
    try {
      expect(toolVersion(pathToFileURL(module).href)).toBe("1.2.3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the manifest from the built layout, one level deeper", () => {
    const { root, module } = layout("1.2.3", "dist/src/reporter.js");
    try {
      expect(toolVersion(pathToFileURL(module).href)).toBe("1.2.3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads it from the deepest module the package ships", () => {
    const { root, module } = layout("1.2.3", "dist/src/verbs/probe.js");
    try {
      expect(toolVersion(pathToFileURL(module).href)).toBe("1.2.3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps walking past a directory that holds no manifest", () => {
    // `dist/` has none, which is the case that broke: the walk has to
    // treat a missing manifest as "not here" and not as "give up".
    const { root, module } = layout("4.5.6", "dist/src/verbs/probe.js");
    try {
      writeFileSync(join(root, "dist", "not-a-manifest.json"), "{}");
      expect(toolVersion(pathToFileURL(module).href)).toBe("4.5.6");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports UNKNOWN when no manifest sits above the module", () => {
    // Nested past the walk's limit, so whatever is higher up on the
    // machine running this cannot reach the answer.
    const { root, module } = layout(undefined, "a/b/c/d/e/f/g/h/i/module.js");
    try {
      expect(toolVersion(pathToFileURL(module).href)).toBe(UNKNOWN);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports this package's own version when called from its own modules", () => {
    expect(toolVersion()).toBe(packageManifest.version);
    expect(toolVersion()).not.toBe(UNKNOWN);
  });
});
