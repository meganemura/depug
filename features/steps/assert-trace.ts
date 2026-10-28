import { defineStep, z } from "nukadoko";
import createVitestProject from "./create-vitest-project.ts";
import traceCall from "./trace-call.ts";

// The first value of the counter is the fact source reading would have to
// infer; the return value ties it to the failed assertion.
export default defineStep({
  description: "Claims the loop's counter `i` was first introduced as the second price's index, so the first price was skipped, and the trace's last return is the helper's short total.",
  pattern: "the trace shows the loop starting at the second price and the helper returning the short total",
  args: z.object({
    firstValues: traceCall.returns.shape.firstValues,
    returned: traceCall.returns.shape.returned,
    loopStart: createVitestProject.returns.shape.loopStart,
    wrongTotal: createVitestProject.returns.shape.wrongTotal,
  }),
  from: {
    firstValues: [traceCall, "firstValues"],
    returned: [traceCall, "returned"],
    loopStart: [createVitestProject, "loopStart"],
    wrongTotal: [createVitestProject, "wrongTotal"],
  },
  claims: [
    { actual: "firstValues.i", compare: "equal", expected: { from: "loopStart" } },
    { actual: "returned", compare: "equal", expected: { from: "wrongTotal" } },
  ],
});
