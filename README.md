# depug

depug turns TypeScript test failures into evidence a coding agent can read,
and answers questions about a run by measuring it rather than by reading
the source.

An agent debugging a failed test usually infers what a value was from the
code around it. depug reruns the test with instrumentation and reports what
the value actually was.

Works with vitest and with Node's own test runner. Development used Node
v26.7.0, vitest 4.1.11, and typescript 6.0.3.

## Install

depug is not published. Point a dependency at a checkout:

```sh
npm install --save-dev /path/to/depug
```

Add the reporter to your vitest config. Nothing else has to change:

```ts
import { defineConfig } from "vitest/config";
import DepugReporter from "depug/reporter";

export default defineConfig({
  test: {
    reporters: ["default", new DepugReporter()],
  },
});
```

The verbs below need no configuration at all. Each one generates its own
config from yours, runs one test, and throws the generated file away.

## Start from the failure

A failed test now prints two lines:

```text
depug evidence: /abs/path/tmp/depug/run-20260903-010701-94176/001-expandipv6-should-result-be-valid.json (the value's source already returned; rerun to reach it)
depug rerun: npx vitest run "src/utils/ipaddr.test.ts" -t "^expandIPv6 Should result be valid$"
```

The parenthetical says whether that file can answer:

- **the failing call is in these frames** — the code that produced the
  wrong value is still on the stack. Read the file.
- **the value's source already returned; rerun to reach it** — it is not,
  and no deeper capture of that run would find it. Use a verb.

Across 155 real failures from one project's history, 94.2% were the second
kind. That is the case the rest of this tool exists for.

depug never runs the rerun command for you. Every verb starts a process
only when you invoke it, so a green suite pays nothing.

## The verbs

Each verb takes the command the failure printed, with a verb in front:

```sh
depug frames    -- npx vitest run "src/utils/ipaddr.test.ts" -t "^expandIPv6 Should result be valid$"
depug preflight -- ...
depug probe "src/utils/ipaddr.ts:expandIPv6@13:14"    -- ...
depug flt   "src/utils/ipaddr.ts:expandIPv6@13:14#7"  -- ...
depug exec  "src/app.ts:sumUntil@18:17#1" --line 21 --statement "total = 100" -- ...
```

### frames — what did this test call?

```text
depug frames: tmp/depug/frames-P8OxUK/frames-3222.jsonl
depug calls: 15
```

One JSONL record per call, each named by a function id.

### preflight — is this test safe to address by call index?

```text
depug preflight: deterministic (app calls: 214)
```

Every other verb names a call by its index inside the test. An index that
moves between runs names a different call. Run this first. Measured on 80
tests across 53 files of one project, 80 matched their own second run.

### probe — what did this function receive and return?

```text
src/utils/ipaddr.ts:expandIPv6@13:14  calls: 7, threw: 0
  ipV6: "1::1", "::1", "2001:2::", "2001:0:0:db8::1", "::ffff:127.0.0.1", "::ffff:0.0.0.1"
  returns: ..., "0000:0000:0000:0000:0000:ffff:7f00:0001", "0000:0000:0000:0000:0000:0000:ffff:0001"
  observed: string
  declared: string
```

Use this when a function ran several times and you do not know which call
went wrong. Every call's argument and return sit beside each other.

It also puts what a value **was** beside what it was **declared** to be:

```text
  observed: {id: string, email: undefined (3 / 5 calls) | string (2 / 5 calls)}
  declared: {email: string, id: number}
  mismatch: id was string, declared number (5 of 5 calls)
  mismatch: email was absent, declared string (3 of 5 calls)
```

That output came from a suite that passes. `JSON.parse`, an `as` cast,
`process.env`, and an `any` parameter each let a value through without
checking it, and where the annotation stopped making a claim, only a run
can say what came through.

### flt — where inside this call did the value go wrong?

```text
call  locals: {"ipV6": "::ffff:0.0.0.1"}
line  14  new:     {"sections": ["", "", "ffff", "0.0.0.1"]}
line  16  changed: {"sections": {"old": ["", "", "ffff", "0.0.0.1"], "new": ["", "", "ffff", "1"]}}
```

Line 16 is the answer: an embedded IPv4 address collapsed into one group
instead of two.

Records arrive in completion order, not source order, because each is
written after its statement finishes. Read the `line` field. A loop keeps
its first and last iteration and folds the middle into a marker carrying
the count.

### exec — what would happen if the value were different?

```text
depug value: 100
depug result: fail (exit 1)
```

The expression runs in that line's own scope, so `total = 100` assigns the
function's own `total`. It can change what the test does and perform side
effects; the run's own outcome is reported beside the value for that
reason. Only the launcher arms it.

## A worked example

A truncation bug in one project's IPv6 handling, reproduced at the commit
before its fix, diagnosed in three commands and about four seconds:

1. The suite fails and prints the two lines.
2. `probe` lists seven calls; the seventh's return has `ffff` one group
   further along than the sixth's.
3. `flt` on `#7` shows `["", "", "ffff", "0.0.0.1"]` becoming
   `["", "", "ffff", "1"]` at line 16.

No step required reading the implementation to guess a value.

## What depug does not observe

These are absences the files declare, not facts about the program.

- A `suspend` with no `resume` after it: the awaited value rejected.
- `parameters_not_observed` in a probe: a destructured parameter has no
  single binding to read, so the value is unknown, not `undefined`.
- `skipped_iterations` in a trace: a loop's folded middle went unobserved.
- Events under `test.concurrent`: two concurrent tests in one worker share
  one current-test pointer, so `test` on a record can name the wrong one.
  The call ids stay correct.
- A trace carries no `suspend` or `resume` in v0.1.

## Cost

The always-on layer writes a file when a test fails and does nothing
otherwise.

A verb's instrumentation is a fixed cost of about 67 ms for each worker
process, dominated by loading `typescript`, plus about 46 ns for each
recorded event. That is a formula rather than a multiplier because a ratio
only describes the workload it was measured on: the same instrumentation
measured 1.12x on a workload with heavy function bodies and 2.04x on one
with four million trivial calls.

Instrumenting one project's whole suite ran 4961 tests to the same result
as without it, in 14.31 s against a 14 s baseline.

## Monorepos

A repository that splits its run into vitest projects works without extra
arguments, as long as `--include` points inside the project holding the
code:

```sh
depug frames --include packages/zod/src -- npx vitest run "packages/zod/src/.../array.test.ts" -t "^array min/max$"
```

vitest does not apply a root config's plugins to a project's own config, so
depug names that project inline instead, extending its config and keeping
its own directory as the root. Every relative path in that config resolves
where it did before.

## Test runners

The verbs read the command you hand them and set themselves up
accordingly:

```sh
depug frames -- npx vitest run "test/user.test.ts" -t "^parses a user$"
depug frames -- node --test test/user.test.ts
```

The instrumentation is the same either way, because depug rewrites
TypeScript before it executes rather than hooking a runner. vitest owns
that step through a vite plugin; Node owns it through
`module.registerHooks`, which the verbs reach with `NODE_OPTIONS`. The ids,
the coordinates, and the files are identical.

For node:test the reporter is a `--test-reporter`:

```sh
node --test --test-reporter=depug/node-test-reporter --test-reporter-destination=stdout \
     --test-reporter=spec --test-reporter-destination=stderr
```

One difference is worth knowing. `--test-name-pattern` matches a test's own
name and not the suites around it, and repeating the flag widens the
selection rather than narrowing it, so a rerun command there names the test
and any same-named test elsewhere in the same file. That is node:test's
CLI; the printed command says what it selects.

## Scope of version 0.1

vitest and node:test. jest comes later. The files are the interface, and
[the evidence schema](docs/evidence-schema.md) is the contract. [The design decisions](docs/design-decisions.md) explain each
choice with the measurement behind it.

The [bundled skill](skills/depug/SKILL.md) tells an agent how to read all
of this.

depug is the TypeScript sibling of bulldogger, a Ruby gem by the same
owner.

## License

MIT. See `LICENSE`.
