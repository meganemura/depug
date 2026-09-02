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
import { observeAll } from "../src/observed-shape.ts";
import { compareShape, renderDeclared, renderObserved } from "../src/shape-report.ts";
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
