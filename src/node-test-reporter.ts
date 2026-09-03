// The always-on layer for `node --test`.
//
// Same job as src/reporter.ts and the same files on the other side: one
// evidence file per failed test, and two printed lines pointing at it.
// What differs is the shape of what the runner hands over, and three
// things about node:test decide this file's contents.
//
// A failing test makes its enclosing describe fail too, so a suite emits
// its own `test:fail` carrying "1 subtest failed". Those are rollups, not
// failures, and writing evidence for one would put a file in the run
// directory that names no test's own error.
//
// The real error arrives wrapped: node:test reports `ERR_TEST_FAILURE`
// and puts what the test actually threw in `cause`.
//
// And `--test-name-pattern` matches each test's own name rather than its
// full path, so a rerun command cannot name one nested test exactly. The
// printed command says so instead of pretending otherwise.
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { readCodeState } from "./code-state.ts";
import {
  DEFAULT_LIMITS,
  SCHEMA_VERSION,
  buildSnapError,
  evidenceFileName,
  linkLatest,
  runDirName,
  writeJson,
  writeRunIndex,
  type IndexEntry,
  type SnapEvidence,
} from "./evidence.ts";
import { parseStack } from "./stack-parse.ts";
import { hasProducerFrame, toEvidenceFrames } from "./stack.ts";
import { toolVersion } from "./tool-version.ts";

interface TestFailEvent {
  type: string;
  data?: {
    name?: string;
    file?: string;
    nesting?: number;
    details?: { error?: { failureType?: string; cause?: Error } };
  };
}

const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * The command that runs this test again.
 *
 * node:test matches the pattern against a test's own name, not against the
 * names of the suites around it, and repeating the flag widens the
 * selection rather than narrowing it (measured on Node v26.7.0). So this
 * anchors the leaf name and nothing more: it selects the named test, and
 * any same-named test elsewhere in the file.
 */
export function buildNodeRerunCommand(testFile: string, testName: string): string {
  const pattern = `^${testName.replace(REGEX_METACHARACTERS, "\\$&")}$`;
  return `node --test --test-name-pattern=${JSON.stringify(pattern)} ${JSON.stringify(testFile)}`;
}

function guidance(producerPresent: boolean, frameCount: number): string {
  if (frameCount === 0) return "no frames were recorded for this failure";
  if (producerPresent) return "the failing call is in these frames";
  return "the value's source already returned; rerun to reach it";
}

/**
 * A node:test reporter. Point `--test-reporter` at this module.
 *
 * It writes only; it prints nothing about passing tests, so a project can
 * keep its own reporter alongside by naming both.
 */
export default async function* depugNodeReporter(
  source: AsyncIterable<TestFailEvent>,
): AsyncGenerator<string> {
  const root = process.env.DEPUG_ROOT ?? process.cwd();
  const outputDir = process.env.DEPUG_OUTPUT_DIR ?? join(root, "tmp", "depug");
  const runDir = join(outputDir, runDirName(new Date(), process.pid));
  const enabled = process.env.DEPUG_DISABLE !== "1";
  const entries: IndexEntry[] = [];
  let ordinal = 0;

  for await (const event of source) {
    if (!enabled) continue;

    if (event.type === "test:summary") {
      if (entries.length > 0) {
        writeRunIndex(runDir, entries);
        if (existsSync(runDir)) linkLatest(outputDir, runDir);
      }
      continue;
    }

    if (event.type !== "test:fail") continue;
    const data = event.data;
    const error = data?.details?.error;
    // A suite fails because something inside it did. Its rollup names no
    // error of its own.
    if (!error || error.failureType === "subtestsFailed") continue;

    const cause = error.cause;
    const limits = DEFAULT_LIMITS;
    const allFrames = toEvidenceFrames(parseStack(cause?.stack), root, Number.MAX_SAFE_INTEGER);
    const frames = allFrames.slice(0, limits.max_frames);
    const testFile = data?.file ? relative(root, data.file) : null;
    const testName = data?.name ?? null;
    const ownFrame = [...frames].reverse().find((f) => f.path === testFile);

    const evidence: SnapEvidence = {
      schema_version: SCHEMA_VERSION,
      kind: "snap",
      tool: { name: "depug", version: toolVersion() },
      captured_at: `${new Date().toISOString().slice(0, 19)}Z`,
      capture_mode: "failure_text",
      code_state: readCodeState(root),
      test: { framework: "node:test", name: testName, file: testFile, line: ownFrame?.line ?? null },
      error: buildSnapError(
        String(cause?.name ?? "Error"),
        String(cause?.message ?? ""),
        String(cause?.stack ?? ""),
        limits,
      ),
      frames,
      rerun_command: testFile && testName ? buildNodeRerunCommand(testFile, testName) : null,
      // node:test orders tests deterministically and takes no seed.
      seed: null,
      limits,
    };
    if (allFrames.length > frames.length) evidence.frames_omitted = allFrames.length - frames.length;

    ordinal += 1;
    const fileName = evidenceFileName(ordinal, testName);
    const filePath = join(runDir, fileName);
    writeJson(filePath, evidence);
    entries.push({
      path: fileName,
      test: evidence.test,
      error: { name: evidence.error.name, message: evidence.error.message },
    });

    const note = guidance(hasProducerFrame(frames, testFile), frames.length);
    yield `\ndepug evidence: ${filePath} (${note})\n`;
    if (evidence.rerun_command) yield `depug rerun: ${evidence.rerun_command}\n`;
  }
}
