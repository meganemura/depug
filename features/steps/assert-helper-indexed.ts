import { defineStep, z } from "nukadoko";
import createVitestProject from "./create-vitest-project.ts";
import indexCalls, { indexedCalls } from "./index-calls.ts";

// The id is read from the index, not built by hand, because the position and
// the call counter in it are what depug measured.
export default defineStep({
  description: "Asserts the index holds exactly one call of the helper, made by the function the test called, and returns its function id.",
  pattern: "the index names the helper's call under the function the test called",
  args: z.object({ calls: indexedCalls, caller: z.string(), helper: z.string() }),
  returns: z.object({ fid: z.string().describe("the helper call's function id, `path:name@line:column#k`") }),
  from: { calls: [indexCalls, "calls"], caller: [createVitestProject, "caller"], helper: [createVitestProject, "helper"] },
  mutates: false,
  run({}, { calls, caller, helper }) {
    const helperCalls = calls.filter((call) => call.fid.includes(`:${helper}@`));
    if (helperCalls.length !== 1) throw new Error(`expected one call of ${helper}, got ${helperCalls.length}`);
    const call = helperCalls[0]!;
    if (call.parent === null || !call.parent.includes(`:${caller}@`)) throw new Error(`${call.fid} was not called by ${caller}: parent ${call.parent}`);
    if (!call.fid.endsWith("#1")) throw new Error(`expected the first call, got ${call.fid}`);
    return { fid: call.fid };
  },
});
