// Which test runner a command starts, and how depug loads itself into it.
//
// The two runners need different setup and no different instrumentation.
// vitest owns the transform step through a config, so a verb generates one
// and passes `--config`. Node owns it through `module.registerHooks`, so a
// verb sets `NODE_OPTIONS` and passes the command through untouched.
//
// Detection reads the command rather than asking, because the command is
// the rerun line the failure already printed and retyping a flag onto it
// is friction with no information in it. `--runner` overrides where a
// command is ambiguous.
import { siblingPath } from "./sibling.ts";

export type Runner = "vitest" | "node";

/**
 * Reads the runner out of a command.
 *
 * `node --test` and `--test-reporter` name node:test directly. Anything
 * else is vitest, which is the runner v0.1 supports fully and the one a
 * project reaching for depug is most likely to have.
 */
export function detectRunner(command: readonly string[]): Runner {
  for (const arg of command) {
    if (arg === "--test" || arg.startsWith("--test=")) return "node";
    if (arg.startsWith("--test-reporter")) return "node";
    if (arg.includes("node:test")) return "node";
  }
  return "vitest";
}

/** Absolute path of the module `NODE_OPTIONS` preloads for node:test. */
export function nodeTestHookPath(): string {
  return siblingPath("node-test-hook", import.meta.url);
}

/**
 * Adds the preload to an existing `NODE_OPTIONS`, keeping whatever a
 * project already put there. Replacing it would drop settings a suite
 * needs to run at all.
 */
export function withNodeTestHook(existing: string | undefined): string {
  const preload = `--import ${JSON.stringify(nodeTestHookPath())}`;
  return existing && existing.trim() !== "" ? `${existing} ${preload}` : preload;
}
