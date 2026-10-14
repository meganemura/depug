import { defineStep, z } from "nukadoko";
import assertHelperIndexed from "./assert-helper-indexed.ts";
import createVitestProject from "./create-vitest-project.ts";
import { outputFile, readJsonLines, runVerb } from "./depug-cli.ts";
import runTestSuite from "./run-test-suite.ts";

export const traceRecords = z
  .array(z.object({ type: z.string(), line: z.number().nullable(), added: z.record(z.string(), z.string()), value: z.string().nullable() }))
  .describe("the trace's records in order: type, source line, the `new` locals of a line record by name, and the value of a return record");

export default defineStep({
  description: "Runs `depug flt <fid> -- <rerun line>` in the project and reads the trace it writes.",
  pattern: "the agent puts flt with that call in front of the rerun line",
  args: z.object({ root: z.string(), rerunLine: z.string(), fid: z.string() }),
  returns: z.object({ records: traceRecords }),
  from: { root: [createVitestProject, "root"], rerunLine: [runTestSuite, "rerunLine"], fid: [assertHelperIndexed, "fid"] },
  mutates: true,
  rationale: "flt writes its trace under the project's tmp/. The records are flattened to the fields the assertion reads so the step record stays small.",
  run({}, { root, rerunLine, fid }) {
    const { stdout } = runVerb(["flt", fid], rerunLine, root);
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
    return { records };
  },
});
