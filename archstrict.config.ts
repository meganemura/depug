import type { Config } from "./archstrict.types.js";

// Public surface: other modules may import a directory module only through
// its own surface file (named by `surface` below), or through the files its own
// package.json exports map names. An import that reaches any other file in
// the directory is a violation. A directory module with no such file is
// entirely private. A module whose glob names one file is that file, so its
// entry names the file itself as its surface.
export default {
  schemaVersion: 1,
  surface: ["index.ts", "index.tsx", "index.mts", "index.cts"],
  // Kept out of analysis entirely:
  // - archstrict's own two files, which are never module content;
  // - hidden directories at any depth (.git, tool state), which tsc's own
  //   default include also skips;
  // - common noise directories that init found on disk (test, fixtures).
  //   Remove one of these entries if that directory holds module content.
  //   A test file imports across modules as a fixture, and boundary rules
  //   read production code.
  // - tmp and coverage. A checkout that has run a corpus or a coverage
  //   report holds TypeScript under those trees, and one file there is an
  //   uncovered-module (measured: tmp/corpus/noise.ts and coverage/noise.ts
  //   each fired the rule). dist and node_modules are already outside the
  //   walk, so they are not listed.
  exclude: [
    "archstrict.config.ts",
    "archstrict.types.ts",
    ".*/**",
    "**/.*/**",
    "test/**",
    "fixtures/**",
    "tmp/**",
    "coverage/**",
  ],
  // init declared one module per directory that holds TypeScript source and
  // one per TypeScript source file, so every file that check analyzes
  // belongs to exactly one module. src/ is flat apart from src/verbs, so
  // the file modules stay. verbs is the directory: its surface is the files
  // the CLI imports. probe-config.ts, exec-wrapper-config.ts, and
  // flt-wrapper-config.ts stay private inside that directory. The failure
  // text imports the rerun prefix from rerun-guard.ts, below the verb.
  // init never rewrites this file. After an edit, run archstrict init to
  // regenerate archstrict.types.ts.
  declaredModules: [
    // Each directory and TypeScript source file directly in src/.
    { name: "ast-walk.ts", glob: "src/ast-walk.ts", surface: "ast-walk.ts" },
    { name: "cli.ts", glob: "src/cli.ts", surface: "cli.ts" },
    { name: "code-state.ts", glob: "src/code-state.ts", surface: "code-state.ts" },
    { name: "collector.ts", glob: "src/collector.ts", surface: "collector.ts" },
    { name: "declared-type.ts", glob: "src/declared-type.ts", surface: "declared-type.ts" },
    { name: "evidence.ts", glob: "src/evidence.ts", surface: "evidence.ts" },
    { name: "exec-plugin.ts", glob: "src/exec-plugin.ts", surface: "exec-plugin.ts" },
    { name: "exec-runtime.ts", glob: "src/exec-runtime.ts", surface: "exec-runtime.ts" },
    { name: "exec-setup.ts", glob: "src/exec-setup.ts", surface: "exec-setup.ts" },
    { name: "exec-transform.ts", glob: "src/exec-transform.ts", surface: "exec-transform.ts" },
    { name: "fid.ts", glob: "src/fid.ts", surface: "fid.ts" },
    { name: "flt-collector.ts", glob: "src/flt-collector.ts", surface: "flt-collector.ts" },
    { name: "flt-plugin.ts", glob: "src/flt-plugin.ts", surface: "flt-plugin.ts" },
    { name: "flt-render.ts", glob: "src/flt-render.ts", surface: "flt-render.ts" },
    { name: "flt-runtime.ts", glob: "src/flt-runtime.ts", surface: "flt-runtime.ts" },
    { name: "flt-setup.ts", glob: "src/flt-setup.ts", surface: "flt-setup.ts" },
    { name: "flt-transform.ts", glob: "src/flt-transform.ts", surface: "flt-transform.ts" },
    { name: "function-identity.ts", glob: "src/function-identity.ts", surface: "function-identity.ts" },
    { name: "function-range.ts", glob: "src/function-range.ts", surface: "function-range.ts" },
    { name: "include.ts", glob: "src/include.ts", surface: "include.ts" },
    { name: "index.ts", glob: "src/index.ts", surface: "index.ts" },
    { name: "node-test-hook.ts", glob: "src/node-test-hook.ts", surface: "node-test-hook.ts" },
    { name: "node-test-reporter.ts", glob: "src/node-test-reporter.ts", surface: "node-test-reporter.ts" },
    { name: "observed-shape.ts", glob: "src/observed-shape.ts", surface: "observed-shape.ts" },
    { name: "plugin.ts", glob: "src/plugin.ts", surface: "plugin.ts" },
    { name: "probe-plugin.ts", glob: "src/probe-plugin.ts", surface: "probe-plugin.ts" },
    { name: "probe-runtime.ts", glob: "src/probe-runtime.ts", surface: "probe-runtime.ts" },
    { name: "probe-setup.ts", glob: "src/probe-setup.ts", surface: "probe-setup.ts" },
    { name: "probe-transform.ts", glob: "src/probe-transform.ts", surface: "probe-transform.ts" },
    { name: "reporter.ts", glob: "src/reporter.ts", surface: "reporter.ts" },
    { name: "rerun-guard.ts", glob: "src/rerun-guard.ts", surface: "rerun-guard.ts" },
    { name: "runner.ts", glob: "src/runner.ts", surface: "runner.ts" },
    { name: "runtime.ts", glob: "src/runtime.ts", surface: "runtime.ts" },
    { name: "setup.ts", glob: "src/setup.ts", surface: "setup.ts" },
    { name: "shape-report.ts", glob: "src/shape-report.ts", surface: "shape-report.ts" },
    { name: "sibling.ts", glob: "src/sibling.ts", surface: "sibling.ts" },
    { name: "stack-parse.ts", glob: "src/stack-parse.ts", surface: "stack-parse.ts" },
    { name: "stack.ts", glob: "src/stack.ts", surface: "stack.ts" },
    { name: "tool-version.ts", glob: "src/tool-version.ts", surface: "tool-version.ts" },
    { name: "transform.ts", glob: "src/transform.ts", surface: "transform.ts" },
    {
      name: "verbs",
      glob: "src/verbs/**",
      // cli.ts imports each verb. The failure text imports the guard from
      // rerun-guard.ts, not from this directory. probe-config.ts,
      // exec-wrapper-config.ts, and flt-wrapper-config.ts are reached only
      // from their own verb, so they are not on this list.
      surface: ["exec.ts", "flt.ts", "frames.ts", "preflight.ts", "probe.ts", "rerun.ts"],
    },
    { name: "wrapper-config.ts", glob: "src/wrapper-config.ts", surface: "wrapper-config.ts" },
    // Each other top-level directory that holds TypeScript source, and each top-level TypeScript source file.
    { name: "bin", glob: "bin/**" },
    { name: "vitest.config.ts", glob: "vitest.config.ts", surface: "vitest.config.ts" },
  ],
  because:
    "src is flat apart from src/verbs, so each source file is its own module and verbs is the directory. The verb surface is the files the CLI imports. rerun-guard.ts holds the prefix the failure text prints; moving it out of the verb removed the one frozen cycle evidence.ts -> verbs -> evidence.ts, and the verbs still import the schema from evidence.ts. probe-config.ts, exec-wrapper-config.ts, and flt-wrapper-config.ts stay private inside verbs. The exec and flt generators co-changed with verbs on every one of their own commits (3 of 3, and 4 of 4) and nothing outside verbs imported them. wrapper-config.ts remains the shared generator: its fan-in was cli, verbs, and those two files.",
} satisfies Config;
