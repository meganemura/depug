import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";
import createVitestProject from "./create-vitest-project.ts";
import runTestSuite from "./run-test-suite.ts";

export default defineStep({
  description:
    "Asserts the suite failed, the evidence file names the failing test and says the value's source already returned, and the rerun line wraps a vitest command for that test in `npx depug rerun --`.",
  pattern: "the failure prints an evidence file saying the value's source already returned, and a rerun line",
  args: z.object({
    exitCode: z.number(),
    evidencePath: z.string(),
    evidenceNote: z.string(),
    rerunLine: z.string(),
    testName: z.string(),
  }),
  returns: z.object({}),
  from: {
    exitCode: [runTestSuite, "exitCode"],
    evidencePath: [runTestSuite, "evidencePath"],
    evidenceNote: [runTestSuite, "evidenceNote"],
    rerunLine: [runTestSuite, "rerunLine"],
    testName: [createVitestProject, "testName"],
  },
  mutates: false,
  rationale: "The note is what sends an agent to a verb rather than to the stack, so the step checks its exact wording.",
  run({}, { exitCode, evidencePath, evidenceNote, rerunLine, testName }) {
    if (exitCode !== 1) throw new Error(`expected vitest to exit 1, got ${exitCode}`);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as { test: { name: string } };
    if (evidence.test.name !== testName) throw new Error(`the evidence names ${evidence.test.name}, not ${testName}`);
    if (evidenceNote !== "the value's source already returned; rerun to reach it") throw new Error(`unexpected note: ${evidenceNote}`);
    if (!rerunLine.startsWith("npx depug rerun -- npx vitest run ")) throw new Error(`unexpected rerun line: ${rerunLine}`);
    if (!rerunLine.includes(testName)) throw new Error(`the rerun line does not name ${testName}: ${rerunLine}`);
    return {};
  },
});
