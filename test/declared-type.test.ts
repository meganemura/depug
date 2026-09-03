// Runs the fixture's four unchecked-boundary paths for real, records what
// each one actually produced, and checks that comparing the recording
// against the declared type names the disagreement.
//
// Every case here calls the fixture and observes the returned value; none
// of them reads the fixture's source text to decide what it would do.
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { declaredSignatureOf } from "../src/declared-type.ts";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { observeAll } from "../src/observed-shape.ts";
import { compareShape, renderDeclared, renderObserved } from "../src/shape-report.ts";
import type { Kind } from "../src/declared-type.ts";
import * as app from "../fixtures/types/src/app.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/types/src/app.ts", import.meta.url));

// strict is on because it is what makes `process.env.X` carry its
// undefined half; without it the declared type would already agree with
// the observed one for the wrong reason.
const program = ts.createProgram([FIXTURE], {
  strict: true,
  target: ts.ScriptTarget.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
});

function declaredOf(functionName: string) {
  const signature = declaredSignatureOf(program, FIXTURE, functionName);
  if (!signature) throw new Error(`no declared signature for ${functionName}`);
  return signature;
}

describe("declared type projection", () => {
  it("projects a parameter's properties, kinds, and optionality", () => {
    const parameter = declaredOf("greetUser").parameters[0];
    expect(renderDeclared(parameter.type)).toBe("{email: string, id: number}");
  });

  it("keeps the undefined half of process.env's own type", () => {
    // envValue is declared to return string. The claim under test is that
    // the projection reads the declaration, not the runtime value.
    expect(renderDeclared(declaredOf("envValue").returnType)).toBe("string");
  });

  it("reports an any parameter as accepting everything", () => {
    expect(renderDeclared(declaredOf("fromAny").parameters[0].type)).toBe("any");
  });
});

describe("observed shape against declared type, on values the fixture really produced", () => {
  it("catches what JSON.parse and an `as` cast let through", () => {
    // Three of five payloads omit email; all five carry id as a string.
    const payloads = [
      '{"id": "1"}',
      '{"email": "a@example.com", "id": "2"}',
      '{"id": "3"}',
      '{"email": "b@example.com", "id": "4"}',
      '{"id": "5"}',
    ];
    const users = payloads.map((raw) => app.parseUser(raw));
    const shape = observeAll(users);
    const declared = declaredOf("greetUser").parameters[0].type;

    expect(renderObserved(shape)).toBe(
      "{id: string, email: undefined (3 / 5 calls) | string (2 / 5 calls)}",
    );
    expect(renderDeclared(declared)).toBe("{email: string, id: number}");

    const mismatches = compareShape(shape, declared);
    expect(mismatches).toContainEqual(
      expect.objectContaining({
        property: "email",
        reason: "required-property-absent",
        occurrences: 3,
        samples: 5,
      }),
    );
    expect(mismatches).toContainEqual(
      expect.objectContaining({
        property: "id",
        reason: "kind-not-declared",
        observed: "string",
        declared: "number",
        occurrences: 5,
      }),
    );
  });

  it("catches an unset process.env value flowing on as a string", () => {
    const name = "DEPUG_FIXTURE_ABSENT_VALUE";
    delete process.env[name];
    const observed = observeAll([app.envValue(name)]);
    const declared = declaredOf("envValue").returnType;

    expect(renderObserved(observed)).toBe("undefined");
    expect(renderDeclared(declared)).toBe("string");
    expect(compareShape(observed, declared)).toContainEqual(
      expect.objectContaining({ reason: "kind-not-declared", observed: "undefined" }),
    );
  });

  it("catches a value an `any` parameter carried into a typed return", () => {
    const returned = app.fromAny({ id: 7 });
    const shape = observeAll([returned]);
    const declared = declaredOf("fromAny").returnType;

    expect(compareShape(shape, declared)).toContainEqual(
      expect.objectContaining({ property: "email", reason: "required-property-absent" }),
    );
  });

  it("reports no mismatch when the values match the declaration", () => {
    // The control. Without it, a comparison that always reported a
    // mismatch would pass every test above.
    const users = [app.parseUser('{"email": "a@example.com", "id": 1}')];
    const mismatches = compareShape(observeAll(users), declaredOf("greetUser").parameters[0].type);
    expect(mismatches).toEqual([]);
  });

  it("stays silent where the declaration stopped making a claim", () => {
    // `any` accepts every runtime kind, so nothing observed can disagree
    // with it. This is the shape depug is most useful around: the
    // annotation says nothing, and only the run can say what came through.
    const declared = declaredOf("fromAny").parameters[0].type;
    expect(compareShape(observeAll([{ id: 1 }, "not an object", null]), declared)).toEqual([]);
  });
});

describe("observing values", () => {
  it("counts every value it was shown", () =>
    hegel.test((tc) => {
      // Counts cover every call: sampling them would let a later null hide
      // and support a claim that it never happened.
      const values = tc.draw(
        gs.arrays(
          gs.sampledFrom<unknown>([1, "a", true, null, undefined, {}, [], 1n]),
          { maxSize: 40 },
        ),
      );
      const shape = observeAll(values);
      expect(shape.samples).toBe(values.length);
      const counted = Object.values(shape.kinds).reduce((a, b) => a + b, 0);
      expect(counted).toBe(values.length);
    }));

  it("accounts for every sample of every property, present or absent", () =>
    hegel.test((tc) => {
      // A property seen in 2 of 5 calls has to read as "sometimes missing",
      // not as "always a string". That only works if seen plus absent is
      // the whole sample count.
      const objects = tc.draw(
        gs.arrays(
          gs.maps(gs.sampledFrom(["a", "b", "c"]), gs.integers({ minValue: 0, maxValue: 9 }), { maxSize: 3 })
            .map((m) => Object.fromEntries(m)),
          { minSize: 1, maxSize: 20 },
        ),
      );
      const shape = observeAll(objects);
      for (const property of Object.values(shape.properties)) {
        const seen = Object.values(property.kinds).reduce((a, b) => a + b, 0);
        expect(seen + property.absent).toBe(shape.samples);
      }
    }));

  it("stays silent where the declaration stopped making a claim", () =>
    hegel.test((tc) => {
      // `any` and `unknown` accept every runtime kind, so nothing observed
      // can disagree with them. A mismatch reported there would be noise a
      // reader has to learn to ignore.
      const values = tc.draw(
        gs.arrays(gs.sampledFrom<unknown>([1, "a", true, null, undefined, { x: 1 }, []]), { maxSize: 20 }),
      );
      const accepts = tc.draw(gs.sampledFrom<"any" | "unknown">(["any", "unknown"]));
      expect(compareShape(observeAll(values), { form: "primitive", kinds: [accepts] })).toEqual([]);
    }));

  it("never reports a mismatch for a value the declaration does allow", () =>
    hegel.test((tc) => {
      // The control, generalised: build the declared type out of the kinds
      // that actually arrived, and nothing should disagree.
      const values = tc.draw(
        gs.arrays(gs.sampledFrom<unknown>([1, "a", true, null, 2n]), { minSize: 1, maxSize: 20 }),
      );
      const shape = observeAll(values);
      const kinds = Object.keys(shape.kinds) as Kind[];
      expect(compareShape(shape, { form: "primitive", kinds })).toEqual([]);
    }));
});
