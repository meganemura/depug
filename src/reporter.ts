// The always-on layer: a vitest reporter that writes one evidence file for
// each failed test and prints where it went.
//
// The two printed lines are the whole onboarding path. An agent that has
// never heard of depug reads a failure, sees an absolute path and a
// command, and follows them. Nothing else has to be configured for that to
// work.
//
// The lines go straight to this reporter's own output rather than into the
// error's message. A reporter that edits a message depends on running
// before whichever reporter prints it, and that order is not something a
// project controls; writing directly does not care who else is registered.
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readCodeState } from "./code-state.ts";
import {
  DEFAULT_LIMITS,
  SCHEMA_VERSION,
  buildRerunCommand,
  buildSnapError,
  evidenceFileName,
  linkLatest,
  runDirName,
  writeJson,
  writeRunIndex,
  type IndexEntry,
  type SnapEvidence,
} from "./evidence.ts";
import { hasProducerFrame, toEvidenceFrames, type RunnerStackEntry } from "./stack.ts";

function toolVersion(): string {
  try {
    const pkg = fileURLToPath(new URL("../package.json", import.meta.url));
    return JSON.parse(readFileSync(pkg, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Names what the evidence file can answer, so a reader knows whether to
 * open it or to go straight to a rerun. The distinction is the one the
 * failure shapes divide on: whether the code that produced the value is
 * still on the stack.
 */
function guidance(producerPresent: boolean, frameCount: number): string {
  if (frameCount === 0) return "no frames were recorded for this failure";
  if (producerPresent) return "the failing call is in these frames";
  return "the value's source already returned; rerun to reach it";
}

interface ReporterOptions {
  outputDir?: string;
}

export default class DepugReporter {
  #root = process.cwd();
  #outputDir: string;
  #runDir = "";
  #seed: number | null = null;
  #ordinal = 0;
  #entries: IndexEntry[] = [];
  #enabled = process.env.DEPUG_DISABLE !== "1";
  #version = toolVersion();

  constructor(options: ReporterOptions = {}) {
    this.#outputDir = options.outputDir ?? process.env.DEPUG_OUTPUT_DIR ?? "";
  }

  onInit(ctx: { config?: { root?: string }; getSeed?: () => number | null }): void {
    if (!this.#enabled) return;
    this.#root = ctx.config?.root ?? process.cwd();
    if (this.#outputDir === "") this.#outputDir = join(this.#root, "tmp", "depug");
    this.#seed = ctx.getSeed?.() ?? null;
    this.#runDir = join(this.#outputDir, runDirName(new Date(), process.pid));
  }

  onTestCaseResult(testCase: {
    name?: string;
    fullName?: string;
    module?: { moduleId?: string };
    result?: () => { state?: string; errors?: readonly Record<string, unknown>[] } | undefined;
  }): void {
    if (!this.#enabled) return;
    const result = testCase.result?.();
    if (result?.state !== "failed") return;
    const rawError = result.errors?.[0];
    if (!rawError) return;

    const limits = DEFAULT_LIMITS;
    const stack = rawError.stacks as readonly RunnerStackEntry[] | undefined;
    const allFrames = toEvidenceFrames(stack, this.#root, Number.MAX_SAFE_INTEGER);
    const frames = allFrames.slice(0, limits.max_frames);
    const testFile = testCase.module?.moduleId ? relative(this.#root, testCase.module.moduleId) : null;
    const testName = testCase.fullName ?? testCase.name ?? null;

    // The test's own position is the last application frame in its file,
    // which is where the failing expression sits.
    const ownFrame = [...frames].reverse().find((f) => f.path === testFile);

    const evidence: SnapEvidence = {
      schema_version: SCHEMA_VERSION,
      kind: "snap",
      tool: { name: "depug", version: this.#version },
      captured_at: `${new Date().toISOString().slice(0, 19)}Z`,
      capture_mode: "failure_text",
      code_state: readCodeState(this.#root),
      test: {
        framework: "vitest",
        name: testName,
        file: testFile,
        line: ownFrame?.line ?? null,
      },
      error: buildSnapError(
        String(rawError.name ?? "Error"),
        String(rawError.message ?? ""),
        String(rawError.stack ?? ""),
        limits,
      ),
      frames,
      rerun_command:
        testFile && testName ? buildRerunCommand({ testFile, testName, seed: this.#seed }) : null,
      seed: this.#seed,
      limits,
    };
    if (allFrames.length > frames.length) evidence.frames_omitted = allFrames.length - frames.length;

    this.#ordinal += 1;
    const fileName = evidenceFileName(this.#ordinal, testName);
    const filePath = join(this.#runDir, fileName);
    writeJson(filePath, evidence);
    this.#entries.push({
      path: fileName,
      test: evidence.test,
      error: { name: evidence.error.name, message: evidence.error.message },
    });

    const note = guidance(hasProducerFrame(frames, testFile), frames.length);
    process.stdout.write(`\ndepug evidence: ${filePath} (${note})\n`);
    if (evidence.rerun_command) process.stdout.write(`depug rerun: ${evidence.rerun_command}\n`);
  }

  onTestRunEnd(): void {
    if (!this.#enabled) return;
    if (this.#entries.length === 0) return;
    writeRunIndex(this.#runDir, this.#entries);
    if (existsSync(this.#runDir)) linkLatest(this.#outputDir, this.#runDir);
  }
}
