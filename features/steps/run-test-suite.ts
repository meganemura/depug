import { defineStep, runCommand, z } from "nukadoko";
import { join } from "node:path";
import createVitestProject from "./create-vitest-project.ts";

// The reporter writes the evidence file under the project's tmp/, so the run
// changes the project.
export default defineStep({
  description: "Runs `vitest run` in the project and reads the `depug evidence:` and `depug rerun:` lines the reporter prints.",
  pattern: "the agent runs the test suite",
  args: z.object({ root: z.string() }),
  returns: z.object({
    exitCode: z.number().describe("vitest's exit code: 1 when a test failed"),
    outcome: z.enum(["success", "failure", "error"]).describe("vitest's exit code by its meaning: 0 success, 1 failure, any other error"),
    evidencePath: z.string().describe("the absolute path on the `depug evidence:` line"),
    evidenceNote: z.string().describe("the parenthetical after that path, which says whether the file can answer"),
    rerunLine: z.string().describe("the command on the `depug rerun:` line, as printed"),
  }),
  from: { root: [createVitestProject, "root"] },
  mutates: true,
  async run({}, { root }) {
    const result = await runCommand(join(root, "node_modules/.bin/vitest"), ["run"], { cwd: root });
    const output = `${result.stdout}\n${result.stderr}`;
    const evidence = /^depug evidence: (\S+) \((.+)\)$/m.exec(output);
    const rerun = /^depug rerun: (.+)$/m.exec(output);
    if (evidence === null || rerun === null) throw new Error(`the reporter printed no evidence or rerun line:\n${output}`);
    const exitCode = result.exitCode ?? 1;
    const outcome = exitCode === 0 ? ("success" as const) : exitCode === 1 ? ("failure" as const) : ("error" as const);
    return { exitCode, outcome, evidencePath: evidence[1]!, evidenceNote: evidence[2]!, rerunLine: rerun[1]! };
  },
});
