// The prefix a failure's rerun line carries.
//
// The failure text prints a command, and the rerun verb strips the same
// prefix back off before it starts its own clock. Those two have to agree
// on the words. The printers live in evidence.ts and the node:test
// reporter, and the verbs already import the schema from evidence.ts, so
// the printers cannot import the verb: that edge was the one reverse
// direction in evidence.ts -> verbs -> evidence.ts. The clock and the
// strip stay on the verb. This module holds the prefix they share.
export const RERUN_PREFIX = ["npx", "depug", "rerun", "--"] as const;

/** Wraps a plain command in the guarded form. */
export function guardedCommand(command: string): string {
  return `${RERUN_PREFIX.join(" ")} ${command}`;
}
