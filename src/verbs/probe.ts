// `probe`: run a test again and record what one named function actually
// received and returned, beside what it was declared to receive and
// return.
//
// The gap between the two columns is the point. A type annotation is a
// claim about runtime values, and four boundaries let a value through
// without checking it: `JSON.parse`, an `as` cast, `process.env`, and an
// `any` parameter. Where the annotation stopped making a claim, only a run
// can say what came through.
//
// The two columns are read in different places, which is why this file
// exists: the observation happens inside the test process, and the
// declaration is read here, in the parent, where paying for the compiler
// once is affordable.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { readCodeState, type CodeState } from "../code-state.ts";
import { declaredSignatureAtId, type DeclaredType } from "../declared-type.ts";
import { SCHEMA_VERSION } from "../evidence.ts";
import { fidWithoutCall, parseFid } from "../fid.ts";
import { compareShape, type Mismatch } from "../shape-report.ts";
import type { ObservedShape } from "../observed-shape.ts";
import type { ProbeFunctionRecord } from "../probe-runtime.ts";
import type { ProbeTarget } from "../probe-transform.ts";
import { applyConfigArgument } from "../wrapper-config.ts";
import { writeProbeWrapperConfig } from "./probe-config.ts";

export interface ProbeColumn {
  observed: ObservedShape;
  declared: DeclaredType | null;
  mismatches: Mismatch[];
}

export interface ProbeFunctionOutput {
  calls: number;
  threw: number;
  parameters: ({ name: string } & ProbeColumn)[];
  parameters_not_observed: ProbeTarget["parameters_not_observed"];
  returns: ProbeColumn;
}

export interface ProbeOutput {
  schema_version: number;
  kind: "probe";
  tool: { name: string; version: string };
  code_state: CodeState;
  targets: string[];
  functions: Record<string, ProbeFunctionOutput>;
  /** Targets the rewrite never matched, so a reader is not left guessing. */
  targets_not_found: string[];
}

export interface RunProbeInput {
  command: string[];
  cwd: string;
  targets: string[];
  timeoutMs?: number;
}

export interface ProbeResult {
  output: ProbeOutput;
  exitStatus: number | null;
  stdout: string;
  stderr: string;
}

function readAll<T>(dir: string, prefix: string): T[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as T);
}

/**
 * Reads declared signatures for the targets, one program per file.
 *
 * A program costs about a fifth of a second to build, so this builds one
 * for each distinct file rather than one for each target.
 */
function declaredFor(cwd: string, targets: readonly string[]): Map<string, ReturnType<typeof declaredSignatureAtId>> {
  const byFile = new Map<string, string[]>();
  for (const target of targets) {
    const parsed = parseFid(target);
    if (!parsed) continue;
    const list = byFile.get(parsed.path) ?? [];
    list.push(target);
    byFile.set(parsed.path, list);
  }

  const out = new Map<string, ReturnType<typeof declaredSignatureAtId>>();
  for (const [relativePath, ids] of byFile) {
    const absolute = resolve(cwd, relativePath);
    const program = ts.createProgram([absolute], {
      strict: true,
      target: ts.ScriptTarget.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
    });
    for (const id of ids) {
      out.set(id, declaredSignatureAtId(program, absolute, relativePath, id));
    }
  }
  return out;
}

function column(observed: ObservedShape, declared: DeclaredType | undefined): ProbeColumn {
  return {
    observed,
    declared: declared ?? null,
    // With no declared type there is nothing to disagree with. An empty
    // list here means "not compared", which `declared: null` states.
    mismatches: declared ? compareShape(observed, declared) : [],
  };
}

export function runProbe(input: RunProbeInput): ProbeResult {
  const targets = input.targets.map(fidWithoutCall);
  const base = process.env.DEPUG_OUTPUT_DIR ?? join(input.cwd, "tmp", "depug");
  mkdirSync(base, { recursive: true });
  const probeDir = mkdtempSync(join(base, "probe-"));

  const wrapper = writeProbeWrapperConfig({ cwd: input.cwd, targets });
  const [bin, ...rest] = input.command;
  const { args } = applyConfigArgument(rest, wrapper.configPath);

  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("VITEST") || key.startsWith("TINYPOOL")) continue;
    env[key] = value;
  }
  env.DEPUG_PROBE_DIR = probeDir;
  env.DEPUG_DISABLE = "1";

  let child;
  try {
    child = spawnSync(bin, args, {
      cwd: input.cwd,
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: input.timeoutMs ?? 120_000,
    });
  } finally {
    wrapper.cleanup();
  }

  const observations = readAll<Record<string, ProbeFunctionRecord>>(probeDir, "probe-");
  const matched = readAll<ProbeTarget[]>(probeDir, "targets-").flat();
  const matchedById = new Map(matched.map((target) => [target.id, target]));
  const declared = declaredFor(input.cwd, targets);

  const functions: Record<string, ProbeFunctionOutput> = {};
  for (const dump of observations) {
    for (const [id, record] of Object.entries(dump)) {
      const signature = declared.get(id);
      functions[id] = {
        calls: record.calls,
        threw: record.threw,
        parameters: record.parameters.map((parameter, index) => ({
          name: parameter.name,
          ...column(parameter.observed, signature?.parameters[index]?.type),
        })),
        parameters_not_observed: matchedById.get(id)?.parameters_not_observed ?? [],
        returns: column(record.returns, signature?.returnType),
      };
    }
  }

  return {
    output: {
      schema_version: SCHEMA_VERSION,
      kind: "probe",
      tool: { name: "depug", version: "0.0.0" },
      code_state: readCodeState(input.cwd),
      targets,
      functions,
      // A target the rewrite matched but that never ran still belongs
      // here: it was found in the source and called zero times, which is
      // different from an id that names nothing.
      targets_not_found: targets.filter((id) => !matchedById.has(id)),
    },
    exitStatus: child.status,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
  };
}
