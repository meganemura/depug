import { defineStep, z } from "nukadoko";
import createVitestProject from "./create-vitest-project.ts";
import { outputFile, readJsonLines, runVerb } from "./depug-cli.ts";
import runTestSuite from "./run-test-suite.ts";

export const indexedCalls = z
  .array(z.object({ fid: z.string(), parent: z.string().nullable() }))
  .describe("every call record in the frames index: its function id and the id of the call that made it");

export default defineStep({
  description: "Runs `depug frames -- <rerun line>` in the project and reads the call records of the index it writes.",
  pattern: "the agent puts frames in front of the rerun line",
  args: z.object({ root: z.string(), rerunLine: z.string() }),
  returns: z.object({ calls: indexedCalls }),
  from: { root: [createVitestProject, "root"], rerunLine: [runTestSuite, "rerunLine"] },
  mutates: true,
  rationale: "The line is pasted as printed, wrapper included, because that is what the skill tells an agent to do; frames writes its index under the project's tmp/.",
  run({}, { root, rerunLine }) {
    const { stdout } = runVerb(["frames"], rerunLine, root);
    const calls = readJsonLines(outputFile(stdout, "frames"))
      .filter((record) => record.type === "call")
      .map((record) => ({ fid: String(record.fid), parent: record.parent === null ? null : String(record.parent) }));
    return { calls };
  },
});
