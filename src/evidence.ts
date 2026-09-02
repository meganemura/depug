// Writes the failure snapshots and the run index, and decides where they
// go.
//
// Files are depug's interface, so this module owns the layout the schema
// documents: one directory per run, one JSON file per failed test, an
// index beside them, and a `latest` symlink for the run that just
// finished. Nothing here reads a file back; the verbs that do that read
// what this module wrote.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CodeState } from "./code-state.ts";
import type { EvidenceFrame } from "./stack.ts";

export const SCHEMA_VERSION = 1;

export interface Limits {
  max_frames: number;
  max_value_length: number;
  max_elements: number;
  max_samples: number;
}

export const DEFAULT_LIMITS: Limits = {
  max_frames: 20,
  max_value_length: 200,
  max_elements: 10,
  max_samples: 10,
};

export interface SnapTest {
  framework: string;
  name: string | null;
  file: string | null;
  line: number | null;
}

export interface SnapError {
  name: string;
  message: string;
  message_truncated?: boolean;
  message_original_length?: number;
  stack: string;
}

export interface SnapEvidence {
  schema_version: number;
  kind: "snap";
  tool: { name: string; version: string };
  captured_at: string;
  capture_mode: "failure_text";
  code_state: CodeState;
  test: SnapTest;
  error: SnapError;
  frames: EvidenceFrame[];
  frames_omitted?: number;
  rerun_command: string | null;
  seed: number | null;
  limits: Limits;
}

/** A run directory name that sorts by time and stays unique per process. */
export function runDirName(now: Date, pid: number): string {
  const p = (n: number, width = 2): string => String(n).padStart(width, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `run-${stamp}-${pid}`;
}

/**
 * A file name for one failure: an ordinal so the directory reads in the
 * order the failures happened, and a slug of the test name so a reader
 * scanning the directory can find one without opening every file.
 */
export function evidenceFileName(ordinal: number, testName: string | null): string {
  const slug = (testName ?? "unnamed")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${String(ordinal).padStart(3, "0")}-${slug || "unnamed"}.json`;
}

function truncate(text: string, limit: number): Pick<SnapError, "message" | "message_truncated" | "message_original_length"> {
  if (text.length <= limit) return { message: text };
  return {
    message: text.slice(0, limit),
    message_truncated: true,
    message_original_length: text.length,
  };
}

export function buildSnapError(name: string, message: string, stack: string, limits: Limits): SnapError {
  // A failure message carries the comparison a reader needs, so it gets a
  // longer allowance than an ordinary captured value.
  return { name, ...truncate(message, limits.max_value_length * 5), stack };
}

export interface RerunInput {
  testFile: string;
  /**
   * The suite names enclosing the test, outermost first, and the test's
   * own name last.
   */
  namePath: readonly string[];
  seed: number | null;
}

const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * Builds the `-t` pattern that selects exactly one test.
 *
 * vitest matches `-t` as a regular expression against the test's full
 * name, with the enclosing suites joined by a space. Three things follow,
 * and each one was measured against vitest 4.1.11 rather than assumed:
 *
 * - The separator is a space. The " > " form a reporter prints for a human
 *   matches nothing at all.
 * - The name is escaped. A test called `handles a (paren)` is a regular
 *   expression that does not match its own name.
 * - The pattern is anchored. Without anchors, a test named `saves a draft`
 *   also selects `saves a draft and publishes it`, and the rerun quietly
 *   runs two tests where it claimed one.
 */
export function buildTestNamePattern(namePath: readonly string[]): string {
  const escaped = namePath.map((part) => part.replace(REGEX_METACHARACTERS, "\\$&")).join(" ");
  return `^${escaped}$`;
}

/**
 * The command that runs one test again. The seed is included only when the
 * run had one: adding `--sequence.seed` where the suite never set it would
 * put a value in the command that the original run did not use.
 */
export function buildRerunCommand({ testFile, namePath, seed }: RerunInput): string {
  const parts = [
    "npx",
    "vitest",
    "run",
    JSON.stringify(testFile),
    "-t",
    JSON.stringify(buildTestNamePattern(namePath)),
  ];
  if (seed !== null) parts.push(`--sequence.seed=${seed}`);
  return parts.join(" ");
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export interface IndexEntry {
  path: string;
  test: SnapTest;
  error: { name: string; message: string };
}

export function writeRunIndex(runDir: string, entries: IndexEntry[]): string {
  const path = join(runDir, "index.json");
  writeJson(path, { schema_version: SCHEMA_VERSION, run_dir: runDir, failures: entries });
  return path;
}

/**
 * Points `latest` at the run that just finished. A filesystem that refuses
 * symlinks leaves the run directories themselves untouched, so this fails
 * quietly rather than taking the run down with it.
 */
export function linkLatest(outputDir: string, runDir: string): void {
  const link = join(outputDir, "latest");
  try {
    rmSync(link, { force: true });
    symlinkSync(runDir, link, "dir");
  } catch {
    // The run directories carry a timestamp in their names, so a reader
    // can still find the newest one without this link.
  }
}
