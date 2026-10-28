import { defineStep, z } from "nukadoko";
import createVitestProject from "./create-vitest-project.ts";
import indexCalls from "./index-calls.ts";

// Every call of the helper must be the first one, made by the function the
// test called: a second call would carry `#2`, so this also holds the index
// to one call.
export default defineStep({
  description: "Claims every call of the helper in the index was made by the function the test called and carries the counter `#1`, and that there is one.",
  pattern: "the index names the helper's call under the function the test called",
  args: z.object({
    calls: indexCalls.returns.shape.calls,
    caller: createVitestProject.returns.shape.caller,
    helper: createVitestProject.returns.shape.helper,
    helperCall: createVitestProject.returns.shape.helperCall,
  }),
  from: {
    calls: [indexCalls, "calls"],
    caller: [createVitestProject, "caller"],
    helper: [createVitestProject, "helper"],
    helperCall: [createVitestProject, "helperCall"],
  },
  claims: [
    {
      actual: "calls",
      each: {
        where: [{ actual: "name", compare: "equal", expected: { from: "helper" } }],
        claims: [
          { actual: "parentName", compare: "equal", expected: { from: "caller" } },
          { actual: "counter", compare: "equal", expected: { from: "helperCall" } },
        ],
      },
    },
  ],
});
