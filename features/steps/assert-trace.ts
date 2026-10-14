import { defineStep, z } from "nukadoko";
import createVitestProject from "./create-vitest-project.ts";
import traceCall, { traceRecords } from "./trace-call.ts";

export default defineStep({
  description: "Asserts the loop's counter `i` is first seen as 1, so the first price was skipped, and the trace ends with the helper returning the short total.",
  pattern: "the trace shows the loop starting at the second price and the helper returning the short total",
  args: z.object({ records: traceRecords, wrongTotal: z.string() }),
  returns: z.object({}),
  from: { records: [traceCall, "records"], wrongTotal: [createVitestProject, "wrongTotal"] },
  mutates: false,
  rationale: "The first value of the counter is the fact source reading would have to infer; the return value ties it to the failed assertion.",
  run({}, { records, wrongTotal }) {
    const counter = records.find((record) => record.type === "line" && "i" in record.added);
    if (counter === undefined) throw new Error("the trace never introduced the loop counter i");
    if (counter.added.i !== "1") throw new Error(`expected i to start at 1, got ${counter.added.i}`);
    const returned = records.findLast((record) => record.type === "return");
    if (returned?.value !== wrongTotal) throw new Error(`expected a return of ${wrongTotal}, got ${returned?.value}`);
    return {};
  },
});
