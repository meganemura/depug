import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";
import createVitestProject from "./create-vitest-project.ts";
import runTestSuite from "./run-test-suite.ts";

// The note is what sends an agent to a verb rather than to the stack, so the
// sentence states its exact wording.
export default defineStep({
  description:
    "Claims the suite failed, the evidence file names the failing test, the note is the sentence's, and the rerun line starts with the sentence's command and holds the test's name.",
  pattern: "the failure prints an evidence file saying {note:string}, and a rerun line starting with {command:string}",
  args: z.object({
    note: z.string().describe("the parenthetical the reporter prints after the evidence path"),
    command: z.string().describe("the depug wrapper and the vitest command the rerun line starts with"),
    outcome: runTestSuite.returns.shape.outcome,
    evidencePath: runTestSuite.returns.shape.evidencePath,
    evidenceNote: runTestSuite.returns.shape.evidenceNote,
    rerunLine: runTestSuite.returns.shape.rerunLine,
    testName: createVitestProject.returns.shape.testName,
  }),
  from: {
    outcome: [runTestSuite, "outcome"],
    evidencePath: [runTestSuite, "evidencePath"],
    evidenceNote: [runTestSuite, "evidenceNote"],
    rerunLine: [runTestSuite, "rerunLine"],
    testName: [createVitestProject, "testName"],
  },
  observe({}, { evidencePath }) {
    return { evidence: readFileSync(evidencePath, "utf8") };
  },
  claims: [
    { actual: "outcome", compare: "equal", expected: { literal: "failure" } },
    { actual: "evidence", view: "json", at: "test.name", compare: "equal", expected: { from: "testName" } },
    { actual: "evidenceNote", compare: "equal", expected: "note" },
    { actual: "rerunLine", compare: "starts-with-text", expected: "command" },
    { actual: "rerunLine", compare: "contains-text", expected: { from: "testName" } },
  ],
});
