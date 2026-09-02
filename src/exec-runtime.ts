// The collector the injected expression reports through.
//
// `exec` is the one verb that changes what the program does. Everything
// else here observes; this evaluates an expression the caller wrote, in
// the running scope, where assigning to a local changes that local.
//
// Two things follow from that. The gate below refuses to run unless the
// launcher set its token, so an injected expression cannot fire in an
// ordinary test run. And the record says what happened -- the value, or
// the error -- because a caller who changed the outcome has to be able to
// read what the change did before treating the new outcome as evidence.
export interface ExecEvaluationRecord {
  type: "evaluation";
  fid: string;
  line: number;
  visit: number;
  value?: string;
  name?: string;
  message?: string;
}

export interface ExecSummaryRecord {
  type: "evaluation_summary";
  fid: string;
  line: number;
  line_visits_observed: number;
  target_visit: number;
  evaluated: false;
}

export interface ExecTargetSummaryRecord {
  type: "target_summary";
  fid: string;
  observed_calls: number;
  target_index: number;
  traced: false;
}

export type ExecRecord = ExecEvaluationRecord | ExecSummaryRecord | ExecTargetSummaryRecord;

/** The token the launcher sets. Without it, nothing is injected. */
export const EXEC_TOKEN = "DEPUG_EXEC";

export interface ExecRuntime {
  /** Called at the target function's entry. Returns this call's index. */
  enter(): number;
  /**
   * True when this visit is the one to evaluate. Counting happens on every
   * visit, whether or not it evaluates, so the summary can report how many
   * there were.
   */
  shouldRun(call: number, line: number): boolean;
  value(line: number, rendered: string): void;
  threw(line: number, name: string, message: string): void;
  dump(): ExecRecord[];
}

export interface ExecRuntimeOptions {
  fidPrefix: string;
  targetCall: number;
  targetLine: number;
  targetVisit: number;
  armed: boolean;
}

/** Renders a value shallowly, the way an evidence file writes one. */
export function renderExecValue(value: unknown, maxLength = 200): string {
  let text: string;
  try {
    if (value === null) text = "null";
    else if (value === undefined) text = "undefined";
    else if (typeof value === "string") text = JSON.stringify(value);
    else if (typeof value === "bigint") text = `${value}n`;
    else if (typeof value === "function") text = `[Function ${value.name || "anonymous"}]`;
    else if (typeof value === "object") text = JSON.stringify(value) ?? String(value);
    else text = String(value);
  } catch {
    // A value that refuses to render is still an observation; losing the
    // record entirely would be worse than saying it could not be shown.
    text = "<render threw>";
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function createExecRuntime(options: ExecRuntimeOptions): ExecRuntime {
  const records: ExecRecord[] = [];
  let calls = 0;
  let visits = 0;
  let evaluated = false;

  return {
    enter() {
      calls += 1;
      return calls;
    },
    shouldRun(call, line) {
      if (!options.armed) return false;
      if (call !== options.targetCall) return false;
      if (line !== options.targetLine) return false;
      visits += 1;
      return visits === options.targetVisit;
    },
    value(line, rendered) {
      evaluated = true;
      records.push({
        type: "evaluation",
        fid: `${options.fidPrefix}${options.targetCall}`,
        line,
        visit: options.targetVisit,
        value: rendered,
      });
    },
    threw(line, name, message) {
      evaluated = true;
      records.push({
        type: "evaluation",
        fid: `${options.fidPrefix}${options.targetCall}`,
        line,
        visit: options.targetVisit,
        name,
        message,
      });
    },
    dump() {
      if (evaluated) return records.slice();
      // Nothing was evaluated, and the reason decides what the caller does
      // next: pick a different call, or a different visit.
      if (calls < options.targetCall) {
        return [
          {
            type: "target_summary",
            fid: `${options.fidPrefix}${options.targetCall}`,
            observed_calls: calls,
            target_index: options.targetCall,
            traced: false,
          },
        ];
      }
      return [
        {
          type: "evaluation_summary",
          fid: `${options.fidPrefix}${options.targetCall}`,
          line: options.targetLine,
          line_visits_observed: visits,
          target_visit: options.targetVisit,
          evaluated: false,
        },
      ];
    },
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __depugExec: ExecRuntime;
}

/**
 * Installs the collector. `armed` is false unless the launcher set the
 * token, and an unarmed runtime evaluates nothing: the injected code still
 * runs, asks, and is told no.
 */
export function installGlobalExecRuntime(options: Omit<ExecRuntimeOptions, "armed">): ExecRuntime {
  const runtime = createExecRuntime({ ...options, armed: process.env[EXEC_TOKEN] === "1" });
  globalThis.__depugExec = runtime;
  return runtime;
}
