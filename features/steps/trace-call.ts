import { defineStep, z } from "nukadoko";
import createVitestProject from "./create-vitest-project.ts";
import { outputFile, readJsonLines, runVerb } from "./depug-cli.ts";
import indexCalls from "./index-calls.ts";
import runTestSuite from "./run-test-suite.ts";

export const traceRecords = z
  .array(z.object({ type: z.string(), line: z.number().nullable(), added: z.record(z.string(), z.string()), value: z.string().nullable() }))
  .describe("the trace's records in order: type, source line, the `new` locals of a line record by name, and the value of a return record");

// flt writes its trace under the project's tmp/. The records are flattened to
// the fields a claim reads so the step record stays small. "That call" is the
// helper's call in the frames index, which the Then before this one judged.
export default defineStep({
  description:
    "Runs `depug flt <fid> -- <rerun line>` for the helper's call in the frames index, and reads the trace it writes: its records, the value each local was first introduced with, and the last value returned.",
  pattern: "the agent puts flt with that call in front of the rerun line",
  args: z.object({ root: z.string(), rerunLine: z.string(), calls: indexCalls.returns.shape.calls, helper: z.string() }),
  returns: z.object({
    records: traceRecords,
    firstValues: z.record(z.string(), z.string()).describe("each local's value on the first line record that introduced it, by name"),
    returned: z.string().nullable().describe("the value of the trace's last return record, null when there is none"),
  }),
  from: {
    root: [createVitestProject, "root"],
    rerunLine: [runTestSuite, "rerunLine"],
    calls: [indexCalls, "calls"],
    helper: [createVitestProject, "helper"],
  },
  mutates: true,
  async run({}, { root, rerunLine, calls, helper }) {
    const call = calls.find((candidate) => candidate.name === helper);
    if (call === undefined) throw new Error(`the frames index holds no call of ${helper}`);
    const { stdout } = await runVerb(["flt", call.fid], rerunLine, root);
    const records = readJsonLines(outputFile(stdout, "flt")).map((record) => {
      const added = (record.new ?? {}) as Record<string, { value: string }>;
      const value = record.value as { value: string } | undefined;
      return {
        type: String(record.type),
        line: typeof record.line === "number" ? record.line : null,
        added: Object.fromEntries(Object.entries(added).map(([name, local]) => [name, local.value])),
        value: value?.value ?? null,
      };
    });
    const firstValues: Record<string, string> = {};
    for (const record of records) {
      if (record.type !== "line") continue;
      for (const [name, value] of Object.entries(record.added)) firstValues[name] ??= value;
    }
    const returned = records.findLast((record) => record.type === "return")?.value ?? null;
    return { records, firstValues, returned };
  },
});
