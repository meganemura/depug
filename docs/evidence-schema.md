# Evidence schema

The files are the interface. This document defines them, and it is the
contract depug keeps.

An agent reading these files should never need to guess a runtime value
from source. Where depug did not observe something, the file says so in a
named field rather than leaving a gap.

## Start here: the failure output

A failed test prints two lines. Both prefixes are stable.

```text
depug evidence: /abs/path/tmp/depug/run-20260902-2138-41207/001-parses-a-user.json
depug rerun: npx vitest run "test/user.test.ts" -t "parses a user" --sequence.seed=42
```

The first line names a file holding that one failure. The second line runs
that one test again, with the seed the suite used.

depug never runs the rerun command for you. Every verb below takes a
command like it and starts a new process only when you ask.

## Layout

```text
tmp/depug/
  latest -> run-20260902-2138-41207
  run-20260902-2138-41207/          one suite run's failures
    001-parses-a-user.json
    002-rejects-a-bad-id.json
    index.json
  frames-a7Kd2p/                    one `frames` invocation
    frames-41310.jsonl
  flt-Qm81xz/
    flt-41355.jsonl
```

`latest` points at the last finished suite run where the filesystem
supports a symlink.

A verb gets a directory of its own for each invocation, and each worker
process writes one file inside it. The default pool runs several workers,
so a verb reads every file in its directory rather than one path.
`DEPUG_OUTPUT_DIR` moves all of this somewhere else.

## Function id

Every verb that names one call uses this form:

```text
src/user.ts:parseUser@12:17#2
└─ path    └─ name  └ line
                       └ column
                              └─ call index inside the test window
```

The path is relative to the working directory the run started in. The line
and column are 1-based and describe the TypeScript source, not the
JavaScript the runner executed.

The name is the function's own name, the variable or property it is
assigned to, `constructor`, or `<anonymous>` when it has none of those. The
position is what makes the id unique: measured on one real codebase, 35% of
functions were anonymous, and a name-only id would have covered more than
one function 44.3% of the time.

`k` counts entries of that one function since the current test began. It
starts at 1.

An id is valid only for the code state it was recorded under. `flt` and
`exec` compare the code state of the index you aim them with against their
own run, and refuse on a mismatch, because an index built from edited code
points at lines the file no longer has.

## Fields every artifact carries

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | Integer | This document's version. v0.1 writes `1`. |
| `tool` | Object | `{"name": "depug", "version": "..."}`. |
| `code_state` | Object | Git commit and dirty-state marker. |
| `limits` | Object | The limits this artifact was written under. |

### Code state

| Field | Type | Meaning |
|---|---|---|
| `git_sha` | String or null | Commit at the start of the run. |
| `dirty_digest` | String or null | `clean`, or the SHA-256 of `git status --porcelain`. |

Both are null where git or the repository metadata is unavailable. A null
marker never blocks a verb; it downgrades the code-state check to a
warning, and the artifact says which.

### Limits

| Field | Default | Meaning |
|---|---:|---|
| `max_frames` | 20 | Stack frames kept in a snapshot. |
| `max_value_length` | 200 | Characters kept for one rendered value. |
| `max_elements` | 10 | Array or object entries kept inside a rendered value. |
| `max_samples` | 10 | Values serialized for one probe position. |

Where a limit removed something, the artifact records the count:
`frames_omitted`, `samples_omitted`, `original_length`.

## Failure snapshot (`snap`)

One JSON file for each failed test, written while the suite runs. This is
the only layer that is always on. It records failure text, and it does not
capture local variables; see `docs/design-decisions.md` for the
measurement behind that.

| Field | Type | Presence | Meaning |
|---|---|---|---|
| `kind` | String | always | `snap`. |
| `captured_at` | String | always | UTC, `YYYY-MM-DDTHH:MM:SSZ`. |
| `capture_mode` | String | always | `failure_text` in v0.1. |
| `test` | Object | always | Framework, name, file, line. |
| `error` | Object | always | The failure itself. |
| `frames` | Array | always | Stack frames in TypeScript coordinates. |
| `rerun_command` | String or null | always | The complete command for this one test. |
| `seed` | Integer or null | always | The runner's seed for this run. |
| `skill` | String | when available | Absolute path to the installed skill. |

`capture_mode` exists so that a later version can add a mode that carries
locals without changing this contract. A reader should branch on it rather
than assume.

### Test

| Field | Type |
|---|---|
| `framework` | String, `vitest` in v0.1 |
| `name` | String or null |
| `file` | String or null |
| `line` | Integer or null |

### Error

| Field | Type | Presence |
|---|---|---|
| `name` | String | always |
| `message` | String | always |
| `message_truncated` | Boolean | when true |
| `stack` | String | always, raw and unedited |

### Frames

Each frame is one entry of the parsed stack.

| Field | Type | Meaning |
|---|---|---|
| `index` | Integer | 0 is where the error was constructed. |
| `path` | String or null | Source path. |
| `line` | Integer or null | TypeScript line. |
| `column` | Integer or null | TypeScript column. |
| `name` | String or null | Function name as the runtime reported it. |
| `app` | Boolean | The path is inside the project and outside `node_modules`. |

`app` is the field to read first. A snapshot where no frame has `app: true`
outside the test file means the function that produced the wrong value had
already returned before the error was constructed. Its values are not in
this file and cannot be. Run `frames` and then `flt` to reach them.

### Run index

`index.json` lists the run's failures.

```json
{
  "schema_version": 1,
  "run_dir": "/abs/path/tmp/depug/run-20260902-2138-41207",
  "failures": [
    {
      "path": "001-parses-a-user.json",
      "test": {"framework": "vitest", "name": "parses a user", "file": "test/user.test.ts", "line": 14},
      "error": {"name": "AssertionError", "message": "expected undefined to be 'a@example.com'"}
    }
  ]
}
```

Each `path` is relative to `run_dir`.

## Call index (`frames`)

One JSON object per line. The collector writes a record as the test runs.

A `call` record names one function entry.

| Field | Type | Meaning |
|---|---|---|
| `type` | String | `call`. |
| `fid` | String | The function id, complete with `#k`. |
| `parent` | String or null | The id of the call that was executing when this one began. |
| `path`, `line`, `column` | | Declaration position, TypeScript coordinates. |
| `app` | Boolean | Inside the project, outside `node_modules`. |
| `test` | String or null | The test window this happened in. |

A `return` record names the id that finished, and carries `exit_kind`,
either `return` or `throw`.

A `suspend` record marks a call reaching an `await`. A `resume` record
marks the same call continuing past it. Both carry `fid` and the position
of the `await`.

`parent` is read from a stack of executing calls: entry pushes, return
pops. An `await` moves that boundary, so `suspend` pops the call and
`resume` pushes it back, and a call entered while another one is suspended
does not claim the suspended call as its caller. What this does not rebuild
is a resumed call's own ancestors, which left the stack when it suspended.
Read `parent` as "the call this one began inside", and read the index's
order for anything more.

**A suspend with no resume after it is not an error in the recording.**
When an awaited value rejects, the run leaves through the rejection before
the resume record fires. Read an unpaired suspend as "still pending, or
rejected", and read the call's own `return` record with `exit_kind:
"throw"` beside it. `for await (const x of it)` is a different syntax node
and produces no suspend or resume at all.

The final `envelope` record describes the run.

| Field | Type | Meaning |
|---|---|---|
| `schema_version`, `code_state`, `limits` | | As above. |
| `command` | Array of String | The child command, unedited. |
| `exit_status` | Integer or null | The child's exit status. |
| `seed` | Integer or null | Seed parsed from the command. |
| `outside_window_events` | Integer | Events seen before or after any test. |

## Determinism check (`preflight`)

`preflight` runs the command twice, in separate processes, and compares the
two sequences of application calls.

```text
depug preflight: deterministic (app calls: 214)
depug preflight indexes: /abs/path/frames-41310.jsonl /abs/path/frames-41315.jsonl
```

A divergence names where the two runs first differed and states that the
test is not eligible:

```text
depug preflight: first divergence at event 2
first:  (call, src/user.ts:parseUser@12:17#1)
second: (call, src/user.ts:fallback@20:17#1)
app calls: 2 and 2
This test is not eligible for depug re-execution.
```

Use `flt` and `exec` only after `deterministic`. Both address a call by its
index, and an index that moves between runs addresses a different call.

Measured on one real project, 80 tests sampled across 53 files each matched
their own second run, on both the call sequence and the fuller sequence
including suspend and resume.

## Frame lifetime trace (`flt`)

One JSON object per line, for one call named by its id.

The trace opens with a `call` record naming the call and holding every
visible local in full. At entry those locals are the parameters, so there
is no separate field for the arguments: one field, and no chance of two
that disagree.

| Field | Type | Meaning |
|---|---|---|
| `type` | String | `call`. |
| `fid` | String | The call this trace follows, with its `#k`. |
| `path`, `line`, `column` | | The function's declaration, TypeScript coordinates. |
| `locals` | Object | Every visible local at entry, rendered in full. |
| `test` | String or null | The test window the call happened in. |

Each later `line` record carries the source line and only what changed
since the previous record.

| Field | Type | Meaning |
|---|---|---|
| `line` | Integer | The statement that just finished. |
| `new` | Object | Locals that came into view, rendered. |
| `changed` | Object | Updated locals, each with `old` and `new`. |
| `out_of_scope` | Array of String | Locals that left a block. |

Apply `out_of_scope`, then `new`, then `changed`, in that order, to
reconstruct what was visible at any line.

**A `line` record is written after its statement finishes, so the records
are in completion order rather than source order.** A statement holding
other statements finishes last: an `if` on line 10 whose body is line 11
records 11, then 10. Read the `line` field, not the position in the file.

A `skipped_iterations` record replaces a loop's folded middle and carries
the `count` of iterations dropped. The trace keeps the first and the last.
Values inside the skipped iterations were not observed, and the marker
declares that.

A `throw` record carries the error name and rendered message. A `return`
record carries the rendered value.

v0.1 writes no `suspend` or `resume` record in a trace. The call index
carries those, and following an `await` inside one traced call is left to
a later version; a trace of an async function still records its statements
and its return.

Where the named call never happens, the trace holds no `call` record. The
collector writes a `target_summary` record instead, and the envelope
carries `observed_calls`, `target_index`, and `traced: false`, so the
reader can pick a `k` that exists.

## Statement evaluation (`exec`)

`exec` evaluates one statement inside one call, at one line, on one visit
to that line.

An `evaluation` record carries `fid`, `line`, `visit`, and either `value`
or the error's `name` and `message`.

The statement runs in the same scope as the surrounding code, so assigning
to a local changes that local. It can raise, change what the test does, and
perform side effects. Read the result file before you treat the changed
outcome as evidence.

Where the call happens but the line never reaches the requested visit, the
collector writes an `evaluation_summary` record with
`line_visits_observed`, `target_visit`, and `evaluated: false`.

## Targeted observation (`probe`)

One JSON file for one or more named functions.

```json
{
  "schema_version": 1,
  "kind": "probe",
  "targets": ["src/user.ts:parseUser@12:17"],
  "functions": {
    "src/user.ts:parseUser@12:17": {
      "calls": 5,
      "threw": 0,
      "parameters": [
        {
          "name": "raw",
          "observed": {"samples": 5, "kinds": {"string": 5}, "properties": {}},
          "declared": {"form": "primitive", "kinds": ["string"]},
          "mismatches": []
        }
      ],
      "returns": {
        "observed": {
          "samples": 5,
          "kinds": {"object": 5},
          "properties": {
            "id": {"kinds": {"string": 5}, "absent": 0},
            "email": {"kinds": {"string": 2}, "absent": 3}
          }
        },
        "declared": {
          "form": "object",
          "kinds": ["object"],
          "properties": [
            {"name": "email", "kinds": ["string"], "optional": false},
            {"name": "id", "kinds": ["number"], "optional": false}
          ]
        },
        "mismatches": [
          {"property": "email", "reason": "required-property-absent", "observed": "absent", "declared": "string", "occurrences": 3, "samples": 5},
          {"property": "id", "reason": "kind-not-declared", "observed": "string", "declared": "number", "occurrences": 5, "samples": 5}
        ]
      }
    }
  }
}
```

A target here omits `#k`: a probe observes every call to that function, not
one of them.

### Observed shape

| Field | Type | Meaning |
|---|---|---|
| `samples` | Integer | Values seen at this position. |
| `kinds` | Object | Runtime kind to count, over every sample. |
| `properties` | Object | For object values, each property's kinds and `absent` count. |

A kind is one of `string`, `number`, `boolean`, `bigint`, `symbol`, `null`,
`undefined`, `object`, `array`, `function`.

`absent` counts the samples where an object lacked that property. A
property seen in 2 of 5 calls reads as `{"kinds": {"string": 2}, "absent":
3}`, so the reader can tell "sometimes missing" from "always a string".

Observation is shallow. A nested object reports as the kind `object` and
nothing about its own properties.

### Declared type

The declared type is a projection, taken from the TypeScript compiler at
transform time. It carries property names, primitive kinds, whether a
property is optional, and whether the type admits null. It is not a
validator and does not recurse into nested objects.

### Mismatches

| `reason` | Meaning |
|---|---|
| `kind-not-declared` | A value held a kind the declaration does not allow. |
| `required-property-absent` | A property the declaration requires was missing. |
| `property-not-declared` | A value carried a property the declaration omits. |

An empty `mismatches` array means these two shallow views agreed. It does
not mean the value was correct.

Where the declared type is `any` or `unknown`, `mismatches` is always
empty, because those accept every runtime kind. That is the case worth
reading the `observed` column for: the declaration stopped making a claim,
and the run is the only thing that can say what came through. The same
holds at the boundaries where a value enters the program without a check:
`JSON.parse`, an `as` cast, and `process.env`.

## Rendered values

A value is stored as a JSON string.

Arrays and objects expand one level. A nested array renders as `[…]` and a
nested object as `{…}`. The renderer keeps `max_elements` entries and marks
the rest with `…`.

A value longer than `max_value_length` carries its own truncation fields:

```json
{"value": "a long rendered value…", "truncated": true, "original_length": 814}
```

Where rendering a value throws, the field records that rather than losing
the entry:

```json
{"value": "<render threw TypeError>"}
```

## Secrets

Captured values can hold secrets. depug checks a name against a pattern
before it renders the value behind it, so a matching value is never
rendered at all. Such an entry records no value:

```json
{"api_token": {"redacted": true, "reason": "name"}}
```

Object keys go through the same check while a value renders, and a matching
key renders as `"[REDACTED]"`.

`reason` names why an entry was withheld. v0.1 emits `"name"`.

The shape above is the part this document fixes. The default pattern list
arrives with the implementation that writes these files, and a project will
be able to replace it. Patterns should favour redaction where a name is
ambiguous: a pattern for `auth` also matching `author` withholds a value
that was safe, which costs less than rendering one that was not.

`flt`'s default pattern, matched case-insensitively against a name:

```text
pass(word|wd)?|secret|token|api[-_]?key|key|credential|auth|session|cookie
```

This withholds a name such as `password`, `apiKey`, `auth_token`, or
`sessionId`. It also withholds `authorName`, on the same "favour redaction"
principle above: `auth` matching `author` costs a value a reader has to ask
for again, not one that leaked.

## Reading these files with jq

The capture mode and the failing test:

```sh
jq '{capture_mode, test: .test.name}' evidence.json
```

Whether the snapshot can answer, or whether a rerun is needed:

```sh
jq '[.frames[] | select(.app == true and .path != .test.file)] | length' evidence.json
```

The application calls in an index:

```sh
jq -c 'select(.type == "call" and .app == true) | {fid, line}' frames-*.jsonl
```

A suspend with no resume after it:

```sh
jq -sc '[.[] | select(.type == "suspend" or .type == "resume")]
  | group_by(.fid) | map(select(length % 2 == 1) | .[0].fid)' frames-*.jsonl
```

Every place a value disagreed with its declared type:

```sh
jq '.functions | to_entries[] | {fn: .key,
  mismatches: [.value.returns.mismatches[], (.value.parameters[].mismatches[])]}' probe-*.json
```
