// Probes a function whose declared type is wrong, in a test that passes.
//
// That combination is the whole case for the verb: the suite is green, the
// annotation says one thing, and the values that actually crossed the
// boundary say another. Nothing but running it can tell the difference.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { instrumentProbes } from "../src/probe-transform.ts";
import { createProbeRuntime } from "../src/probe-runtime.ts";
import { runProbe } from "../src/verbs/probe.ts";

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/probe", import.meta.url));
const VITEST_BIN = fileURLToPath(new URL("../node_modules/.bin/vitest", import.meta.url));
const PARSE_USER = "src/app.ts:parseUser@8:17";

function probe(...targets: string[]) {
  return runProbe({
    command: [VITEST_BIN, "run", "app.test.ts"],
    cwd: FIXTURE_DIR,
    targets,
  });
}

describe("the probe rewrite", () => {
  it("keeps the line count and names the target by the id the index uses", () => {
    const source = readFileSync(join(FIXTURE_DIR, "src/app.ts"), "utf8");
    const result = instrumentProbes(source, "src/app.ts", [PARSE_USER]);
    expect(result.code.split("\n")).toHaveLength(source.split("\n").length);
    expect(result.targets.map((t) => t.id)).toEqual([PARSE_USER]);
    expect(result.targets[0].parameters).toEqual(["raw"]);
  });

  it("leaves a file holding no target untouched", () => {
    const source = readFileSync(join(FIXTURE_DIR, "src/app.ts"), "utf8");
    const result = instrumentProbes(source, "src/app.ts", ["src/app.ts:nothing@1:1"]);
    expect(result.code).toBe(source);
    expect(result.targets).toEqual([]);
  });

  it("does not observe a destructured parameter, and says so", () => {
    // Reporting `undefined` for a value nobody could read would be a
    // false measurement; an absence a reader can see is not.
    const source = "export function f({ a }: { a: number }, b: number) { return a + b; }\n";
    const result = instrumentProbes(source, "src/app.ts", ["src/app.ts:f@1:17"]);
    expect(result.targets[0].parameters).toEqual(["b"]);
    expect(result.targets[0].parameters_not_observed).toEqual([{ position: 0, reason: "destructured" }]);
  });
});

describe("probing a function whose declared type is wrong", () => {
  it("shows the observed shape beside the declared one, in a passing suite", () => {
    const result = probe(PARSE_USER);
    // The suite is green. The disagreement is not something a test found.
    expect(result.exitStatus, result.stdout + result.stderr).toBe(0);

    const fn = result.output.functions[PARSE_USER];
    expect(fn.calls).toBe(5);
    expect(fn.threw).toBe(0);

    // Every id arrived as a string, and three of five payloads had no
    // email at all.
    expect(fn.returns.observed.properties.id.kinds).toEqual({ string: 5 });
    expect(fn.returns.observed.properties.email.absent).toBe(3);

    expect(fn.returns.mismatches).toContainEqual(
      expect.objectContaining({
        property: "id",
        reason: "kind-not-declared",
        observed: "string",
        declared: "number",
        occurrences: 5,
      }),
    );
    expect(fn.returns.mismatches).toContainEqual(
      expect.objectContaining({
        property: "email",
        reason: "required-property-absent",
        occurrences: 3,
      }),
    );
  }, 120_000);

  it("reports the parameter that was declared honestly as agreeing", () => {
    const result = probe(PARSE_USER);
    const [raw] = result.output.functions[PARSE_USER].parameters;
    expect(raw.name).toBe("raw");
    expect(raw.observed.kinds).toEqual({ string: 5 });
    // The control: a parameter that matched its declaration reports
    // nothing, so a mismatch above means something.
    expect(raw.mismatches).toEqual([]);
  }, 120_000);

  it("lists each call's argument and return, so one run finds the odd one out", () => {
    // The case this exists for: several calls to one function, all the
    // same shape, one of them wrong. Without the values, telling them
    // apart costs one trace per call.
    const fn = probe(PARSE_USER).output.functions[PARSE_USER];
    const [raw] = fn.parameters;
    expect(raw.samples).toHaveLength(5);
    // A string sample is rendered the way source would quote it, so the
    // payload's own quotes are escaped inside it.
    expect(raw.samples[0]).toBe(JSON.stringify('{"id": "1"}'));
    expect(fn.returns.samples).toHaveLength(5);
    // The five returns are distinguishable from each other.
    expect(new Set(fn.returns.samples).size).toBe(5);
    expect(fn.returns.samples_omitted).toBe(0);
  }, 120_000);

  it("counts a secret-named argument without rendering it", () => {
    const source = "export function login(password: string) { return password.length; }\n";
    const result = instrumentProbes(source, "src/app.ts", ["src/app.ts:login@1:17"]);
    // The rewrite still passes the value; the runtime is what withholds it.
    expect(result.targets[0].parameters).toEqual(["password"]);

    const runtime = createProbeRuntime();
    runtime.enter("src/app.ts:login@1:17", ["password"], ["hunter2"]);
    const record = runtime.dump()["src/app.ts:login@1:17"];
    expect(record.parameters[0].samples).toEqual([]);
    // Counted, though: a probe still says a string arrived.
    expect(record.parameters[0].observed.kinds).toEqual({ string: 1 });
  });

  it("names an id that matches no function instead of writing an empty file", () => {
    const result = probe("src/app.ts:noSuchFunction@1:1");
    expect(result.output.targets_not_found).toEqual(["src/app.ts:noSuchFunction@1:1"]);
    expect(result.output.functions).toEqual({});
  }, 120_000);
});
