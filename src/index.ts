// What a project imports when it installs depug.
//
// The surface is deliberately small. A project needs the reporter to turn
// its failures into evidence, and nothing else: every verb is a command,
// and the files those commands write are the interface the rest of the
// tool is used through. The plugin is exported for a project that would
// rather add instrumentation to its own config than let a verb generate
// one, which is the same mechanism either way.
//
// The types come along because an agent reading an evidence file benefits
// from the shape being declared somewhere, and because depug's own claim
// is that a declared type should match what a run produces.
export { default as DepugReporter } from "./reporter.ts";
export { depugPlugin, type DepugPluginOptions } from "./plugin.ts";

export type { SnapEvidence, SnapError, SnapTest, Limits } from "./evidence.ts";
export type { EvidenceFrame } from "./stack.ts";
export type { CodeState } from "./code-state.ts";
export type { FrameRecord } from "./collector.ts";
export { parseFid, fidWithoutCall, type ParsedFid } from "./fid.ts";
