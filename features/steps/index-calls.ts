import { defineStep, z } from "nukadoko";
import createVitestProject from "./create-vitest-project.ts";
import { outputFile, readJsonLines, runVerb } from "./depug-cli.ts";
import runTestSuite from "./run-test-suite.ts";

export const indexedCalls = z
  .array(
    z.object({
      fid: z.string(),
      parent: z.string().nullable(),
      name: z.string(),
      counter: z.string(),
      parentName: z.string().nullable(),
    }),
  )
  .describe(
    "every call record in the frames index: its function id, the id of the call that made it, and from those ids the function's name, the `#k` call counter, and the caller's name",
  );

// A function id is `path:name@line:column#k`. The name and the counter are
// split out so a claim can compare them without parsing in step code.
const FID = /:([^:@]+)@\d+:\d+(#\d+)$/;

function nameOf(fid: string): string {
  return FID.exec(fid)?.[1] ?? "";
}

// The line is pasted as printed, wrapper included, because that is what the
// skill tells an agent to do; frames writes its index under the project's
// tmp/.
export default defineStep({
  description: "Runs `depug frames -- <rerun line>` in the project and reads the call records of the index it writes.",
  pattern: "the agent puts frames in front of the rerun line",
  args: z.object({ root: z.string(), rerunLine: z.string() }),
  returns: z.object({ calls: indexedCalls }),
  from: { root: [createVitestProject, "root"], rerunLine: [runTestSuite, "rerunLine"] },
  mutates: true,
  async run({}, { root, rerunLine }) {
    const { stdout } = await runVerb(["frames"], rerunLine, root);
    const calls = readJsonLines(outputFile(stdout, "frames"))
      .filter((record) => record.type === "call")
      .map((record) => {
        const fid = String(record.fid);
        const parent = record.parent === null ? null : String(record.parent);
        return { fid, parent, name: nameOf(fid), counter: FID.exec(fid)?.[2] ?? "", parentName: parent === null ? null : nameOf(parent) };
      });
    return { calls };
  },
});
