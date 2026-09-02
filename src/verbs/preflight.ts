// `preflight`: run the same test twice, in separate processes, and say
// whether the two runs made the same calls.
//
// Every re-execution verb addresses a call by its index inside the test.
// An index that moves between runs addresses a different call, and the
// verb would trace something other than what the caller named, without
// saying so. This verb is the check that makes the others safe to trust,
// and it measures the pair the verbs actually operate on: two isolated
// runs, not the suite.
import { runFrames, callSequence, fullSequence, type RunFramesInput } from "./frames.ts";

export interface Divergence {
  index: number;
  first: string | undefined;
  second: string | undefined;
}

export interface PreflightResult {
  deterministic: boolean;
  /** Application calls the first run recorded. */
  callCount: number;
  secondCallCount: number;
  /** True when the fuller sequence, with suspend and resume, also matched. */
  fullMatched: boolean;
  divergence?: Divergence;
  files: [string[], string[]];
  exitStatuses: [number | null, number | null];
}

function firstDifference(a: readonly string[], b: readonly string[]): Divergence | undefined {
  const limit = Math.max(a.length, b.length);
  for (let i = 0; i < limit; i++) {
    if (a[i] !== b[i]) return { index: i, first: a[i], second: b[i] };
  }
  return undefined;
}

export function runPreflight(input: RunFramesInput): PreflightResult {
  const first = runFrames(input);
  const second = runFrames(input);

  const firstCalls = callSequence(first.records);
  const secondCalls = callSequence(second.records);
  const divergence = firstDifference(firstCalls, secondCalls);

  return {
    deterministic: divergence === undefined,
    callCount: firstCalls.length,
    secondCallCount: secondCalls.length,
    fullMatched:
      firstDifference(fullSequence(first.records), fullSequence(second.records)) === undefined,
    divergence,
    files: [first.files, second.files],
    exitStatuses: [first.envelope.exit_status, second.envelope.exit_status],
  };
}

/** The report a reader sees, in the same shape whichever way it went. */
export function formatPreflight(result: PreflightResult): string {
  const lines: string[] = [];
  if (result.deterministic) {
    lines.push(`depug preflight: deterministic (app calls: ${result.callCount})`);
    if (!result.fullMatched) {
      // The call sequence is what the verbs address by, so this is a note
      // and not a refusal. Suspend and resume can differ where a promise
      // settles in a different order without changing which calls ran.
      lines.push("depug note: suspend and resume order differed between the two runs");
    }
  } else {
    const { index, first, second } = result.divergence!;
    lines.push(`depug preflight: first divergence at call ${index}`);
    lines.push(`first:  ${first ?? "(no call)"}`);
    lines.push(`second: ${second ?? "(no call)"}`);
    lines.push(`app calls: ${result.callCount} and ${result.secondCallCount}`);
    lines.push("This test is not eligible for depug re-execution.");
  }
  const files = [...result.files[0], ...result.files[1]];
  if (files.length > 0) lines.push(`depug preflight indexes: ${files.join(" ")}`);
  return lines.join("\n");
}
