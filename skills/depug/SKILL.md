---
name: depug
description: Read depug evidence and run its verbs to measure runtime values in a TypeScript test run, instead of inferring them from source.
compatibility: Uses files written by depug 0.1. The query examples require jq.
license: MIT
---

# Use depug evidence

You are about to guess what a value was at runtime. Measure it instead.

Start from the failure output, not from the source. A failed test prints
two lines:

```text
depug evidence: /abs/path/tmp/depug/run-20260902-2138-41207/002-parses-a-user.json (the failing call is in these frames)
depug rerun: npx vitest run "test/user.test.ts" -t "parses a user" --sequence.seed=42
```

Open the evidence path first. The parenthetical tells you whether that
file can answer:

- **`(the failing call is in these frames)`** — the code that produced the
  wrong value is still on the stack. Read the file. You may be done.
- **`(the value's source already returned; rerun to reach it)`** — the
  function that produced the value returned before the error was built. Its
  values are not in this file and no deeper capture of that run would find
  them. Go to `frames`.
- **`(no frames were recorded for this failure)`** — read `error.stack` in
  the file and treat it as an ordinary stack.

depug never runs the rerun command for you. Every verb below starts a
process only when you invoke it.

## Read the snapshot

```sh
jq '{test: .test.name, error: .error.name, message: .error.message}' evidence.json
```

The field to read next is `app` on each frame. A frame with `app: true`
and a `path` other than the test file is the project's own code:

```sh
jq '[.frames[] | select(.app) | {path, line, name}]' evidence.json
```

`code_state` records the commit and whether the tree was dirty. If it does
not match your working tree, the line numbers in the file describe code you
no longer have.

## Check determinism before addressing a call

Every re-execution verb names a call by its index inside the test. An index
that moves between runs names a different call. Confirm it does not:

```sh
depug preflight -- npx vitest run "test/user.test.ts" -t "parses a user" --sequence.seed=42
```

```text
depug preflight: deterministic (app calls: 214)
```

A divergence names where the two runs first differed and says the test is
not eligible. That usually means the test depends on order-sensitive state
rather than on its seed. Stop there for that test.

## Index the calls

Put `frames` in front of the rerun command you were given:

```sh
depug frames -- npx vitest run "test/user.test.ts" -t "parses a user" --sequence.seed=42
```

It writes JSONL, one record per line:

```json
{"type": "call", "fid": "src/user.ts:parseUser@12:17#1", "parent": null, "path": "src/user.ts", "line": 12, "column": 17, "app": true, "test": "parses a user"}
```

A `fid` reads `path:name@line:column#k`. The position is part of the
identity, because a name does not tell two JavaScript functions apart. `k`
counts entries of that one function since the test began.

Find the call that produced the value you need:

```sh
jq -c 'select(.type == "call") | {fid, line}' frames-*.jsonl
```

`--include <path>` moves the application boundary; the default is `src`. A
run reporting `depug calls: 0` instrumented nothing, which usually means
the include path is wrong rather than that the test called nothing.

## Follow one call statement by statement

This is the verb that reaches a value. Take a `fid` from the index,
complete with its `#k`:

```sh
depug flt "src/utils/url.ts:splitPath@8:14#1" -- npx vitest run "test/url.test.ts" -t "splits a path"
```

The trace opens with a `call` record holding every visible local in full,
which at entry are the parameters. Each later `line` record carries only
what changed:

```text
call  locals: {"path": {"value": "\"/a/b\""}}
line   9  new: {"paths": {"value": "[\"\", \"a\", \"b\"]"}}
line  11  changed: {"paths": {"old": "[\"\", \"a\", \"b\"]", "new": "[\"a\", \"b\"]"}}
line  10  out_of_scope: []
return    "[\"a\", \"b\"]"
```

Line 11 is where the leading empty segment disappeared. That is the answer
`probe` cannot give, because `probe` reports the shape of a value and both
arrays are the kind `array`.

Two things to know while reading a trace:

- **Records are in completion order, not source order.** A statement that
  holds other statements finishes last, so an `if` on line 10 whose body is
  line 11 records 11, then 10. Read the `line` field.
- **A `skipped_iterations` record replaces a loop's folded middle.** The
  trace keeps the first and last iteration; `count` says how many were
  dropped, and those values were not observed.

Reconstruct the visible locals at any point by applying `out_of_scope`,
then `new`, then `changed`, in that order.

Pass `--index <path>` to refuse the run if the index you took the `fid`
from was built from different code than the working tree holds now.

## Compare a value against its declared type

Use `probe` when one function defines the behaviour you are chasing, and
when you suspect a value does not match its annotation:

```sh
depug probe "src/user.ts:parseUser@12:17" -- npx vitest run "test/user.test.ts" -t "parses a user"
```

```text
src/user.ts:parseUser@12:17  calls: 5, threw: 0
  observed: {id: string, email: undefined (3 / 5 calls) | string (2 / 5 calls)}
  declared: {email: string, id: number}
  mismatch: id was string, declared number (5 of 5 calls)
  mismatch: email was absent, declared string (3 of 5 calls)
```

A probe target omits `#k`: it observes every call, not one of them.

This is the verb to reach for at the four boundaries where a type stops
being checked: `JSON.parse`, an `as` cast, `process.env`, and an `any`
parameter. Where the declared type is `any` or `unknown` the comparison
reports nothing, because those accept every runtime kind — read the
`observed` column on its own there.

An empty `mismatches` means the two shallow views agreed. It does not mean
the value was correct.

## Read what depug did not observe

Treat these as absences the files declare, not as facts about the program.

- **A `suspend` with no `resume` after it.** The awaited value rejected, so
  the resume record never ran. Read the call's own `return` record with
  `exit_kind: "throw"` beside it.
- **`parameters_not_observed` in a probe.** A destructured parameter has no
  single binding to read. The value is unknown, not `undefined`.
- **`targets_not_found` in a probe.** The id matched no function in the
  source. Check it against a `frames` index built from the same commit.
- **Events under `test.concurrent`.** Two concurrent tests in one worker
  share one current-test pointer, so `test` on a record can name the wrong
  one. The call ids stay correct.
- **`for await (const x of it)`** produces no suspend or resume.
- **An `flt` trace carries no suspend or resume in v0.1.** Following an
  `await` inside a traced call is left to a later version; the trace still
  records the call's statements and its return.

## When not to use a verb

A verb runs the test again in a new process. A test that writes a file,
calls an external service, or changes a shared fixture performs that effect
a second time. `preflight` performs it twice.

`docs/evidence-schema.md` defines every field. `docs/design-decisions.md`
explains why each one is shaped that way, with the measurement behind it.
